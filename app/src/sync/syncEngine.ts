import { AppState, type AppStateStatus } from "react-native";
import { syncClient } from "./syncClient";

/**
 * Sync is infrastructure, not a feature. The user should never tap a button to
 * make their data safe — a backup you have to remember is a backup that fails
 * exactly when it matters.
 *
 * The server is the source of truth. Local SQLite is a cache and a write-ahead
 * buffer: an SMS arriving at 2am with no network still has to land somewhere,
 * and that is the only reason local storage exists. Everything written locally
 * is replicated upward automatically, and the server wins every conflict.
 *
 * This runs sync on the four events that actually mean "state may have moved":
 * start-up, returning to the foreground, any local mutation, and a periodic
 * heartbeat to catch a device that has been sitting open.
 */

const HEARTBEAT_MS = 3 * 60 * 1000;
const NUDGE_DEBOUNCE_MS = 1500;
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

type Listener = (state: SyncEngineState) => void;

export type SyncEngineState = {
  running: boolean;
  lastSyncedAt: number | null;
  lastError: string | null;
  pending: number;
};

class SyncEngine {
  private started = false;
  private ownerId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private appStateSub: { remove: () => void } | null = null;
  private backoff = MIN_BACKOFF_MS;
  private reconciledOwners = new Set<string>();
  private listeners = new Set<Listener>();
  private state: SyncEngineState = { running: false, lastSyncedAt: null, lastError: null, pending: 0 };

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<SyncEngineState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.state));
  }

  /** Called once the device knows who it belongs to. Safe to call repeatedly. */
  start(ownerId: string) {
    this.ownerId = ownerId;
    if (this.started) {
      void this.runNow("owner-change");
      return;
    }
    this.started = true;

    this.appStateSub = AppState.addEventListener("change", (next: AppStateStatus) => {
      // Coming back to the foreground is the single most likely moment for the
      // server to hold something this device has not seen.
      if (next === "active") void this.runNow("foreground");
    });

    void this.runNow("startup");
    this.scheduleHeartbeat();
  }

  stop() {
    this.started = false;
    this.ownerId = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.timer = null;
    this.nudgeTimer = null;
    this.reconciledOwners.clear();
    this.emit({ running: false, lastError: null });
  }

  /**
   * Signal that local data changed. Debounced, because a burst of edits should
   * produce one sync rather than one per keystroke.
   */
  nudge() {
    if (!this.started) return;
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => void this.runNow("local-change"), NUDGE_DEBOUNCE_MS);
  }

  /**
   * The first time a device syncs for an owner, push the COMPLETE local state.
   * The outbox only holds changes since the last drain, so without this a
   * device that missed a sync — or was migrated into — can never catch the
   * server up, and the backup is silently partial.
   *
   * Returns the failure reason rather than handling it: the caller folds this
   * into the ordinary sync result, so a half-finished backup shows up as a sync
   * error instead of hiding behind a green "Backed up".
   *
   * The owner is marked reconciled only on success. An earlier version marked it
   * before the attempt and cleared the mark in `catch` — but `backUpEverything`
   * REPORTS failure instead of throwing, so the catch never ran and the owner
   * stayed marked as reconciled forever. One transient error and the device
   * never attempted a full backup again.
   */
  private async reconcileOnce(): Promise<string | null> {
    const ownerId = this.ownerId;
    if (!ownerId || this.reconciledOwners.has(ownerId)) return null;
    try {
      const report = await syncClient.backUpEverything();
      if (report.error) return `Backup incomplete: ${report.error}`;
      this.reconciledOwners.add(ownerId);
      return null;
    } catch (error) {
      return `Backup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private scheduleHeartbeat(delay = HEARTBEAT_MS) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.runNow("heartbeat");
    }, delay);
  }

  private async runNow(reason: string) {
    if (!this.started) return;
    this.emit({ running: true });
    try {
      // A full backup that has not landed yet is a sync failure, not a separate
      // concern the user never hears about.
      const reconcileError = await this.reconcileOnce();
      const report = await syncClient.sync();
      const pending = await syncClient.pendingOutboxCount();
      const failure = reconcileError ?? report.error;
      if (failure) {
        // Treat a failure as "retry sooner than the heartbeat, but backing off"
        // so a flaky network does not hammer the server.
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
        this.emit({ running: false, lastError: failure, pending });
        this.scheduleHeartbeat(this.backoff);
        return;
      }
      this.backoff = MIN_BACKOFF_MS;
      this.emit({ running: false, lastSyncedAt: Date.now(), lastError: null, pending });
      this.scheduleHeartbeat();
    } catch (error) {
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      this.emit({
        running: false,
        lastError: error instanceof Error ? error.message : String(error),
      });
      this.scheduleHeartbeat(this.backoff);
    }
  }
}

export const syncEngine = new SyncEngine();
