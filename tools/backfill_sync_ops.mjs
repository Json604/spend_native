#!/usr/bin/env node

import { createHash } from "node:crypto";

const userId = process.argv[2] ?? process.env.SYNC_USER_ID;
const databaseUrl = process.env.DATABASE_URL ?? process.env.SPEND_DATABASE_URL;

if (!userId) {
  throw new Error("Usage: DATABASE_URL=... node tools/backfill_sync_ops.mjs <user-id>");
}
if (!databaseUrl) {
  throw new Error("DATABASE_URL (or SPEND_DATABASE_URL) is required");
}

let Client;
try {
  ({ Client } = await import("pg"));
} catch {
  // The app repo does not need pg at runtime; use the sibling sync server's
  // dependency when this script is run from the app workspace.
  ({ Client } = await import("../spend_server/node_modules/pg/lib/index.js"));
}

const client = new Client({ connectionString: databaseUrl });
const counts = {
  categories: 0,
  transactions: 0,
  transaction_allocations: 0,
  budgets: 0,
  category_memory: 0,
};
const skipped = { category_memory: 0 };

await client.connect();
try {
  await client.query("BEGIN");

  const [categories, transactions, allocations, budgets, memories, alerts] = await Promise.all([
    rows(client, "categories", userId),
    rows(client, "transactions", userId),
    rows(client, "transaction_allocations", userId, "id, data, transaction_id, source"),
    rows(client, "budgets", userId),
    rows(client, "category_memory", userId),
    // source_alerts keeps transactionId inside the data JSONB; only
    // transaction_allocations promotes it to a real column. Line 171 already
    // falls back to reading it out of data, so selecting id+data is sufficient.
    rows(client, "source_alerts", userId, "id, data"),
  ]);

  await client.query("DELETE FROM sync_ops WHERE user_id = $1", [userId]);

  const commands = [];
  for (const row of sortCategories(categories)) commands.push({
    entity: "categories",
    entityId: row.id,
    command: categoryCommand(userId, row),
  });
  for (const row of transactions) commands.push({
    entity: "transactions",
    entityId: row.id,
    command: transactionCommand(userId, row, alerts),
  });
  const transactionRevisions = new Map();
  for (const row of allocations) {
    if (categoryId(row.data)) commands.push({
      entity: "transaction_allocations",
      entityId: row.id,
      command: allocationCommand(userId, row, transactionRevisions),
    });
  }

  const monthRevisions = new Map();
  for (const row of budgets.sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    const command = budgetCommand(userId, row, monthRevisions);
    commands.push({ entity: "budgets", entityId: row.id, command });
  }

  for (const item of commands) {
    await insertSyncOp(client, userId, item.entity, item.entityId, item.command);
    counts[item.entity] += 1;
  }

  // category_memory has no corresponding command in src/db/commands.ts. It is
  // intentionally not converted into an invented mutation; its observations
  // can only be rebuilt by a supported assignCategory command.
  skipped.category_memory = memories.length;
  await client.query("COMMIT");

  console.log(`Backfilled sync_ops for ${userId}`);
  for (const [entity, count] of Object.entries(counts)) console.log(`  ${entity}: ${count}`);
  console.log(`  category_memory: ${memories.length} rows skipped (no category_memory command exists)`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}

async function rows(db, table, owner, columns = "id, data") {
  // Categories are the ONE table where soft-deleted rows must still be emitted.
  // Archived categories still own historical budgets — an entire month's budget
  // can sit under a category the user later deleted — so skipping them makes
  // every budget referencing one fail a FOREIGN KEY check, which aborts the
  // whole pulled batch.
  const includeDeleted = table === "categories";
  const result = await db.query(
    `SELECT ${columns} FROM ${table} WHERE user_id = $1${includeDeleted ? "" : " AND deleted_at IS NULL"} ORDER BY id`,
    [owner],
  );
  return result.rows;
}

async function insertSyncOp(db, owner, entity, entityId, command) {
  const opId = command.commandId;
  const operation = {
    opId,
    entity,
    entityId,
    action: "upsert",
    fields: command.payload,
    commandId: command.commandId,
    kind: command.kind,
    payload: command.payload,
  };
  const outcome = {
    opId,
    entity,
    entityId,
    changed: Object.keys(command.payload),
    skipped: false,
    backfilled: true,
  };
  await db.query(
    `INSERT INTO sync_ops
       (op_id, user_id, device_id, entity_type, entity_id, action, payload, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [opId, owner, "backfill", entity, entityId, "upsert", operation, outcome],
  );
}

function categoryCommand(owner, row) {
  const data = row.data ?? {};
  return {
    commandId: commandId(owner, "categories", row.id),
    kind: "createCategory",
    payload: {
      categoryId: row.id,
      label: requiredString(data, "label", `category ${row.id} label`),
      tint: nullableString(data, "tint"),
      parentId: nullableString(data, "parentId", "parent_id"),
      isSystem: booleanValue(data, "isSystem", "is_system"),
      catalogVersion: integerValue(data, 1, "catalogVersion", "catalog_version"),
    },
  };
}

function sortCategories(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  function visit(row) {
    if (visited.has(row.id)) return;
    if (visiting.has(row.id)) throw new Error(`category parent cycle includes ${row.id}`);
    visiting.add(row.id);
    const parent = nullableString(row.data ?? {}, "parentId", "parent_id");
    if (parent && byId.has(parent)) visit(byId.get(parent));
    visiting.delete(row.id);
    visited.add(row.id);
    ordered.push(row);
  }

  for (const row of rows.sort((left, right) => String(left.id).localeCompare(String(right.id)))) visit(row);
  return ordered;
}

function transactionCommand(owner, row, alerts) {
  const raw = row.data ?? {};
  // transactions.data holds two shapes. Rows written by the one-time migration
  // are FLAT ({occurredAt, amountMinor, ...}); rows the device pushed through
  // /v1/sync/push store the whole createTransactionFromAlert command payload
  // NESTED as {alert, allocation, transaction}, because push persists op.fields
  // verbatim. Unwrap the nested form so both round-trip.
  const nested = raw.transaction && typeof raw.transaction === "object" ? raw.transaction : null;
  const data = nested ?? raw;
  const alert = nested && raw.alert && typeof raw.alert === "object"
    ? { data: raw.alert }
    : alerts.find((candidate) => (candidate.transaction_id ?? stringValue(candidate.data, "transactionId", "transaction_id")) === row.id);
  const alertData = alert?.data ?? {};
  return {
    commandId: commandId(owner, "transactions", row.id),
    kind: "createTransactionFromAlert",
    payload: {
      alert: {
        id: alert?.id ?? `backfill-alert:${row.id}`,
        rawSender: nullableString(alertData, "rawSender", "raw_sender"),
        rawBody: nullableString(alertData, "rawBody", "raw_body"),
        receivedAt: integerValue(alertData, integerValue(data, Date.now(), "receivedAt", "received_at"), "receivedAt", "received_at"),
        providerMessageId: nullableString(alertData, "providerMessageId", "provider_message_id"),
        subscriptionId: nullableInteger(alertData, "subscriptionId", "subscription_id"),
        bankReference: nullableString(alertData, "bankReference", "bank_reference"),
        parseStatus: stringValue(alertData, "parseStatus", "parse_status") ?? "parsed",
      },
      transaction: {
        id: row.id,
        occurredAt: integerValue(data, 0, "occurredAt", "occurred_at"),
        receivedAt: integerValue(data, 0, "receivedAt", "received_at"),
        accountingMonthKey: requiredString(data, "accountingMonthKey", `transaction ${row.id} accountingMonthKey`, "accounting_month_key"),
        amountMinor: requiredInteger(data, "amountMinor", `transaction ${row.id} amountMinor`, "amount_minor"),
        direction: enumValue(data, "direction", ["debit", "credit", "transfer"], "debit"),
        currencyCode: nullableString(data, "currencyCode", "currency_code") ?? "INR",
        merchantRaw: nullableString(data, "merchantRaw", "merchant_raw"),
        counterpartyKey: nullableString(data, "counterpartyKey", "counterparty_key"),
        channel: nullableString(data, "channel"),
        status: enumValue(data, "status", ["pending", "posted", "failed", "reversed", "ignored"], "posted"),
        planType: enumValue(data, "planType", ["planned", "unplanned"], "planned"),
      },
      allocation: { categoryId: null, source: "migrated", confidence: null },
    },
  };
}

function allocationCommand(owner, row, transactionRevisions) {
  const data = row.data ?? {};
  const source = enumValue({ source: row.source ?? data.source }, "source", ["manual", "learned", "rule", "similarity", "llm"], "manual");
  const transactionId = requiredString({ ...data, transactionId: row.transaction_id ?? data.transactionId }, "transactionId", `allocation ${row.id} transactionId`, "transaction_id");
  const expectedRevision = transactionRevisions.get(transactionId) ?? 1;
  transactionRevisions.set(transactionId, expectedRevision + 1);
  return {
    commandId: commandId(owner, "transaction_allocations", row.id),
    kind: "assignCategory",
    expectedRevision,
    payload: {
      transactionId,
      categoryId: requiredString(data, "categoryId", `allocation ${row.id} categoryId`, "category_id"),
      source,
      confidence: nullableNumber(data, "confidence"),
      allocationId: row.id,
    },
  };
}

function budgetCommand(owner, row, monthRevisions) {
  const data = row.data ?? {};
  const monthKey = requiredString(data, "monthKey", `budget ${row.id} monthKey`, "month_key");
  const expectedRevision = monthRevisions.get(monthKey) ?? 0;
  monthRevisions.set(monthKey, expectedRevision + 1);
  return {
    commandId: commandId(owner, "budgets", row.id),
    kind: "setBudgetAmount",
    expectedRevision,
    payload: {
      monthKey,
      categoryId: requiredString(data, "categoryId", `budget ${row.id} categoryId`, "category_id"),
      amountMinor: requiredInteger(data, "amountMinor", `budget ${row.id} amountMinor`, "amount_minor"),
      recurring: booleanValue(data, "recurring"),
    },
  };
}

function commandId(owner, entity, entityId) {
  const digest = createHash("sha256").update(`spend-sync-backfill:v1:${owner}:${entity}:${entityId}`).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function dataValue(data, ...keys) {
  for (const key of keys) if (data[key] !== undefined) return data[key];
  return undefined;
}

function stringValue(data, ...keys) {
  const value = dataValue(data, ...keys);
  return value === null || value === undefined ? null : String(value);
}

function requiredString(data, key, label, alternate) {
  const value = stringValue(data, key, alternate ?? snakeCase(key));
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function nullableString(data, ...keys) {
  const value = stringValue(data, ...keys);
  return value || null;
}

function categoryId(data) {
  return stringValue(data ?? {}, "categoryId", "category_id");
}

function integerValue(data, fallback, ...keys) {
  const value = dataValue(data, ...keys);
  return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
}

function requiredInteger(data, key, label, alternate) {
  const value = integerValue(data, Number.NaN, key, alternate ?? snakeCase(key));
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is required and must be an integer`);
  return value;
}

function nullableInteger(data, ...keys) {
  const value = dataValue(data, ...keys);
  return value === null || value === undefined ? null : integerValue(data, null, ...keys);
}

function nullableNumber(data, ...keys) {
  const value = dataValue(data, ...keys);
  return value === null || value === undefined ? null : Number(value);
}

function booleanValue(data, ...keys) {
  const value = dataValue(data, ...keys);
  return value === true || value === 1 || value === "1" || value === "true";
}

function enumValue(data, key, values, fallback) {
  const value = stringValue(data, key, snakeCase(key));
  return values.includes(value) ? value : fallback;
}

function snakeCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
