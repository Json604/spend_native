import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActivityIndicator, Alert, AppState, DeviceEventEmitter, View } from "react-native";
import { SpendContextType } from "../types/types";
import {
  createSpendRepository,
  createSeedSpendDomainState,
  createInMemorySpendStorageAdapter,
  mergeSpendDomainStates,
} from "./spendRepository";
import { selectSpendContextValue } from "./selectors";
import { createInMemoryBudgetStore, monthKeyFromDate } from "./budgetStorage";
import { daysRemainingInMonth } from "./budgetSelectors";
import { fetchState, saveState, fetchBudgets, saveBudgets } from "../../../api/spendApi";
import { ensureAnonymousAuth } from "../../../api/supabaseClient";
import {
  readCachedState,
  writeCachedState,
  readCachedBudgets,
  writeCachedBudgets,
} from "../../../api/localCache";
import { pushWidgetSnapshot } from "../services/widgetBridge";
import {
  convertSmsCandidatesToTransactions,
  getSmsPermissionState,
  loadSmsIngestionSnapshot,
  requestSmsReadPermission,
  startOfTodayMillis,
} from "../services/smsIngestion";
import { consumePendingSmsRefreshFlag } from "../services/smsNativeModule";
import type {
  CategoryBudgetMap,
  MonthlyBudget,
  SpendCategoryId,
  SpendCategoryOption,
  SpendCategoryPreview,
  SpendPlanType,
  SpendRepository,
} from "../types/types";
import { BudgetStore } from "./budgetStorage";

type Stores = { repository: SpendRepository; budgetStore: BudgetStore };

function makeStores(loaded?: Awaited<ReturnType<typeof fetchState>>): Stores {
  const state = loaded ?? createSeedSpendDomainState();
  return {
    repository: createSpendRepository(createInMemorySpendStorageAdapter(state)),
    budgetStore: createInMemoryBudgetStore(),
  };
}

const SpendContext = createContext<SpendContextType | undefined>(undefined);

