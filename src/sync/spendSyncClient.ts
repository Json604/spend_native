import { deterministicOpId, transactionToBackupOps } from "./backupOps.ts";
import { nextPullCursor, normalizeRemoteCommand, parsePayload, wireOperationId, type SyncOperation } from "./wireCommands.ts";

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 8;

type OutboxRow = {
  id: string;
  device_id: string;
  op: string;
  table_name: string;
  row_id: string;
  payload: string;
  attempt_count: number;
  last_error: string | null;
  dead_lettered: number;
  created_at: number;
};

type PushResponse = { applied?: unknown[]; conflicts?: unknown[] };
type PullResponse = { ops?: SyncOperation[]; cursor?: string | number };

export type SyncReport = {
  pushed: number;
  pulled: number;
  deadLetterCount: number;
  error?: string;
};

export type SyncNative = {
  acknowledgeOutbox(idsJson: string): Promise<number>;
  recordOutboxFailure(id: string, error: string, maxAttempts: number): Promise<number>;
  recoverDeadLettersOnce(migrationKey: string): Promise<number>;
  applyPulledOps(commandsJson: string, cursor: string, userId: string): Promise<string>;
  retryRejectedOps(): Promise<string>;
  getDeadLetterCount(): Promise<number>;
};

export type SyncDatabase = {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
};

export type SyncClientDeps = {
  nativeSync: SyncNative;
  nativeCoordinator: SyncDatabase;
  authenticatedFetch: (path: string, init?: RequestInit) => Promise<Response>;
  secureDeviceId: () => Promise<string>;
};

export class SpendSyncClient {
  private inFlight: Promise<SyncReport> | null = null;
  private readonly deps: SyncClientDeps;

  constructor(deps: SyncClientDeps) {
    this.deps = deps;
  }

  sync(): Promise<SyncReport> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async deadLetterCount(): Promise<number> {
    return this.deps.nativeSync.getDeadLetterCount();
  }

