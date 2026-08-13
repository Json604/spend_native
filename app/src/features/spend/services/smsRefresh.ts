import { useCallback, useEffect, useRef } from "react";
import { AppState, type AppStateStatus, DeviceEventEmitter } from "react-native";

import type { SpendSourceKind, SpendSyncState } from "../types/types";
import {
  getSmsPermissionState,
  requestSmsReadPermission,
  startOfTodayMillis,
} from "./smsIngestion";
import { backfillSpendSmsInboxSince, consumePendingSmsRefreshFlag } from "./smsNativeModule";

type UpdateSyncState = (source: SpendSourceKind, patch: Partial<SpendSyncState>) => void;

type SmsInboxRefreshOptions = {
  loading: boolean;
  selectedMonth: string;
  updateSyncState: UpdateSyncState;
  refreshAfterWrite: () => Promise<void>;
  reload: (monthKey?: string) => Promise<void>;
};

export function useSmsInboxRefresh({
  loading,
  selectedMonth,
  updateSyncState,
  refreshAfterWrite,
  reload,
}: SmsInboxRefreshOptions) {
  const isRefreshingSms = useRef(false);

  const refreshSmsInboxToday = useCallback(async (detail: string) => {
    if (isRefreshingSms.current) return;
    isRefreshingSms.current = true;
    updateSyncState("sms", { status: "syncing", detail });
    try {
      const permission = await getSmsPermissionState();
      // An ingest attempt reports what it INGESTED. Whether permission is
      // granted is the permission watcher's business — letting this path also
      // write "needs_permission" is what left the banner up after the user had
      // already said yes.
      if (permission === "granted") {
        const result = await backfillSpendSmsInboxSince(startOfTodayMillis());
        updateSyncState("sms", {
          status: "ready",
          detail: result.parsed ? `Today: ${result.parsed} SMS transactions.` : "No transaction SMS found for today yet.",
          lastSyncedAt: new Date(Date.now()).toISOString(),
        });
      }
      await refreshAfterWrite();
    } catch (error) {
      updateSyncState("sms", { status: "error", detail: error instanceof Error ? error.message : "SMS sync failed." });
    } finally {
      isRefreshingSms.current = false;
    }
  }, [refreshAfterWrite, updateSyncState]);

  const refreshSmsInbox = useCallback(
    () => refreshSmsInboxToday("Scanning today's SMS for transaction alerts."),
    [refreshSmsInboxToday],
  );

  const grantSmsAccess = useCallback(async () => {
    const permission = await requestSmsReadPermission();
    updateSyncState("sms", {
      status: permission === "granted" ? "ready" : "needs_permission",
      detail: permission === "granted" ? "SMS access granted." : "SMS access is still required.",
    });
    if (permission === "granted") await refreshSmsInbox();
  }, [refreshSmsInbox, updateSyncState]);

  /**
   * The permission banner follows the ACTUAL permission, re-checked whenever
   * the app comes forward.
   *
   * It used to be written only as a side effect of an ingest attempt, so a
   * check that ran while the system dialog was still on screen recorded
   * "denied" — and nothing ever looked again. The user granted access and the
   * banner kept asking for it.
   */
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    const syncPermissionState = async () => {
      const permission = await getSmsPermissionState();
      if (cancelled) return;
      if (permission === "unavailable") return;
      updateSyncState("sms", {
        status: permission === "granted" ? "ready" : "needs_permission",
        ...(permission === "granted" ? {} : { detail: "SMS inbox and live-message access are required to capture bank alerts automatically." }),
      });
    };
    void syncPermissionState();
    const subscription = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") void syncPermissionState();
    });
    return () => { cancelled = true; subscription.remove(); };
  }, [loading, updateSyncState]);

  useEffect(() => {
    if (loading) return;
    getSmsPermissionState().then((permission) => {
      if (permission === "granted") refreshSmsInboxToday("Scanning today's SMS for transaction alerts.").catch(() => undefined);
    });
    // Native ingestion has already committed this SMS before emitting the event.
    // Re-scanning the inbox here used to create the same payment under the JS
    // inbox ID as well, leaving two identical rows in Needs Review.
    const smsSubscription = DeviceEventEmitter.addListener("spendSmsTransactionReceived", () => {
      reload(selectedMonth).catch(() => undefined);
    });
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refreshSmsInboxToday("Refreshing today's SMS.").catch(() => undefined);
        consumePendingSmsRefreshFlag().catch(() => undefined);
      }
    });
    return () => { smsSubscription.remove(); appStateSubscription.remove(); };
  }, [loading, refreshSmsInboxToday, reload, selectedMonth]);

  return { refreshSmsInboxToday, refreshSmsInbox, grantSmsAccess };
}
