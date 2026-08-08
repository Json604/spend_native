#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  buildCounterpartyKey,
  isLowSpecificityKey,
} from '../src/parser/counterpartyKey.ts';

const PRIMARY_IDENTITY = 'aae9e2e8-943a-494d-b1e3-52e7d5a04eef';
const SOURCE_SYSTEM = 'spend_backup';
const EXPECTED_ACTIVE_DEBITS = 178;
const EXPECTED_ACTIVE_DEBIT_TOTAL = 6_751_207;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const exportDir = resolve(process.argv[2] ?? '/Users/arka/Desktop/spend_backup');
const outputDbPath = resolve(process.argv[3] ?? './staging.sqlite');
const migrationPath = resolve(scriptDir, '../db/migrations/001_initial.sql');

const sourceFiles = {
  spend_transactions: 'spend_transactions.json',
  spend_categories: 'spend_categories.json',
  spend_monthly_budgets: 'spend_monthly_budgets.json',
  spend_monthly_category_budgets: 'spend_monthly_category_budgets.json',
};

class MappingError extends Error {}

function readJsonArray(filePath) {
  const value = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(value)) {
    throw new Error(`${filePath} must contain a JSON array`);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MappingError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new MappingError(`${field} must be a string or null`);
  }
  return value;
}

function safeInteger(value, field) {
  if (!Number.isSafeInteger(value)) {
    throw new MappingError(`${field} must be a safe integer`);
  }
  return value;
}

function epochMilliseconds(value, field) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new MappingError(`${field} must be an ISO timestamp with an explicit offset`);
  }

  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new MappingError(`${field} is not a representable epoch-millisecond timestamp`);
  }
  return milliseconds;
}

function booleanInteger(value, field) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new MappingError(`${field} must be boolean`);
}

function mapDirection(value) {
  switch (value) {
    case 'debit':
    case 'credit':
    case 'transfer':
      return value;
    case 'refund':
      return 'credit';
    default:
      throw new MappingError(`unrecognised direction: ${JSON.stringify(value)}`);
  }
}

function mapStatus(value) {
  switch (value) {
    case 'pending':
    case 'posted':
    case 'ignored':
      return value;
    default:
      throw new MappingError(`unrecognised status: ${JSON.stringify(value)}`);
  }
}

function mapPlanType(value) {
  // Legacy null meant "not explicitly marked unplanned"; v1 calls that planned.
  if (value === null || value === undefined || value === 'planned') return 'planned';
  if (value === 'unplanned') return 'unplanned';
  throw new MappingError(`unrecognised plan_type: ${JSON.stringify(value)}`);
}

const monthFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
});

function accountingMonthKey(occurredAt) {
  const parts = monthFormatter.formatToParts(new Date(occurredAt));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) {
    throw new MappingError('could not derive accounting_month_key in Asia/Kolkata');
  }
  return `${year}-${month}`;
}

function validateMonthKey(value) {
  const monthKey = requiredString(value, 'month_key');
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(monthKey)) {
    throw new MappingError(`invalid month_key: ${JSON.stringify(value)}`);
  }
  return monthKey;
}