  async pendingOutboxCount(): Promise<number> {
    const rows = await this.deps.nativeCoordinator.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM outbox WHERE dead_lettered = 0",
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async run(): Promise<SyncReport> {
    const sessionRows = await this.deps.nativeCoordinator.query<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = 'owner_id'",
    );
    const userId = sessionRows[0]?.value;
    if (!userId) return { pushed: 0, pulled: 0, deadLetterCount: await this.deadLetterCount() };

    let pushed = 0;
    let pulled = 0;
    let lastError: string | undefined;
    try {
      await this.deps.nativeSync.recoverDeadLettersOnce("wire_uuid_recovery_v1");
      pushed = await this.drainOutbox(await this.deps.secureDeviceId());
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    try {
      pulled = await this.pull(userId);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    return {
      pushed,
      pulled,
      deadLetterCount: await this.deadLetterCount(),
      ...(lastError ? { error: lastError } : {}),
    };
  }

  /**
   * Push EVERY local row, not just what happens to be queued.
   *
   * The outbox only carries changes made since the last successful drain, so
   * once it empties the server can never catch up on anything it missed — a
   * failed sync, a server-side edit, a migration that diverged. That makes the
   * backup silently incomplete, which is worse than no backup because it looks
   * fine. This walks the local database and sends the current state, letting
   * the device be the source of truth it actually is.
   *
   * Safe to run repeatedly: op ids are derived from the row id, so the server's
   * idempotency turns a repeat into a no-op rather than a duplicate.
   */
  async backUpEverything(): Promise<{ sent: number; error?: string }> {
    const sessionRows = await this.deps.nativeCoordinator.query<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = 'owner_id'",
    );
    if (!sessionRows[0]?.value) return { sent: 0, error: "Sign in first" };
    const deviceId = await this.deps.secureDeviceId();

    let sent = 0;
    try {
      // Categories first so a restored device can apply allocations that
      // reference them. Transactions replay next. Budgets come last.
      sent += await this.pushBatches(await this.fieldBackupOps({
        entity: "categories",
        sql: "SELECT id, label, tint, parent_id, is_system, catalog_version FROM categories WHERE deleted_at IS NULL",
        toFields: (row) => ({
          categoryId: row.id, label: row.label, tint: row.tint,
          parentId: row.parent_id, isSystem: !!row.is_system, catalogVersion: row.catalog_version,
        }),
      }), deviceId);
      sent += await this.pushBatches(await this.transactionBackupOps(), deviceId);
      sent += await this.pushBatches(await this.fieldBackupOps({
        entity: "budgets",
        sql: "SELECT month_key, category_id, amount_minor, recurring FROM budgets",
        toFields: (row) => ({
          monthKey: row.month_key, categoryId: row.category_id,
          amountMinor: row.amount_minor, recurring: !!row.recurring,
        }),
      }), deviceId);
      return { sent };
    } catch (error) {
      return { sent, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async fieldBackupOps(source: {
    entity: string;
    sql: string;
    toFields: (row: Record<string, unknown>) => Record<string, unknown>;
  }): Promise<SyncOperation[]> {
    const rows = await this.deps.nativeCoordinator.query<Record<string, unknown>>(source.sql);
    return rows.map((row) => {
      const entityId = source.entity === "budgets"
        ? `${String(row.month_key)}:${String(row.category_id)}`
        : String(row.id);
      return {
        opId: deterministicOpId(source.entity, entityId),
        entity: source.entity,
        entityId,
        action: "upsert" as const,
        fields: source.toFields(row),
      };
    });
  }

  private async transactionBackupOps(): Promise<SyncOperation[]> {
    const [transactions, alerts, allocations] = await Promise.all([
      this.deps.nativeCoordinator.query<Record<string, unknown>>(
        `SELECT id, occurred_at, received_at, accounting_month_key, amount_minor,
                direction, currency_code, merchant_raw, counterparty_key, channel,
                status, plan_type
           FROM transactions
          WHERE deleted_at IS NULL
          ORDER BY id`,
      ),
      this.deps.nativeCoordinator.query<Record<string, unknown>>(
        `SELECT id, transaction_id, raw_sender, raw_body, received_at,
                provider_message_id, subscription_id, bank_reference, parse_status
           FROM source_alerts
          WHERE transaction_id IS NOT NULL
          ORDER BY id`,
      ),
      this.deps.nativeCoordinator.query<Record<string, unknown>>(
        `SELECT id, transaction_id, category_id, amount_minor, source, confidence
           FROM transaction_allocations
          ORDER BY id`,
      ),
    ]);

    const alertByTransaction = new Map<string, Record<string, unknown>>();
    for (const alert of alerts) {
      const transactionId = typeof alert.transaction_id === "string" ? alert.transaction_id : "";
      if (!transactionId || alertByTransaction.has(transactionId)) continue;
      alertByTransaction.set(transactionId, alert);
    }

    const allocationsByTransaction = new Map<string, Record<string, unknown>[]>();
    for (const allocation of allocations) {
      const transactionId = typeof allocation.transaction_id === "string" ? allocation.transaction_id : "";
      if (!transactionId) continue;
      const list = allocationsByTransaction.get(transactionId);
      if (list) list.push(allocation);
      else allocationsByTransaction.set(transactionId, [allocation]);
    }

    return transactions.flatMap((transaction) => {
      const id = String(transaction.id);
      return transactionToBackupOps({
        ...transaction,
        id,
        alert: alertByTransaction.get(id) ?? null,
        allocations: allocationsByTransaction.get(id) ?? [],
      });
    });
  }

  private async pushBatches(operations: SyncOperation[], deviceId: string): Promise<number> {
    let sent = 0;
    for (let index = 0; index < operations.length; index += BATCH_SIZE) {
      const slice = operations.slice(index, index + BATCH_SIZE);
      await this.push(slice, deviceId);
      sent += slice.length;
    }
    return sent;
  }

  private async drainOutbox(deviceId: string): Promise<number> {
    let pushed = 0;
    while (true) {
      const rows = await this.deps.nativeCoordinator.query<OutboxRow>(
        `SELECT id, device_id, op, table_name, row_id, payload, attempt_count,
                last_error, dead_lettered, created_at
           FROM outbox
          WHERE dead_lettered = 0 AND next_attempt_at <= ?
          ORDER BY created_at
          LIMIT ${BATCH_SIZE}`,
        [Date.now()],
      );
      if (rows.length === 0) return pushed;

      const operations = rows.map((row) => toServerOperation(row));
      const localIdByWireId = new Map(rows.map((row) => [wireOperationId(row.id), row.id]));
      try {
        const response = await this.push(operations, deviceId);
        const appliedIds = localIdsFromResponse(response.applied, localIdByWireId);
        const conflictIds = localIdsFromResponse(response.conflicts, localIdByWireId);
        if (appliedIds.size > 0) {
          pushed += await this.deps.nativeSync.acknowledgeOutbox(JSON.stringify([...appliedIds]));
        }
        for (const id of conflictIds) {
          await this.deps.nativeSync.recordOutboxFailure(id, "Server reported a sync conflict", MAX_ATTEMPTS);
        }
        const respondedIds = new Set([...appliedIds, ...conflictIds]);
        // A successful HTTP response that omits an operation is treated as a
        // retryable failure, preserving idempotency while avoiding a stuck row.
        for (const row of rows) {
          if (!respondedIds.has(row.id)) {
            await this.deps.nativeSync.recordOutboxFailure(row.id, "Push response omitted operation", MAX_ATTEMPTS);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await Promise.all(rows.map((row) => this.deps.nativeSync.recordOutboxFailure(row.id, message, MAX_ATTEMPTS)));
      }
    }
  }

  private async push(operations: SyncOperation[], deviceId: string): Promise<PushResponse> {
    const response = await this.deps.authenticatedFetch("/v1/sync/push", {
      method: "POST",
      body: JSON.stringify({ ops: operations, deviceId }),
    });
    if (!response.ok) throw new Error(`Sync push failed (${response.status})`);
    return (await response.json()) as PushResponse;
  }

  private async pull(userId: string): Promise<number> {
    await this.deps.nativeSync.retryRejectedOps();
    let cursor = await this.cursor();
    let total = 0;
    let rejected = 0;
    for (let page = 0; page < 20; page += 1) {
      const response = await this.deps.authenticatedFetch(`/v1/sync/pull?since=${encodeURIComponent(cursor)}`);
      if (!response.ok) throw new Error(`Sync pull failed (${response.status})`);
      const body = (await response.json()) as PullResponse;
      const nextCursor = nextPullCursor(body.cursor, cursor);
      const ops = body.ops ?? [];
      const commands = ops.map(normalizeRemoteCommand).map((command) => JSON.stringify(command));
      const applyReport = await this.deps.nativeSync.applyPulledOps(JSON.stringify(commands), nextCursor, userId);
      rejected += countRejected(applyReport);
      total += ops.length;
      if (ops.length === 0 || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    const leftoverRows = await this.deps.nativeCoordinator.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM sync_rejected",
    );
    const leftover = Number(leftoverRows[0]?.count ?? 0);
    // A rejected op is data the server has and this device does not. Apply-report
    // rejects catch a persist miss; leftover COUNT(*) catches prior-page rejects
    // that retry did not clear. Either one is an incomplete copy.
    if (rejected > 0 || leftover > 0) {
      const count = leftover > 0 ? leftover : rejected;
      throw new Error(`${count} change${count === 1 ? "" : "s"} from the server could not be applied`);
    }
    return total;
  }

  private async cursor(): Promise<string> {
    const rows = await this.deps.nativeCoordinator.query<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = 'pull_cursor'",
    );
    const stored = rows[0]?.value;
    return stored && stored !== "" ? stored : "0";
  }
}

/** Parses applyPulledOps JSON. Older builds returned an array and count as zero. */
function countRejected(report: unknown): number {
  if (typeof report !== "string") return 0;
  try {
    const parsed: unknown = JSON.parse(report);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { rejected?: unknown }).rejected)) {
      const list = (parsed as { rejected: unknown[] }).rejected;
      if (list.length > 0) console.warn("[sync] rejected ops", JSON.stringify(list).slice(0, 400));
      return list.length;
    }
  } catch {
    // An array (or anything else) means nothing was rejected.
  }
  return 0;
}

function toServerOperation(row: OutboxRow): SyncOperation {
  const command = parsePayload(row.payload);
  const commandRecord = command && typeof command === "object"
    ? command as Record<string, unknown>
    : null;
  const commandPayload = commandRecord?.payload;
  const fields = commandPayload && typeof commandPayload === "object" && !Array.isArray(commandPayload)
    ? commandPayload
    : { value: commandPayload ?? command };

  // The server accepts SyncOp envelopes. Keep the command envelope on the
  // operation as well so a later pull can replay the same command through the
  // coordinator instead of treating the generic field payload as a mutation.
  return {
    opId: wireOperationId(row.id),
    entity: row.table_name,
    entityId: row.row_id,
    // Archiving is a DELETE upstream. This was hardcoded to "upsert", so the
    // server never learned a category had been archived: it kept the row live
    // and the next pull dutifully restored it. Categories the user had deleted
    // kept coming back and reappearing in the budget list.
    action: commandRecord?.kind === "archiveCategory" ? "delete" : "upsert",
    fields,
    ...(typeof commandRecord?.payload === "object" && commandRecord.payload &&
    typeof (commandRecord.payload as Record<string, unknown>).source === "string"
      ? { source: (commandRecord.payload as Record<string, unknown>).source }
      : {}),
    ...(typeof commandRecord?.kind === "string" ? { kind: commandRecord.kind } : {}),
    ...(commandRecord?.payload !== undefined ? { payload: commandRecord.payload } : {}),
  };
}

function idsFromResponse(values: unknown[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const value of values ?? []) {
    if (typeof value === "string") ids.add(value);
    else if (value && typeof value === "object") {
      const item = value as Record<string, unknown>;
      for (const key of ["id", "opId", "operationId", "commandId"]) {
        if (typeof item[key] === "string") {
          ids.add(item[key] as string);
          break;
        }
      }
    }
  }
  return ids;
}

function localIdsFromResponse(
  values: unknown[] | undefined,
  localIdByWireId: Map<string, string>,
): Set<string> {
  return new Set([...idsFromResponse(values)].flatMap((id) => {
    const localId = localIdByWireId.get(id);
    return localId ? [localId] : [];
  }));
}
