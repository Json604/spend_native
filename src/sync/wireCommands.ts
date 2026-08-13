/**
 * Translation between the server's neutral op shape and the coordinator's
 * command vocabulary. Kept free of React Native imports so it can be tested
 * directly under `node --test`, which is the only reason this is not inline
 * in syncClient.
 */
export type SyncOperation = Record<string, unknown>;

export function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function wireOperationId(localId: string): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (uuid.test(localId)) return localId;

  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < localId.length; index += 1) {
    first = Math.imul(first ^ localId.charCodeAt(index), 16777619) >>> 0;
    second = Math.imul(second + localId.charCodeAt(index), 2246822519) >>> 0;
  }
  const hex = (value: number) => value.toString(16).padStart(8, "0");
  const raw = `${hex(first)}${hex(second)}${hex(first ^ second)}${hex((first + second) >>> 0)}`;
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    `5${raw.slice(13, 16)}`,
    `${"89ab"[first & 3]}${raw.slice(17, 20)}`,
    raw.slice(20, 32),
  ].join("-");
}

export function normalizeRemoteCommand(operation: SyncOperation): Record<string, unknown> {
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

  // Not every op on the server carries a `kind`. A full backup — and any repair
  // written server-side — sends the neutral wire shape {entity, action, fields}
  // with no command name in it, because `kind` is a device concept. Those ops
  // used to fall through to `operation.op` and `operation.id`, which a pulled
  // row does not have (it exposes `action` and `op_id`), producing a command
  // with no kind and no id that the coordinator could not route. The rows sat
  // on the server, pulled down, and were dropped on the floor: a wiped device
  // restored its categories and transactions but every budget came back blank.
  //
  // The command name is derivable from what the op already says, so derive it.
  const derived = deriveCommandFromWire(operation, inner);
  if (derived) return derived;

  return {
    commandId: operation.id ?? operation.opId,
    kind: operation.op,
    ...(typeof inner.expectedRevision === "number" ? { expectedRevision: inner.expectedRevision } : {}),
    payload: inner.payload ?? inner,
  };
}

/**
 * Map the entity/action wire shape onto the coordinator's command vocabulary.
 * The server's `fields` are already exactly the command payloads, so this is a
 * naming translation, not a data conversion.
 */
export function deriveCommandFromWire(
  operation: SyncOperation,
  inner: Record<string, unknown>,
): Record<string, unknown> | null {
  const entity = asString(operation.entity_type) ?? asString(operation.entity);
  const action = asString(operation.action) ?? asString(inner.action);
  const entityId = asString(operation.entity_id) ?? asString(inner.entityId);
  const commandId = asString(operation.op_id) ?? asString(operation.opId) ?? asString(inner.opId);
  if (!entity || !action || !commandId) return null;
  const fields = inner.fields && typeof inner.fields === "object"
    ? inner.fields as Record<string, unknown>
    : {};

  if (entity === "budgets") {
    if (action === "upsert") {
      return { commandId, kind: "setBudgetAmount", payload: fields };
    }
    // A budget entity id is "<monthKey>:<categoryId>". There is no delete
    // command for a single line — clearMonthBudget would take the whole month —
    // so a removed line is expressed as an amount of zero.
    const separator = entityId?.indexOf(":") ?? -1;
    if (!entityId || separator < 0) return null;
    return {
      commandId,
      kind: "setBudgetAmount",
      payload: {
        monthKey: entityId.slice(0, separator),
        categoryId: entityId.slice(separator + 1),
        amountMinor: 0,
        recurring: false,
      },
    };
  }

  if (entity === "categories") {
    if (action === "upsert") {
      return { commandId, kind: "createCategory", payload: fields };
    }
    if (!entityId) return null;
    return { commandId, kind: "archiveCategory", payload: { categoryId: entityId } };
  }

  if (entity === "transactions" || entity === "source_alerts") {
    if (action !== "upsert") return null;
    const nested = asRecord(inner.payload) ?? {};
    const createPayload = createTransactionPayload(fields, nested, inner);
    if (createPayload) {
      return { commandId, kind: "createTransactionFromAlert", payload: createPayload };
    }

    const transactionId = asString(fields.transactionId)
      ?? asString(nested.transactionId)
      ?? asString(inner.transactionId);
    const allocations = Array.isArray(fields.allocations)
      ? fields.allocations
      : Array.isArray(nested.allocations)
        ? nested.allocations
        : Array.isArray(inner.allocations)
          ? inner.allocations
          : null;
    if (transactionId && allocations) {
      return {
        commandId,
        kind: "splitTransaction",
        payload: { transactionId, allocations },
      };
    }
    if (transactionId && !allocations) {
      const status = fields.status ?? nested.status ?? inner.status;
      const reason = fields.reason ?? nested.reason ?? inner.reason;
      if (status === "ignored" || reason === "ignore") {
        return { commandId, kind: "ignoreTransaction", payload: { transactionId } };
      }
    }
    return null;
  }

  return null;
}

function createTransactionPayload(
  fields: Record<string, unknown>,
  nested: Record<string, unknown>,
  inner: Record<string, unknown>,
): Record<string, unknown> | null {
  for (const candidate of [fields, nested, inner]) {
    const alert = asRecord(candidate.alert);
    const transaction = asRecord(candidate.transaction);
    if (!alert || !transaction) continue;
    const allocation = asRecord(candidate.allocation);
    return {
      alert,
      transaction,
      ...(allocation ? { allocation } : {}),
    };
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The pull cursor is a server-assigned sequence NUMBER, but it travels as JSON
 * and is stored locally as text. A `typeof cursor === "string"` guard here
 * silently rejected every response and fell back to the previous value, so the
 * cursor never advanced: the device re-pulled the same first page forever and
 * never saw anything beyond it. Months of budget sat unreachable on the server
 * while the app reported a clean sync.
 *
 * Accept either shape, and only accept a cursor that actually moves forward.
 */
export function nextPullCursor(received: unknown, current: string): string {
  const value = typeof received === "number" && Number.isFinite(received)
    ? received
    : typeof received === "string" && received.trim() !== "" && Number.isFinite(Number(received))
      ? Number(received)
      : null;
  if (value === null || value < 0) return current;
  const currentValue = Number.isFinite(Number(current)) ? Number(current) : 0;
  return value >= currentValue ? String(value) : current;
}