function stableId(prefix, ...parts) {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${prefix}:${digest.slice(0, 32)}`;
}

function legacyPk(row, tableName, index) {
  if (isRecord(row)) {
    if (typeof row.id === 'string' && row.id !== '') return row.id;
    if (tableName === 'spend_monthly_budgets' && typeof row.month_key === 'string') {
      return row.month_key;
    }
    if (
      tableName === 'spend_monthly_category_budgets' &&
      typeof row.month_key === 'string' &&
      typeof row.category_id === 'string'
    ) {
      return `${row.month_key}:${row.category_id}`;
    }
  }
  return `row:${index}`;
}

function legacyUserId(row) {
  return isRecord(row) && typeof row.user_id === 'string' && row.user_id !== ''
    ? row.user_id
    : '<missing>';
}

const input = Object.fromEntries(
  Object.entries(sourceFiles).map(([tableName, fileName]) => [
    tableName,
    readJsonArray(resolve(exportDir, fileName)),
  ]),
);
const importTimestamp = Date.now();

const exportedCategoryIds = new Set(
  input.spend_categories
    .filter(isRecord)
    .map((row) => row.id)
    .filter((id) => typeof id === 'string' && id !== ''),
);

function archivedCategoryLabel(categoryId) {
  return categoryId
    .replace(/^custom:/, '')
    .replaceAll('-', ' ')
    .split(/\s+/)
    .map((word) =>
      word.length === 0
        ? word
        : word[0].toLocaleUpperCase('en-US') + word.slice(1).toLocaleLowerCase('en-US'),
    )
    .join(' ');
}

const db = new DatabaseSync(outputDbPath);

function rollbackQuietly() {
  try {
    db.exec('ROLLBACK');
  } catch {
    // There may be no open transaction after a failed SQLite statement.
  }
}

try {
  db.exec('PRAGMA foreign_keys = ON;');

  const currentVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (currentVersion === 0) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(readFileSync(migrationPath, 'utf8'));
      db.exec('COMMIT;');
    } catch (error) {
      rollbackQuietly();
      throw error;
    }
  } else if (currentVersion !== 1) {
    throw new Error(`unsupported database user_version ${currentVersion}; expected 0 or 1`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS quarantine (
      id TEXT PRIMARY KEY,
      legacy_table TEXT NOT NULL,
      legacy_pk TEXT NOT NULL,
      legacy_user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
  `);

  const insertQuarantine = db.prepare(`
    INSERT INTO quarantine (id, legacy_table, legacy_pk, legacy_user_id, reason, raw_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      reason = excluded.reason,
      raw_json = excluded.raw_json
  `);

  function quarantine(tableName, row, index, reason) {
    const pk = legacyPk(row, tableName, index);
    const userId = legacyUserId(row);
    insertQuarantine.run(
      stableId('quarantine', SOURCE_SYSTEM, tableName, userId, pk),
      tableName,
      pk,
      userId,
      reason,
      JSON.stringify(row),
    );
  }

  const getCategoryById = db.prepare(`
    SELECT id, label FROM categories WHERE id = ?
  `);
  const getActiveCategoryByLabel = db.prepare(`
    SELECT id, label FROM categories
    WHERE lower(label) = lower(?) AND deleted_at IS NULL
  `);
  const upsertCategory = db.prepare(`
    INSERT INTO categories (
      id, label, tint, parent_id, is_system, catalog_version, updated_at, deleted_at
    ) VALUES (?, ?, ?, NULL, ?, 1, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      tint = excluded.tint,
      is_system = excluded.is_system,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `);
  const insertArchivedCategory = db.prepare(`
    INSERT INTO categories (
      id, label, tint, parent_id, is_system, catalog_version, updated_at, deleted_at
    ) VALUES (?, ?, NULL, NULL, 0, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      tint = excluded.tint,
      is_system = excluded.is_system,
      updated_at = CASE
        WHEN categories.deleted_at IS NULL THEN excluded.updated_at
        ELSE categories.updated_at
      END,
      deleted_at = coalesce(categories.deleted_at, excluded.deleted_at)
  `);
  const updateCategoryParent = db.prepare(`
    UPDATE categories SET parent_id = ? WHERE id = ?
  `);

  const sourceImported = Object.fromEntries(Object.keys(sourceFiles).map((name) => [name, 0]));
  const legacyParentTotals = new Map();
  const categoryIdMap = new Map();
  const categoryCandidates = [];

  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const [index, row] of input.spend_categories.entries()) {
      const tableName = 'spend_categories';
      if (!isRecord(row)) {
        quarantine(tableName, row, index, 'row must be a JSON object');
        continue;
      }

      const userId = legacyUserId(row);
      if (userId !== PRIMARY_IDENTITY) {
        quarantine(tableName, row, index, 'orphan category excluded by identity policy');
        continue;
      }

      try {
        categoryCandidates.push({
          sourceIndex: index,
          sourceRow: row,
          id: requiredString(row.id, 'id'),
          label: requiredString(row.label, 'label'),
          tint: optionalString(row.tint, 'tint'),
          parentId: optionalString(row.parent_id, 'parent_id'),
          isSystem: booleanInteger(row.is_system, 'is_system'),
          updatedAt: epochMilliseconds(row.updated_at, 'updated_at'),
        });
      } catch (error) {
        if (!(error instanceof MappingError)) throw error;
        quarantine(tableName, row, index, error.message);
      }
    }

    const candidateIds = new Set(categoryCandidates.map((category) => category.id));
    const insertedCategories = [];

    for (const category of categoryCandidates) {
      try {
        if (
          category.parentId !== null &&
          !candidateIds.has(category.parentId) &&
          !getCategoryById.get(category.parentId)
        ) {
          throw new MappingError(`parent_id does not identify an importable category: ${category.parentId}`);
        }

        const sameId = getCategoryById.get(category.id);
        if (sameId && sameId.label.toLocaleLowerCase('en-US') !== category.label.toLocaleLowerCase('en-US')) {
          throw new MappingError(`category id ${category.id} is already used by a different label`);
        }

        const sameLabel = getActiveCategoryByLabel.get(category.label);
        if (sameLabel && sameLabel.id !== category.id) {
          throw new MappingError(`category label is already used by id ${sameLabel.id}`);
        }

        upsertCategory.run(
          category.id,
          category.label,
          category.tint,
          category.isSystem,
          category.updatedAt,
        );
        categoryIdMap.set(category.id, category.id);
        insertedCategories.push(category);
        sourceImported.spend_categories += 1;
      } catch (error) {
        if (!(error instanceof MappingError)) throw error;
        quarantine('spend_categories', category.sourceRow, category.sourceIndex, error.message);
      }
    }

    for (const category of insertedCategories) {
      if (category.parentId === null) continue;
      const mappedParentId = categoryIdMap.get(category.parentId) ?? category.parentId;
      if (!getCategoryById.get(mappedParentId)) {
        throw new Error(`mapped parent category disappeared: ${mappedParentId}`);
      }
      updateCategoryParent.run(mappedParentId, category.id);
    }

    const getOrigin = db.prepare(`
      SELECT transaction_id FROM migration_origin
      WHERE source_system = ? AND legacy_user_id = ? AND legacy_table = ? AND legacy_pk = ?
    `);
    const insertTransaction = db.prepare(`
      INSERT INTO transactions (
        id, occurred_at, received_at, accounting_month_key, amount_minor,
        direction, currency_code, merchant_raw, counterparty_key, channel,
        status, plan_type, reverses_transaction_id, revision, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, NULL)
    `);
    const insertAllocation = db.prepare(`
      INSERT INTO transaction_allocations (
        id, transaction_id, category_id, amount_minor, source, confidence, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)
    `);
    const observeCategory = db.prepare(`
      INSERT INTO category_memory (
        id, counterparty_key, category_id, observation_count,
        last_observed_at, provisional, updated_at
      ) VALUES (?, ?, ?, 1, ?, 0, ?)
      ON CONFLICT(counterparty_key, category_id) DO UPDATE SET
        observation_count = category_memory.observation_count + 1,
        last_observed_at = max(category_memory.last_observed_at, excluded.last_observed_at),
        provisional = 0,
        updated_at = max(category_memory.updated_at, excluded.updated_at)
    `);
    const insertOrigin = db.prepare(`
      INSERT INTO migration_origin (
        id, transaction_id, source_system, legacy_user_id,
        legacy_table, legacy_pk, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    function ensureTransactionCategory(transaction) {
      const existingByLabel = getActiveCategoryByLabel.get(transaction.categoryLabel);
      if (existingByLabel) return existingByLabel.id;

      // Orphan category source rows are never imported. A minimal derived category is
      // still required here because every labelled transaction must retain its allocation.
      let categoryId =
        transaction.userId === PRIMARY_IDENTITY && transaction.legacyCategoryId !== null
          ? transaction.legacyCategoryId
          : stableId('legacy-category', transaction.categoryLabel.toLocaleLowerCase('en-US'));

      const existingById = getCategoryById.get(categoryId);
      if (existingById) {
        if (
          existingById.label.toLocaleLowerCase('en-US') ===
          transaction.categoryLabel.toLocaleLowerCase('en-US')
        ) {
          return existingById.id;
        }
        categoryId = stableId(
          'legacy-category',
          transaction.categoryLabel.toLocaleLowerCase('en-US'),
          transaction.userId,
        );
        const fallback = getCategoryById.get(categoryId);
        if (
          fallback &&
          fallback.label.toLocaleLowerCase('en-US') !==
            transaction.categoryLabel.toLocaleLowerCase('en-US')
        ) {
          throw new MappingError(`cannot assign an unambiguous id to category ${transaction.categoryLabel}`);
        }
        if (fallback) return fallback.id;
      }

      upsertCategory.run(categoryId, transaction.categoryLabel, null, 0, transaction.updatedAt);
      if (transaction.userId === PRIMARY_IDENTITY && transaction.legacyCategoryId !== null) {
        categoryIdMap.set(transaction.legacyCategoryId, categoryId);
      }
      return categoryId;
    }

    function mapTransaction(row) {
      if (!isRecord(row)) throw new MappingError('row must be a JSON object');

      const userId = requiredString(row.user_id, 'user_id');
      const id = requiredString(row.id, 'id');
      const occurredAt = epochMilliseconds(row.occurred_at, 'occurred_at');
      const updatedAt = epochMilliseconds(row.updated_at, 'updated_at');
      const amountMinor = safeInteger(row.amount_minor, 'amount_minor');
      const mappedLegacyStatus = mapStatus(row.status);

      let currencyCode = row.currency_code;
      // The target schema's declared default is the lossless legacy default as well.
      if (currencyCode === null || currencyCode === undefined) currencyCode = 'INR';
      currencyCode = requiredString(currencyCode, 'currency_code');
      if (!/^[A-Z]{3}$/.test(currencyCode)) {
        throw new MappingError(`currency_code is not a three-letter uppercase code: ${currencyCode}`);
      }

      const categoryLabel =
        row.category_label === null || row.category_label === undefined
          ? null
          : requiredString(row.category_label, 'category_label');
      const legacyCategoryId =
        row.category_id === null || row.category_id === undefined
          ? null
          : requiredString(row.category_id, 'category_id');
      const counterpartyKey =
        row.source === 'sms'
          ? typeof row.description === 'string' && row.description.trim() !== ''
            ? buildCounterpartyKey(row.description)
            : null
          : optionalString(row.counterparty_key, 'counterparty_key');

      return {
        userId,
        legacyId: id,
        id: stableId('legacy-transaction', SOURCE_SYSTEM, userId, id),
        occurredAt,
        receivedAt: occurredAt,
        accountingMonthKey: accountingMonthKey(occurredAt),
        amountMinor,
        direction: mapDirection(row.direction),
        currencyCode,
        merchantRaw: optionalString(row.merchant_name, 'merchant_name'),
        counterpartyKey,
        channel: optionalString(row.channel, 'channel'),
        status: userId === PRIMARY_IDENTITY ? mappedLegacyStatus : 'ignored',
        planType: mapPlanType(row.plan_type),
        updatedAt,
        categoryLabel,
        legacyCategoryId,
        allocationSource: row.category_source === 'manual' ? 'manual' : 'migrated',
      };
    }

    for (const [index, row] of input.spend_transactions.entries()) {
      const tableName = 'spend_transactions';
      let transaction;
      try {
        transaction = mapTransaction(row);
      } catch (error) {
        if (!(error instanceof MappingError)) throw error;
        quarantine(tableName, row, index, error.message);
        continue;
      }

      const existingOrigin = getOrigin.get(
        SOURCE_SYSTEM,
        transaction.userId,
        tableName,
        transaction.legacyId,
      );
      if (existingOrigin) {
        sourceImported.spend_transactions += 1;
        continue;
      }

      db.exec('SAVEPOINT import_transaction;');
      try {
        insertTransaction.run(
          transaction.id,
          transaction.occurredAt,
          transaction.receivedAt,
          transaction.accountingMonthKey,
          transaction.amountMinor,
          transaction.direction,
          transaction.currencyCode,
          transaction.merchantRaw,
          transaction.counterpartyKey,
          transaction.channel,
          transaction.status,
          transaction.planType,
          transaction.updatedAt,
        );

        if (transaction.categoryLabel !== null) {
          const categoryId = ensureTransactionCategory(transaction);
          insertAllocation.run(
            stableId('legacy-allocation', transaction.id),
            transaction.id,
            categoryId,
            transaction.amountMinor,
            transaction.allocationSource,
            transaction.updatedAt,
          );

          if (
            transaction.allocationSource === 'manual' &&
            transaction.counterpartyKey !== null &&
            transaction.counterpartyKey.trim() !== '' &&
            !isLowSpecificityKey(transaction.counterpartyKey)
          ) {
            // The UNIQUE pair stores one distribution bucket. Each manual allocation
            // starts at one observation, and repeated observations increment that bucket.
            observeCategory.run(
              stableId('category-memory', transaction.counterpartyKey, categoryId),
              transaction.counterpartyKey,
              categoryId,
              transaction.occurredAt,
              transaction.updatedAt,
            );
          }
        }

        insertOrigin.run(
          stableId('migration-origin', SOURCE_SYSTEM, transaction.userId, tableName, transaction.legacyId),
          transaction.id,
          SOURCE_SYSTEM,
          transaction.userId,
          tableName,
          transaction.legacyId,
          Date.now(),
        );
        db.exec('RELEASE import_transaction;');
        sourceImported.spend_transactions += 1;
      } catch (error) {
        db.exec('ROLLBACK TO import_transaction;');
        db.exec('RELEASE import_transaction;');
        if (error instanceof MappingError) {
          quarantine(tableName, row, index, error.message);
          continue;
        }
        throw error;
      }
    }

    for (const [index, row] of input.spend_monthly_budgets.entries()) {
      const tableName = 'spend_monthly_budgets';
      if (!isRecord(row)) {
        quarantine(tableName, row, index, 'row must be a JSON object');
        continue;
      }
      if (legacyUserId(row) !== PRIMARY_IDENTITY) {
        quarantine(tableName, row, index, 'orphan overall monthly budget excluded by identity policy');
        continue;
      }

      try {
        const monthKey = validateMonthKey(row.month_key);
        const amountMinor = safeInteger(row.amount_minor, 'amount_minor');
        epochMilliseconds(row.updated_at, 'updated_at');
        legacyParentTotals.set(monthKey, amountMinor);
        // v1 intentionally has category budgets only. Inventing a synthetic category
        // would change the meaning of an overall monthly cap, so preserve it verbatim.
        quarantine(tableName, row, index, 'overall monthly budget has no lossless v1 mapping');
      } catch (error) {
        if (!(error instanceof MappingError)) throw error;
        quarantine(tableName, row, index, error.message);
      }
    }

    const upsertBudget = db.prepare(`
      INSERT INTO budgets (month_key, category_id, amount_minor, recurring, updated_at)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(month_key, category_id) DO UPDATE SET
        amount_minor = excluded.amount_minor,
        recurring = excluded.recurring,
        updated_at = excluded.updated_at
    `);

    for (const [index, row] of input.spend_monthly_category_budgets.entries()) {
      const tableName = 'spend_monthly_category_budgets';
      if (!isRecord(row)) {
        quarantine(tableName, row, index, 'row must be a JSON object');
        continue;
      }
      if (legacyUserId(row) !== PRIMARY_IDENTITY) {
        quarantine(tableName, row, index, 'orphan category budget excluded by identity policy');
        continue;
      }

      try {
        const monthKey = validateMonthKey(row.month_key);
        const legacyCategoryId = requiredString(row.category_id, 'category_id');
        const amountMinor = safeInteger(row.amount_minor, 'amount_minor');
        const updatedAt = epochMilliseconds(row.updated_at, 'updated_at');
        const categoryId = categoryIdMap.get(legacyCategoryId) ?? legacyCategoryId;

        if (!exportedCategoryIds.has(legacyCategoryId)) {
          // Archived categories stay out of category pickers, while their historical
          // budgets remain joinable and render with the recovered category label.
          insertArchivedCategory.run(
            legacyCategoryId,
            archivedCategoryLabel(legacyCategoryId),
            importTimestamp,
            importTimestamp,
          );
          quarantine(
            tableName,
            row,
            index,
            'recovered archived category from orphaned budget',
          );
        }

        if (!getCategoryById.get(categoryId)) {
          throw new MappingError(`category budget references unknown category_id: ${legacyCategoryId}`);
        }

        // Legacy category budgets had no recurring flag, so the v1 default is explicit.
        upsertBudget.run(monthKey, categoryId, amountMinor, updatedAt);
        sourceImported.spend_monthly_category_budgets += 1;
      } catch (error) {
        if (!(error instanceof MappingError)) throw error;
        quarantine(tableName, row, index, error.message);
      }
    }

    db.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly();
    throw error;
  }

  const destinationTables = [
    'transactions',
    'transaction_allocations',
    'categories',
    'category_memory',
    'budgets',
    'source_alerts',
    'possible_matches',
    'suggestions',
    'outbox',
    'migration_origin',
    'quarantine',
  ];

  console.log('=== LEGACY IMPORT VERIFICATION REPORT ===');
  console.log(`Export directory: ${exportDir}`);
  console.log(`Output database: ${outputDbPath}`);
  console.log('Source rows mapped into v1:');
  for (const tableName of Object.keys(sourceFiles)) {
    console.log(
      `  ${tableName}: ${sourceImported[tableName]} / ${input[tableName].length}`,
    );
  }

  console.log('Destination row counts:');
  for (const tableName of destinationTables) {
    const count = Number(db.prepare(`SELECT count(*) AS count FROM ${tableName}`).get().count);
    console.log(`  ${tableName}: ${count}`);
  }

  console.log('Transactions per legacy identity:');
  const identityCounts = db.prepare(`
    SELECT legacy_user_id, count(*) AS count
    FROM migration_origin
    WHERE source_system = ? AND legacy_table = 'spend_transactions'
    GROUP BY legacy_user_id
    ORDER BY legacy_user_id
  `).all(SOURCE_SYSTEM);
  for (const row of identityCounts) {
    const identityKind = row.legacy_user_id === PRIMARY_IDENTITY ? 'primary' : 'orphan';
    console.log(`  ${row.legacy_user_id} (${identityKind}): ${row.count}`);
  }

  const quarantineCount = Number(
    db.prepare('SELECT count(*) AS count FROM quarantine').get().count,
  );
  console.log(`Quarantined rows: ${quarantineCount}`);
  const quarantineReasons = db.prepare(`
    SELECT reason, count(*) AS count
    FROM quarantine
    GROUP BY reason
    ORDER BY reason
  `).all();
  for (const row of quarantineReasons) {
    console.log(`  ${row.count} x ${row.reason}`);
  }

  const memory = db.prepare(`
    SELECT count(*) AS rows, coalesce(sum(observation_count), 0) AS observations
    FROM category_memory
  `).get();
  console.log(`Category-memory rows created: ${memory.rows}`);
  console.log(`Category-memory observations represented: ${memory.observations}`);

  const tierZeroSummary = db.prepare(`
    SELECT
      count(*) AS memory_rows,
      count(DISTINCT counterparty_key) AS distinct_keys
    FROM category_memory
  `).get();
  const conflictingKeys = db.prepare(`
    SELECT counterparty_key, count(DISTINCT category_id) AS category_count
    FROM category_memory
    GROUP BY counterparty_key
    HAVING count(DISTINCT category_id) > 1
    ORDER BY category_count DESC, counterparty_key ASC
  `).all();
  const getImportedTransactionKey = db.prepare(`
    SELECT transactions.counterparty_key
    FROM migration_origin
    JOIN transactions ON transactions.id = migration_origin.transaction_id
    WHERE migration_origin.source_system = ?
      AND migration_origin.legacy_table = 'spend_transactions'
      AND migration_origin.legacy_user_id = ?
      AND migration_origin.legacy_pk = ?
  `);
  let smsTransactionCount = 0;
  let nullDerivedKeyCount = 0;
  const derivedNamespaceCounts = { vpa: 0, merchant: 0, card: 0 };

  for (const row of input.spend_transactions) {
    if (!isRecord(row) || row.source !== 'sms') continue;
    if (typeof row.user_id !== 'string' || typeof row.id !== 'string') continue;

    const imported = getImportedTransactionKey.get(SOURCE_SYSTEM, row.user_id, row.id);
    if (!imported) continue;

    smsTransactionCount += 1;
    if (imported.counterparty_key === null) {
      nullDerivedKeyCount += 1;
      continue;
    }

    for (const namespace of Object.keys(derivedNamespaceCounts)) {
      if (imported.counterparty_key.startsWith(`${namespace}:`)) {
        derivedNamespaceCounts[namespace] += 1;
        break;
      }
    }
  }

  const nullDerivedKeyPercentage =
    smsTransactionCount === 0
      ? '0.00'
      : ((nullDerivedKeyCount / smsTransactionCount) * 100).toFixed(2);

  console.log('Tier-0 corpus quality:');
  console.log(`  category_memory rows: ${tierZeroSummary.memory_rows}`);
  console.log(`  DISTINCT counterparty keys: ${tierZeroSummary.distinct_keys}`);
  console.log(`  CONFLICT keys: ${conflictingKeys.length}`);
  console.log('  Worst 5 conflicting keys:');
  if (conflictingKeys.length === 0) {
    console.log('    (none)');
  } else {
    for (const row of conflictingKeys.slice(0, 5)) {
      console.log(`    ${row.counterparty_key}: ${row.category_count} categories`);
    }
  }
  console.log(
    `  Derived key NULL: ${nullDerivedKeyCount} / ${smsTransactionCount} SMS transactions (${nullDerivedKeyPercentage}%)`,
  );
  console.log('  Derived SMS transaction keys by namespace:');
  console.log(`    vpa: ${derivedNamespaceCounts.vpa}`);
  console.log(`    merchant: ${derivedNamespaceCounts.merchant}`);
  console.log(`    card: ${derivedNamespaceCounts.card}`);
  console.log(`CONFLICTS: 11 -> ${conflictingKeys.length}`);

  console.log('Budget reconciliation by month:');
  const getBudgetTotal = db.prepare(`
    SELECT coalesce(sum(amount_minor), 0) AS total
    FROM budgets
    WHERE month_key = ?
  `);
  let budgetsReconcile = true;
  for (const [monthKey, legacyParentTotal] of [...legacyParentTotals].sort()) {
    const categoryBudgetTotal = Number(getBudgetTotal.get(monthKey).total);
    const status = categoryBudgetTotal === legacyParentTotal ? 'PASS' : 'MISMATCH';
    console.log(
      `  ${monthKey}: ${status} (category sum ${categoryBudgetTotal}; legacy parent ${legacyParentTotal})`,
    );
    budgetsReconcile &&= categoryBudgetTotal === legacyParentTotal;
  }
  if (!budgetsReconcile) process.exitCode = 1;

  const reconciliation = db.prepare(`
    SELECT count(*) AS count, coalesce(sum(t.amount_minor), 0) AS total
    FROM transactions t
    JOIN migration_origin origin ON origin.transaction_id = t.id
    WHERE origin.source_system = ?
      AND origin.legacy_table = 'spend_transactions'
      AND origin.legacy_user_id = ?
      AND t.direction = 'debit'
      AND t.status = 'posted'
      AND t.deleted_at IS NULL
  `).get(SOURCE_SYSTEM, PRIMARY_IDENTITY);

  const debitCount = Number(reconciliation.count);
  const debitTotal = Number(reconciliation.total);
  console.log(
    `Primary active debits: ${debitCount} rows totaling ${debitTotal} minor units`,
  );

  if (debitCount === EXPECTED_ACTIVE_DEBITS && debitTotal === EXPECTED_ACTIVE_DEBIT_TOTAL) {
    console.log('PASS: primary active-debit reconciliation matches 178 / 6751207.');
  } else {
    console.error(
      `!!! FAIL: PRIMARY RECONCILIATION FAILED — expected ${EXPECTED_ACTIVE_DEBITS} / ${EXPECTED_ACTIVE_DEBIT_TOTAL}, got ${debitCount} / ${debitTotal} !!!`,
    );
    process.exitCode = 1;
  }
} finally {
  db.close();
}
