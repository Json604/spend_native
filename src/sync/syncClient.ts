import { authenticatedFetch, secureDeviceId } from "../auth/authClient";
import { nativeCoordinator } from "../db/nativeCoordinator";
import { nativeSync } from "./nativeSync";

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

type SyncOperation = Record<string, unknown>;
type PushResponse = { applied?: unknown[]; conflicts?: unknown[] };
type PullResponse = { ops?: SyncOperation[]; cursor?: string };

export type SyncReport = {
  pushed: number;
  pulled: number;
  deadLetterCount: number;
  error?: string;
};

let syncInFlight: Promise<SyncReport> | null = null;

export class SpendSyncClient {
  sync(): Promise<SyncReport> {
    if (syncInFlight) return syncInFlight;
    syncInFlight = this.run().finally(() => {
      syncInFlight = null;
    });
    return syncInFlight;
  }

  async deadLetterCount(): Promise<number> {
    return nativeSync.getDeadLetterCount();
  }

  async pendingOutboxCount(): Promise<number> {
    const rows = await nativeCoordinator.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM outbox WHERE dead_lettered = 0",
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async run(): Promise<SyncReport> {
    const sessionRows = await nativeCoordinator.query<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = 'owner_id'",
    );
    const userId = sessionRows[0]?.value;
    console.log("[sync] owner_id =", userId ?? "(none — sync will no-op)");
    if (!userId) return { pushed: 0, pulled: 0, deadLetterCount: await this.deadLetterCount() };

    let pushed = 0;
    let pulled = 0;
    let lastError: string | undefined;
    try {
      pushed = await this.drainOutbox(await secureDeviceId());
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

  private async drainOutbox(deviceId: string): Promise<number> {
    let pushed = 0;
    while (true) {
      const rows = await nativeCoordinator.query<OutboxRow>(
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
      try {
        const response = await this.push(operations, deviceId);
        const appliedIds = idsFromResponse(response.applied);
        const conflictIds = idsFromResponse(response.conflicts);
        if (appliedIds.size > 0) {
          pushed += await nativeSync.acknowledgeOutbox(JSON.stringify([...appliedIds]));
        }
        for (const id of conflictIds) {
          await nativeSync.recordOutboxFailure(id, "Server reported a sync conflict", MAX_ATTEMPTS);
        }
        const respondedIds = new Set([...appliedIds, ...conflictIds]);
        // A successful HTTP response that omits an operation is treated as a
        // retryable failure, preserving idempotency while avoiding a stuck row.
        for (const row of rows) {
          if (!respondedIds.has(row.id)) {
            await nativeSync.recordOutboxFailure(row.id, "Push response omitted operation", MAX_ATTEMPTS);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await Promise.all(rows.map((row) => nativeSync.recordOutboxFailure(row.id, message, MAX_ATTEMPTS)));
      }
    }
  }

  private async push(operations: SyncOperation[], deviceId: string): Promise<PushResponse> {
    const response = await authenticatedFetch("/v1/sync/push", {
      method: "POST",
      body: JSON.stringify({ ops: operations, deviceId }),
    });
    if (!response.ok) throw new Error(`Sync push failed (${response.status})`);
    return (await response.json()) as PushResponse;
  }

  private async pull(userId: string): Promise<number> {
    let cursor = await this.cursor();
    let total = 0;
    for (let page = 0; page < 20; page += 1) {
      const response = await authenticatedFetch(`/v1/sync/pull?since=${encodeURIComponent(cursor)}`);
      if (!response.ok) throw new Error(`Sync pull failed (${response.status})`);
      const body = (await response.json()) as PullResponse;
      const nextCursor = typeof body.cursor === "string" ? body.cursor : cursor;
      const ops = body.ops ?? [];
      const commands = ops.map(normalizeRemoteCommand).map((command) => JSON.stringify(command));
      console.log("[sync] pulled", ops.length, "ops; first =", JSON.stringify(ops[0] ?? null).slice(0, 260));
      console.log("[sync] normalized first command =", commands[0]?.slice(0, 260) ?? "(none)");
      try {
        await nativeSync.applyPulledOps(JSON.stringify(commands), nextCursor, userId);
        console.log("[sync] applied", commands.length, "commands, cursor ->", nextCursor);
      } catch (applyError) {
        console.log("[sync] APPLY FAILED:", applyError instanceof Error ? applyError.message : String(applyError));
        throw applyError;
      }
      total += ops.length;
      if (ops.length === 0 || nextCursor === cursor) return total;
      cursor = nextCursor;
    }
    return total;
  }

  private async cursor(): Promise<string> {
    const rows = await nativeCoordinator.query<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = 'pull_cursor'",
    );
    return rows[0]?.value ?? "";
  }
}

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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
    opId: row.id,
    entity: row.table_name,
    entityId: row.row_id,
    action: "upsert",
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

function normalizeRemoteCommand(operation: SyncOperation): Record<string, unknown> {
  const rawPayload = operation.payload;
  const payload = typeof rawPayload === "string" ? parsePayload(rawPayload) : rawPayload;
  if (payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).kind === "string") {
    // Server ops carry the command under `fields` with an `opId`, which is the
    // wire shape. The coordinator expects `payload` with a `commandId`, so
    // translate rather than passing it through — otherwise every pulled command
    // fails to parse and the whole batch aborts.
    const remote = payload as Record<string, unknown>;
    const fields = remote.fields;
    const normalized: Record<string, unknown> = {
      kind: remote.kind,
      commandId: remote.commandId ?? remote.opId ?? operation.op_id ?? operation.opId,
      payload: remote.payload ?? (fields && typeof fields === "object" ? fields : {}),
    };
    // expectedRevision is deliberately omitted for pulled ops. The server is
    // authoritative for what it sends, and it has no view of this device's local
    // revision; carrying a stale expectation would reject legitimate remote
    // state. Local edits are still protected by the manual-provenance rule.
    if (typeof remote.expectedRevision === "number") {
      normalized.expectedRevision = remote.expectedRevision;
    }
    return normalized;
  }
  const inner = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  return {
    commandId: operation.id ?? operation.opId,
    kind: operation.op,
    ...(typeof inner.expectedRevision === "number" ? { expectedRevision: inner.expectedRevision } : {}),
    payload: inner.payload ?? inner,
  };
}

export const syncClient = new SpendSyncClient();