export function SpendProvider({ children }: { children: ReactNode }) {
  const [stores, setStores] = useState<Stores>(() => makeStores());
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const storesRef = useRef(stores);
  storesRef.current = stores;

  const refreshContext = useCallback(() => setVersion((v) => v + 1), []);

  const lastErrorAtRef = useRef(0);
  const reportPersistError = useCallback(
    (label: string) => (e: unknown) => {
      console.warn(`${label} error`, e);
      const now = Date.now();
      if (now - lastErrorAtRef.current < 10_000) return;
      lastErrorAtRef.current = now;
      Alert.alert(
        "Sync failed",
        `Couldn't push to Supabase (${label}). Local cache is fine; data will resync next time.\n\n${e instanceof Error ? e.message : String(e)}`,
      );
    },
    [],
  );

  const persistStateNow = useCallback(() => {
    const state = storesRef.current.repository.getState();
    writeCachedState(state);
    saveState(state).catch(reportPersistError("saveState"));
  }, [reportPersistError]);

  const persistBudgetsNow = useCallback(() => {
    const budgets = storesRef.current.budgetStore.getAll();
    writeCachedBudgets(budgets);
    saveBudgets(budgets).catch(reportPersistError("saveBudgets"));
  }, [reportPersistError]);

  // Cache-first load: read AsyncStorage (instant render), then refresh from
  // Supabase in the background. The user sees their data immediately even on
  // a cold start with no network.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1. Hydrate from local cache — fast path, no network
      try {
        const [cachedState, cachedBudgets] = await Promise.all([
          readCachedState(),
          readCachedBudgets(),
        ]);
        if (cancelled) return;
        if (cachedState || cachedBudgets) {
          const next = makeStores(cachedState ?? undefined);
          if (cachedBudgets) next.budgetStore.replaceAll(cachedBudgets);
          setStores(next);
        }
      } catch (e) {
        console.warn("cache hydrate failed", e);
      } finally {
        if (!cancelled) {
          setLoading(false);
          refreshContext();
        }
      }

      // 2. Background sync from Supabase. Merge instead of replacing the cache:
      // SMS ingestion can add a local row while this request is still in flight.
      // Auth must happen first so RLS lets the read/write through.
      try {
        await ensureAnonymousAuth();
        const [remoteState, remoteBudgets] = await Promise.all([fetchState(), fetchBudgets()]);
        if (cancelled) return;
        if (remoteState) {
          const localState = storesRef.current.repository.getState();
          const mergedState = mergeSpendDomainStates(remoteState, localState);
          const next = makeStores(mergedState);
          next.budgetStore.replaceAll(remoteBudgets);
          setStores(next);
          writeCachedState(mergedState);
          writeCachedBudgets(remoteBudgets);

          if (mergedState.transactions.length !== remoteState.transactions.length) {
            await saveState(mergedState).catch((e) => console.warn("merge saveState failed", e));
          }
        } else {
          // Supabase row is empty for this user. If we have a local cache with
          // real data, push it up so it's persisted under the new user_id.
          // This is the recovery path after the table drop / fresh anonymous user.
          const localState = storesRef.current.repository.getState();
          const localBudgets = storesRef.current.budgetStore.getAll();
          if (localState.transactions.length > 0) {
            await saveState(localState).catch((e) => console.warn("bootstrap saveState failed", e));
          }
          if (
            Object.keys(remoteBudgets).length === 0 &&
            Object.keys(localBudgets).length > 0
          ) {
            await saveBudgets(localBudgets).catch((e) => console.warn("bootstrap saveBudgets failed", e));
          }
        }
      } catch (e) {
        console.warn("supabase background sync failed — using cache", e);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { repository, budgetStore } = stores;

  const assignReviewCategory = useCallback(
    async (transactionId: string, categoryLabel: string, opts?: { parentId?: SpendCategoryId }) => {
      const trimmed = categoryLabel.trim();
      if (!trimmed) throw new Error("Category label is required.");
      const category = storesRef.current.repository.ensureCategory(trimmed, opts);
      storesRef.current.repository.assignCategoryToTransaction(transactionId, category.id, category.label);
      refreshContext();
      persistStateNow();
    },
    [refreshContext, persistStateNow],
  );

  const ignoreTransaction = useCallback(
    async (transactionId: string) => {
      storesRef.current.repository.ignoreTransaction(transactionId);
      refreshContext();
      persistStateNow();
    },
    [refreshContext, persistStateNow],
  );

  const addManualTransaction = useCallback(
    async (input: {
      amountMinor: number;
      merchantName: string;
      occurredAt: string;
      description?: string;
      categoryLabel?: string;
      categoryParentId?: SpendCategoryId;
      planType?: SpendPlanType;
    }) => {
      const id = `manual:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      storesRef.current.repository.upsertTransactions([{
        id,
        source: "manual",
        occurredAt: input.occurredAt,
        amountMinor: input.amountMinor,
        currencyCode: "INR",
        merchantName: input.merchantName,
        description: input.description ?? input.merchantName,
        channel: "unknown",
        direction: "debit",
        status: "posted",
        planType: input.planType ?? "planned",
      }]);
      if (input.categoryLabel?.trim()) {
        const category = storesRef.current.repository.ensureCategory(
          input.categoryLabel.trim(),
          input.categoryParentId ? { parentId: input.categoryParentId } : undefined,
        );
        storesRef.current.repository.assignCategoryToTransaction(id, category.id, category.label);
      }
      refreshContext();
      persistStateNow();
    },
    [refreshContext, persistStateNow],
  );

  const setTransactionPlanType = useCallback(
    async (transactionId: string, planType: SpendPlanType) => {
      storesRef.current.repository.setTransactionPlanType(transactionId, planType);
      refreshContext();
      persistStateNow();
    },
    [refreshContext, persistStateNow],
  );

  const deleteTransaction = useCallback(
    async (transactionId: string) => {
      storesRef.current.repository.deleteTransaction(transactionId);
      refreshContext();
      persistStateNow();
    },
    [refreshContext, persistStateNow],
  );

  const setMonthlyBudget = useCallback(
    async (monthKey: string, categoryBudgets: CategoryBudgetMap) => {
      storesRef.current.budgetStore.setBudget(monthKey, categoryBudgets);
      refreshContext();
      persistBudgetsNow();
    },
    [refreshContext, persistBudgetsNow],
  );

  const clearMonthlyBudget = useCallback(
    async (monthKey: string) => {
      storesRef.current.budgetStore.clearBudget(monthKey);
      refreshContext();
      persistBudgetsNow();
    },
    [refreshContext, persistBudgetsNow],
  );

  const addCategory = useCallback(
    async (label: string, opts?: { parentId?: SpendCategoryId }): Promise<SpendCategoryOption> => {
      const trimmed = label.trim();
      if (!trimmed) throw new Error("Category label is required.");
      const category = storesRef.current.repository.ensureCategory(trimmed, opts);
      refreshContext();
      persistStateNow();
      return { id: category.id, label: category.label, tint: category.tint, isCustom: !category.isSystem, parentId: category.parentId };
    },
    [refreshContext, persistStateNow],
  );

  const renameCategory = useCallback(
    async (categoryId: SpendCategoryId, newLabel: string) => {
      storesRef.current.repository.renameCategory(categoryId, newLabel);
      refreshContext();
      persistStateNow();
    },
    [refreshContext, persistStateNow],
  );

  const deleteCategory = useCallback(
    async (categoryId: SpendCategoryId) => {
      storesRef.current.repository.deleteCategory(categoryId);
      // Also strip it from the current month's budget map. If that empties the
      // map entirely, clear the whole month entry so we don't leave a zero-row.
      const monthKey = monthKeyFromDate(new Date());
      const budget = storesRef.current.budgetStore.getBudget(monthKey);
      if (budget && categoryId in budget.categoryBudgets) {
        const next = { ...budget.categoryBudgets };
        delete next[categoryId];
        if (Object.keys(next).length === 0) {
          storesRef.current.budgetStore.clearBudget(monthKey);
        } else {
          storesRef.current.budgetStore.setBudget(monthKey, next);
        }
      }
      refreshContext();
      persistStateNow();
      persistBudgetsNow();
    },
    [refreshContext, persistStateNow, persistBudgetsNow],
  );

  const isRefreshingSmsRef = useRef(false);

  const refreshSmsInboxToday = useCallback(async (detail: string) => {
    if (isRefreshingSmsRef.current) return;
    isRefreshingSmsRef.current = true;
    storesRef.current.repository.updateSyncState("sms", { status: "syncing", detail });
    refreshContext();

    try {
      const snapshot = await loadSmsIngestionSnapshot({ sinceMillis: startOfTodayMillis() });
      const transactions = convertSmsCandidatesToTransactions(snapshot.parsedCandidates);

      if (transactions.length > 0) {
        storesRef.current.repository.upsertTransactions(transactions);
      }
      storesRef.current.repository.updateSyncState("sms", {
        status: snapshot.permission === "granted" ? "ready" : "needs_permission",
        detail:
          transactions.length > 0
            ? `Today: ${transactions.length} SMS transaction${transactions.length === 1 ? "" : "s"}.`
            : "No transaction SMS found for today yet.",
        lastSyncedAt: new Date().toISOString(),
      });
      refreshContext();
      // Persist new SMS-sourced rows to Supabase + AsyncStorage + widget cache.
      if (transactions.length > 0) persistStateNow();
    } catch (error) {
      storesRef.current.repository.updateSyncState("sms", {
        status: "error",
        detail:
          error instanceof Error
            ? error.message
            : "SMS sync failed while reading today's inbox.",
      });
      refreshContext();
    } finally {
      isRefreshingSmsRef.current = false;
    }
  }, [refreshContext, persistStateNow]);

  const refreshSmsInbox = useCallback(async () => {
    return refreshSmsInboxToday("Scanning today's SMS for transaction alerts.");
  }, [refreshSmsInboxToday]);

  const grantSmsAccess = useCallback(async () => {
    const permission = await requestSmsReadPermission();
    storesRef.current.repository.updateSyncState("sms", {
      status: permission === "granted" ? "ready" : "needs_permission",
      detail:
        permission === "granted"
          ? "SMS access granted. Ready to scan your full Android inbox."
          : "SMS access is still required for transaction ingestion.",
    });
    refreshContext();
    if (permission === "granted") {
      await refreshSmsInbox();
    }
  }, [refreshContext, refreshSmsInbox]);

  // Auto-request permission on first mount, listen for incoming-SMS broadcasts,
  // and re-pull today's inbox on app foreground (handles day rollover + missed SMS).
  useEffect(() => {
    if (loading) return;
    (async () => {
      const permission = await getSmsPermissionState();
      if (permission === "granted") {
        await refreshSmsInboxToday("Scanning today's SMS for transaction alerts.").catch(() => undefined);
      } else if (permission === "denied") {
        const next = await requestSmsReadPermission();
        storesRef.current.repository.updateSyncState("sms", {
          status: next === "granted" ? "ready" : "needs_permission",
          detail:
            next === "granted"
              ? "SMS access granted. Scanning today's inbox."
              : "SMS access is required to track spend automatically.",
        });
        refreshContext();
        if (next === "granted") {
          await refreshSmsInboxToday("Scanning today's SMS for transaction alerts.").catch(() => undefined);
        }
      }
    })();

    const smsEventSubscription = DeviceEventEmitter.addListener(
      "spendSmsTransactionReceived",
      () => {
        refreshSmsInboxToday("New SMS received. Updating today's spend.").catch(() => undefined);
      },
    );
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      refreshSmsInboxToday("Refreshing today's SMS.").catch(() => undefined);
      consumePendingSmsRefreshFlag().catch(() => undefined);
    });

    return () => {
      smsEventSubscription.remove();
      appStateSubscription.remove();
    };
  }, [loading, refreshSmsInboxToday, refreshContext]);

  const value = useMemo((): SpendContextType => {
    const baseValue = selectSpendContextValue(repository);
    const now = new Date();
    const monthKey = monthKeyFromDate(now);
    const currentMonthBudget: MonthlyBudget | null = budgetStore.getBudget(monthKey);

    const monthTransactions = repository.getState().transactions.filter(
      (t) => t.direction === "debit" && t.status !== "ignored" && monthKeyFromDate(new Date(t.occurredAt)) === monthKey,
    );
    // Only PLANNED spend counts against the monthly budget. Unplanned (gifts,
    // helping someone, anything from savings) is excluded from budget tracking
    // but still appears in transaction lists and daily bars.
    const plannedMonthTransactions = monthTransactions.filter(
      (t) => (t.planType ?? "planned") === "planned",
    );
    const monthSpentMinor = plannedMonthTransactions.reduce((sum, t) => sum + t.amountMinor, 0);

    const spentById = new Map<string, number>();
    const labelById = new Map<string, string>();
    const tintById = new Map<string, string>();
    const parentById = new Map<string, string | undefined>();

    for (const cat of repository.getState().categories) {
      labelById.set(cat.id, cat.label);
      tintById.set(cat.id, cat.tint);
      parentById.set(cat.id, cat.parentId);
    }
    for (const t of plannedMonthTransactions) {
      const id = t.categoryId ?? "uncategorized";
      spentById.set(id, (spentById.get(id) ?? 0) + t.amountMinor);
      if (t.categoryLabel && !labelById.has(id)) labelById.set(id, t.categoryLabel);
    }

    const fmt = (minor: number) => {
      const n = minor / 100;
      return `Rs${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2)}`;
    };

    const catBudgets = currentMonthBudget?.categoryBudgets ?? {};
    const previewIds = new Set([...Object.keys(catBudgets), ...spentById.keys()]);
    previewIds.delete("uncategorized");
    previewIds.delete("needs-review");

    const childrenByParent = new Map<string, string[]>();
    for (const id of previewIds) {
      const p = parentById.get(id);
      if (p) { const l = childrenByParent.get(p) ?? []; l.push(id); childrenByParent.set(p, l); }
    }
    const rootIds = Array.from(previewIds).filter((id) => { const p = parentById.get(id); return !p || !previewIds.has(p); });

    const enrichedCategories: SpendCategoryPreview[] = [];
    for (const rootId of rootIds.sort((a, b) => {
      const ha = (catBudgets[a] ?? 0) > 0 ? 1 : 0, hb = (catBudgets[b] ?? 0) > 0 ? 1 : 0;
      if (ha !== hb) return hb - ha;
      return (spentById.get(b) ?? 0) - (spentById.get(a) ?? 0) || (labelById.get(a) ?? a).localeCompare(labelById.get(b) ?? b);
    })) {
      const kids = childrenByParent.get(rootId) ?? [];
      let rs = spentById.get(rootId) ?? 0, rb = catBudgets[rootId] ?? 0;
      for (const k of kids) { rs += spentById.get(k) ?? 0; rb += catBudgets[k] ?? 0; }
      const tint = tintById.get(rootId) ?? "#9C8B5C";
      enrichedCategories.push({ id: rootId as SpendCategoryId, label: labelById.get(rootId) ?? rootId, tint, amountLabel: fmt(rs), budgetAmountLabel: rb > 0 ? fmt(rb) : undefined, spentMinor: rs, budgetMinor: rb > 0 ? rb : undefined, pct: rb > 0 ? rs / rb : 0, depth: 0 });
      for (const k of kids.sort((a, b) => (labelById.get(a) ?? a).localeCompare(labelById.get(b) ?? b))) {
        const ks = spentById.get(k) ?? 0, kb = catBudgets[k] ?? 0;
        enrichedCategories.push({ id: k as SpendCategoryId, label: labelById.get(k) ?? k, tint: tintById.get(k) ?? tint, amountLabel: fmt(ks), budgetAmountLabel: kb > 0 ? fmt(kb) : undefined, spentMinor: ks, budgetMinor: kb > 0 ? kb : undefined, pct: kb > 0 ? ks / kb : 0, depth: 1 });
      }
    }

    return {
      ...baseValue,
      categories: enrichedCategories,
      currentMonthBudget,
      widgetSnapshot: { ...baseValue.widgetSnapshot, monthBudgetMinor: currentMonthBudget?.amountMinor ?? null, monthSpentMinor, daysRemainingInMonth: daysRemainingInMonth(now) },
      actions: { grantSmsAccess, refreshSmsInbox, connectGmailInbox: async () => {}, refreshGmailInbox: async () => {}, assignReviewCategory, ignoreTransaction, addManualTransaction, setTransactionPlanType, deleteTransaction, setMonthlyBudget, clearMonthlyBudget, addCategory, renameCategory, deleteCategory },
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, stores, assignReviewCategory, ignoreTransaction, addManualTransaction, setTransactionPlanType, deleteTransaction, setMonthlyBudget, clearMonthlyBudget, addCategory, renameCategory, deleteCategory, grantSmsAccess, refreshSmsInbox]);

  // Push the latest snapshot to the Android widget's local cache on every change.
  // Widget reads only from SharedPreferences — never hits Supabase.
  useEffect(() => {
    if (loading) return;
    pushWidgetSnapshot(value.widgetSnapshot);
  }, [loading, value.widgetSnapshot]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: "#070709", alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color="#FFD27A" />
      </View>
    );
  }

  return <SpendContext.Provider value={value}>{children}</SpendContext.Provider>;
}

export function useSpend(): SpendContextType {
  const ctx = useContext(SpendContext);
  if (!ctx) throw new Error("useSpend must be used within SpendProvider");
  return ctx;
}
