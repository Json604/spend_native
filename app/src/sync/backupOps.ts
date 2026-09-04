/**
 * Pure backup mappers. Kept free of React Native so node --test can exercise
 * the transaction envelope without loading the native module graph.
 */

export type BackupAlertRow = {
  id: unknown;
  raw_sender?: unknown;
  raw_body?: unknown;
  received_at?: unknown;
  provider_message_id?: unknown;
  subscription_id?: unknown;
  bank_reference?: unknown;
  parse_status?: unknown;
};

export type BackupAllocationRow = {
  id?: unknown;
  category_id?: unknown;
  amount_minor?: unknown;
  source?: unknown;
  confidence?: unknown;
};

export type BackupTransactionRow = {
  id: unknown;
  occurred_at?: unknown;
  received_at?: unknown;
  accounting_month_key?: unknown;
  amount_minor?: unknown;
  direction?: unknown;
  currency_code?: unknown;
  merchant_raw?: unknown;
  counterparty_key?: unknown;
  channel?: unknown;
  status?: unknown;
  plan_type?: unknown;
  alert?: BackupAlertRow | null;
  allocations?: BackupAllocationRow[] | null;
};

export type BackupOperation = {
  opId: string;
  entity: "transactions";
  entityId: string;
  action: "upsert";
  kind: "createTransactionFromAlert" | "splitTransaction" | "ignoreTransaction";
  fields: Record<string, unknown>;
  payload: Record<string, unknown>;
};

/**
 * A UUID derived from the entity id, so re-running a full backup produces the
 * SAME op ids and the server's idempotency collapses repeats into no-ops.
 */
export function deterministicOpId(entity: string, entityId: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const input = `${entity}:${entityId}`;
  for (let index = 0; index < input.length; index += 1) {
    h1 = Math.imul(h1 ^ input.charCodeAt(index), 16777619) >>> 0;
    h2 = Math.imul(h2 + input.charCodeAt(index), 2246822519) >>> 0;
  }
  // `>>> 0` on EVERY term, including the xor. JS `^` yields a SIGNED 32-bit
  // int, so a result with the top bit set stringifies with a leading "-" that
  // padStart cannot pad away. That dash landed inside the sliced groups and
  // produced ids like `0552fd08-fa2a-5132-8-87-d3c6ff7dce3a` — six groups, not
  // five. The server validates opId as a UUID and rejects the ENTIRE push batch
  // on the first bad one, so a single poisoned row paused backup for good.
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, "0");
  const raw = `${hex(h1)}${hex(h2)}${hex(h1 ^ h2)}${hex(h1 + h2)}`;
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    `5${raw.slice(13, 16)}`,
    `${"89ab"[h1 & 3]}${raw.slice(17, 20)}`,
    raw.slice(20, 32),
  ].join("-");
}

/**
 * One local transaction becomes the same command envelope the outbox already
 * pushes: create from alert, then split if needed, then ignore if needed.
 */
export function transactionToBackupOps(row: BackupTransactionRow): BackupOperation[] {
  const transactionId = asString(row.id);
  if (!transactionId) return [];

  const allocations = Array.isArray(row.allocations) ? row.allocations : [];
  const createPayload: Record<string, unknown> = {
    alert: alertPayload(row, transactionId),
    transaction: transactionPayload(row, transactionId),
  };
  if (allocations.length === 1) {
    createPayload.allocation = initialAllocationPayload(allocations[0]);
  }

  const ops: BackupOperation[] = [
    commandOp(transactionId, transactionId, "createTransactionFromAlert", createPayload),
  ];

  if (allocations.length >= 2) {
    ops.push(commandOp(transactionId, `${transactionId}:split`, "splitTransaction", {
      transactionId,
      allocations: allocations.map((allocation) => splitAllocationPayload(allocation)),
    }));
  }

  if (asString(row.status) === "ignored") {
    ops.push(commandOp(transactionId, `${transactionId}:ignore`, "ignoreTransaction", {
      transactionId,
    }));
  }

  return ops;
}

function commandOp(
  entityId: string,
  opKey: string,
  kind: BackupOperation["kind"],
  payload: Record<string, unknown>,
): BackupOperation {
  return {
    opId: deterministicOpId("transactions", opKey),
    entity: "transactions",
    entityId,
    action: "upsert",
    kind,
    fields: payload,
    payload,
  };
}

function alertPayload(row: BackupTransactionRow, transactionId: string): Record<string, unknown> {
  const alert = row.alert;
  const alertId = alert ? asString(alert.id) : null;
  if (!alert || !alertId) {
    const synthesized: Record<string, unknown> = {
      id: `${transactionId}:alert`,
      receivedAt: asNumber(row.received_at) ?? 0,
      parseStatus: "parsed",
    };
    const rawBody = asString(row.merchant_raw);
    if (rawBody) synthesized.rawBody = rawBody;
    return synthesized;
  }

  const payload: Record<string, unknown> = {
    id: alertId,
    receivedAt: asNumber(alert.received_at) ?? asNumber(row.received_at) ?? 0,
    parseStatus: asString(alert.parse_status) ?? "parsed",
  };
  const rawSender = asString(alert.raw_sender);
  if (rawSender) payload.rawSender = rawSender;
  const rawBody = asString(alert.raw_body);
  if (rawBody) payload.rawBody = rawBody;
  const providerMessageId = asString(alert.provider_message_id);
  if (providerMessageId) payload.providerMessageId = providerMessageId;
  const subscriptionId = asNumber(alert.subscription_id);
  if (subscriptionId !== null) payload.subscriptionId = subscriptionId;
  const bankReference = asString(alert.bank_reference);
  if (bankReference) payload.bankReference = bankReference;
  return payload;
}

function transactionPayload(row: BackupTransactionRow, transactionId: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: transactionId,
    occurredAt: asNumber(row.occurred_at) ?? 0,
    receivedAt: asNumber(row.received_at) ?? 0,
    accountingMonthKey: asString(row.accounting_month_key) ?? "",
    amountMinor: asNumber(row.amount_minor) ?? 0,
    direction: asString(row.direction) ?? "debit",
    currencyCode: asString(row.currency_code) ?? "INR",
    status: asString(row.status) ?? "posted",
    planType: asString(row.plan_type) ?? "planned",
  };
  const merchantRaw = asString(row.merchant_raw);
  if (merchantRaw) payload.merchantRaw = merchantRaw;
  const counterpartyKey = asString(row.counterparty_key);
  if (counterpartyKey) payload.counterpartyKey = counterpartyKey;
  const channel = asString(row.channel);
  if (channel) payload.channel = channel;
  return payload;
}

function initialAllocationPayload(allocation: BackupAllocationRow): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    categoryId: asString(allocation.category_id),
    source: asString(allocation.source) ?? "rule",
  };
  const id = asString(allocation.id);
  if (id) payload.id = id;
  const confidence = asNumber(allocation.confidence);
  if (confidence !== null) payload.confidence = confidence;
  return payload;
}

function splitAllocationPayload(allocation: BackupAllocationRow): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    categoryId: asString(allocation.category_id),
    amountMinor: asNumber(allocation.amount_minor) ?? 0,
  };
  const allocationId = asString(allocation.id);
  if (allocationId) payload.allocationId = allocationId;
  return payload;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value === "" ? null : value;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}
