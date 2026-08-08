import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';

import {
  AllocationInvariantError,
  ConflictError,
  createNodeCoordinator,
} from '../src/db/coordinator.ts';

function newDatabasePath(label) {
  return join(mkdtempSync(join(tmpdir(), `spend-${label}-`)), 'spend.sqlite');
}

function freshCoordinator(label) {
  const dbPath = newDatabasePath(label);
  return {dbPath, coordinator: createNodeCoordinator(dbPath)};
}

async function createCategory(coordinator, label = 'Food') {
  const categoryId = randomUUID();
  await coordinator.execute({
    commandId: randomUUID(),
    kind: 'createCategory',
    payload: {categoryId, label},
  });
  return categoryId;
}

async function createTransaction(
  coordinator,
  {amountMinor = 10_000, counterpartyKey = 'merchant:test', id = randomUUID()} = {},
) {
  const alertId = randomUUID();
  await coordinator.execute({
    commandId: randomUUID(),
    kind: 'createTransactionFromAlert',
    payload: {
      alert: {
        id: alertId,
        rawSender: 'BANK',
        rawBody: 'Paid Rs.100',
        receivedAt: Date.UTC(2026, 7, 8),
        providerMessageId: randomUUID(),
      },
      transaction: {
        id,
        occurredAt: Date.UTC(2026, 7, 8),
        receivedAt: Date.UTC(2026, 7, 8),
        accountingMonthKey: '2026-08',
        amountMinor,
        direction: 'debit',
        merchantRaw: 'Test Merchant',
        counterpartyKey,
        channel: 'upi',
      },
    },
  });
  return {transactionId: id, alertId};
}

function installTrigger(dbPath, sql) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

test('connection setup enables WAL, foreign keys, and a busy timeout', async () => {
  const {coordinator} = freshCoordinator('pragmas');

  const [journal] = await coordinator.query('PRAGMA journal_mode');
  const [foreignKeys] = await coordinator.query('PRAGMA foreign_keys');
  const [busyTimeout] = await coordinator.query('PRAGMA busy_timeout');

  assert.equal(journal.journal_mode, 'wal');
  assert.equal(foreignKeys.foreign_keys, 1);
  assert.ok(busyTimeout.timeout >= 1_000);
});

test('query is read-only and cannot bypass the command writer', async () => {
  const {coordinator} = freshCoordinator('readonly-query');

  await assert.rejects(
    coordinator.query("INSERT INTO categories (id, label, updated_at) VALUES ('x', 'X', 0)"),
    /not authorized/,
  );
  const [count] = await coordinator.query('SELECT count(*) AS count FROM categories');
  assert.equal(count.count, 0);
});

test('50 concurrent commands are serialized without SQLITE_BUSY', async () => {
  const {coordinator} = freshCoordinator('concurrency');
  const firstCategoryId = await createCategory(coordinator, 'First');
  const secondCategoryId = await createCategory(coordinator, 'Second');
  const {transactionId} = await createTransaction(coordinator);

  const commands = Array.from({length: 50}, (_, index) => ({
    commandId: randomUUID(),
    kind: 'assignCategory',
    expectedRevision: index + 1,
    payload: {
      transactionId,
      categoryId: index % 2 === 0 ? firstCategoryId : secondCategoryId,
      source: 'manual',
    },
  }));

  const results = await Promise.all(commands.map(command => coordinator.execute(command)));
  assert.equal(results.length, 50);
  assert.ok(results.every(result => result.status === 'applied'));

  const [transaction] = await coordinator.query(
    'SELECT amount_minor, revision FROM transactions WHERE id = ?',
    [transactionId],
  );
  const [allocation] = await coordinator.query(
    `SELECT category_id, source, sum(amount_minor) AS allocated
     FROM transaction_allocations WHERE transaction_id = ?`,
    [transactionId],
  );
  assert.equal(transaction.revision, 51);
  assert.equal(allocation.category_id, secondCategoryId);
  assert.equal(allocation.source, 'manual');
  assert.equal(allocation.allocated, transaction.amount_minor);
});

test('coordinators opened twice for one path share the write queue', async () => {
  const dbPath = newDatabasePath('shared-queue');
  const first = createNodeCoordinator(dbPath);
  const second = createNodeCoordinator(dbPath);
  const categoryId = await createCategory(first);
  const {transactionId} = await createTransaction(first);

  const commands = Array.from({length: 20}, (_, index) => ({
    commandId: randomUUID(),
    kind: 'assignCategory',
    expectedRevision: index + 1,
    payload: {transactionId, categoryId, source: 'manual'},
  }));
  await Promise.all(
    commands.map((command, index) =>
      (index % 2 === 0 ? first : second).execute(command),
    ),
  );

  const [transaction] = await second.query(
    'SELECT revision FROM transactions WHERE id = ?',
    [transactionId],
  );
  assert.equal(transaction.revision, 21);
});

test('a late command failure rolls back domain, allocation, memory, outbox, and log', async () => {
  const {dbPath, coordinator} = freshCoordinator('atomicity');
  const categoryId = await createCategory(coordinator);
  const {transactionId} = await createTransaction(coordinator, {
    counterpartyKey: 'merchant:atomic',
  });
  installTrigger(
    dbPath,
    `CREATE TRIGGER force_category_memory_failure
     BEFORE INSERT ON category_memory
     WHEN NEW.counterparty_key = 'merchant:atomic'
     BEGIN
       SELECT RAISE(ABORT, 'forced mid-command failure');
     END`,
  );

  const commandId = randomUUID();
  await assert.rejects(
    coordinator.execute({
      commandId,
      kind: 'assignCategory',
      expectedRevision: 1,
      payload: {transactionId, categoryId, source: 'manual'},
    }),
    /forced mid-command failure/,
  );

  const [transaction] = await coordinator.query(
    'SELECT revision FROM transactions WHERE id = ?',
    [transactionId],
  );
  const [allocation] = await coordinator.query(
    `SELECT category_id, source, amount_minor
     FROM transaction_allocations WHERE transaction_id = ?`,
    [transactionId],
  );
  const [counts] = await coordinator.query(
    `SELECT
       (SELECT count(*) FROM category_memory) AS memories,
       (SELECT count(*) FROM outbox WHERE id = ?) AS outbox_rows,
       (SELECT count(*) FROM processed_commands WHERE command_id = ?) AS command_rows`,
    [commandId, commandId],
  );

  assert.equal(transaction.revision, 1);
  assert.equal(allocation.category_id, null);
  assert.equal(allocation.source, 'rule');
  assert.deepEqual({...counts}, {memories: 0, outbox_rows: 0, command_rows: 0});
});

test('replaying a commandId returns its original result exactly once', async () => {
  const {coordinator} = freshCoordinator('idempotency');
  const categoryId = await createCategory(coordinator);
  const {transactionId} = await createTransaction(coordinator);
  const command = {
    commandId: randomUUID(),
    kind: 'assignCategory',
    expectedRevision: 1,
    payload: {transactionId, categoryId, source: 'manual'},
  };

  const first = await coordinator.execute(command);
  const replay = await coordinator.execute(command);
  assert.deepEqual(replay, first);

  const [state] = await coordinator.query(
    `SELECT
       (SELECT revision FROM transactions WHERE id = ?) AS revision,
       (SELECT count(*) FROM outbox WHERE id = ?) AS outbox_rows,
       (SELECT count(*) FROM processed_commands WHERE command_id = ?) AS command_rows,
       (SELECT observation_count FROM category_memory LIMIT 1) AS observations`,
    [transactionId, command.commandId, command.commandId],
  );
  assert.deepEqual(
    {...state},
    {revision: 2, outbox_rows: 1, command_rows: 1, observations: 1},
  );
});

test('a stale expectedRevision throws ConflictError and changes nothing', async () => {
  const {coordinator} = freshCoordinator('conflict');
  const categoryId = await createCategory(coordinator);
  const {transactionId} = await createTransaction(coordinator);
  await coordinator.execute({
    commandId: randomUUID(),
    kind: 'assignCategory',
    expectedRevision: 1,
    payload: {transactionId, categoryId, source: 'manual'},
  });

  const staleCommandId = randomUUID();
  await assert.rejects(
    coordinator.execute({
      commandId: staleCommandId,
      kind: 'setPlanType',
      expectedRevision: 1,
      payload: {transactionId, planType: 'unplanned'},
    }),
    error => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.expectedRevision, 1);
      assert.equal(error.actualRevision, 2);
      return true;
    },
  );

  const [state] = await coordinator.query(
    `SELECT revision, plan_type,
       (SELECT count(*) FROM outbox WHERE id = ?) AS outbox_rows,
       (SELECT count(*) FROM processed_commands WHERE command_id = ?) AS command_rows
     FROM transactions WHERE id = ?`,
    [staleCommandId, staleCommandId, transactionId],
  );
  assert.deepEqual(
    {...state},
    {revision: 2, plan_type: 'planned', outbox_rows: 0, command_rows: 0},
  );
});

test('machine provenance cannot overwrite a manual allocation', async () => {
  const {coordinator} = freshCoordinator('provenance');
  const manualCategoryId = await createCategory(coordinator, 'Manual');
  const machineCategoryId = await createCategory(coordinator, 'Machine');
  const {transactionId} = await createTransaction(coordinator);
  await coordinator.execute({
    commandId: randomUUID(),
    kind: 'assignCategory',
    expectedRevision: 1,
    payload: {
      transactionId,
      categoryId: manualCategoryId,
      source: 'manual',
    },
  });

  const machineCommandId = randomUUID();
  const result = await coordinator.execute({
    commandId: machineCommandId,
    kind: 'assignCategory',
    expectedRevision: 2,
    payload: {
      transactionId,
      categoryId: machineCategoryId,
      source: 'llm',
      confidence: 0.99,
    },
  });
  assert.deepEqual(result, {
    commandId: machineCommandId,
    kind: 'assignCategory',
    status: 'noop',
    entityId: transactionId,
    revision: 2,
    reason: 'manual_provenance',
  });

  const [allocation] = await coordinator.query(
    `SELECT category_id, source,
       (SELECT revision FROM transactions WHERE id = ?) AS transaction_revision,
       (SELECT count(*) FROM outbox WHERE id = ?) AS machine_outbox_rows,
       (SELECT count(*) FROM processed_commands WHERE command_id = ?) AS machine_log_rows
     FROM transaction_allocations WHERE transaction_id = ?`,
    [transactionId, machineCommandId, machineCommandId, transactionId],
  );
  assert.deepEqual(
    {...allocation},
    {
      category_id: manualCategoryId,
      source: 'manual',
      transaction_revision: 2,
      machine_outbox_rows: 0,
      machine_log_rows: 1,
    },
  );
});

test('allocation sum invariant aborts a command that would over-allocate', async () => {
  const {dbPath, coordinator} = freshCoordinator('allocation-invariant');
  const transactionId = randomUUID();
  const extraAllocationId = randomUUID();
  installTrigger(
    dbPath,
    `CREATE TRIGGER force_overallocation
     AFTER INSERT ON transaction_allocations
     WHEN NEW.transaction_id = '${transactionId}' AND NEW.id <> '${extraAllocationId}'
     BEGIN
       INSERT INTO transaction_allocations (
         id, transaction_id, category_id, amount_minor, source, updated_at
       ) VALUES (
         '${extraAllocationId}', NEW.transaction_id, NEW.category_id, 1, 'rule', NEW.updated_at
       );
     END`,
  );

  const commandId = randomUUID();
  const alertId = randomUUID();
  await assert.rejects(
    coordinator.execute({
      commandId,
      kind: 'createTransactionFromAlert',
      payload: {
        alert: {id: alertId, receivedAt: Date.now()},
        transaction: {
          id: transactionId,
          occurredAt: Date.now(),
          receivedAt: Date.now(),
          accountingMonthKey: '2026-08',
          amountMinor: 10_000,
          direction: 'debit',
        },
      },
    }),
    error => error instanceof AllocationInvariantError,
  );

  const [counts] = await coordinator.query(
    `SELECT
       (SELECT count(*) FROM transactions WHERE id = ?) AS transactions,
       (SELECT count(*) FROM source_alerts WHERE id = ?) AS alerts,
       (SELECT count(*) FROM transaction_allocations WHERE transaction_id = ?) AS allocations,
       (SELECT count(*) FROM outbox WHERE id = ?) AS outbox_rows,
       (SELECT count(*) FROM processed_commands WHERE command_id = ?) AS command_rows`,
    [transactionId, alertId, transactionId, commandId, commandId],
  );
  assert.deepEqual(
    {...counts},
    {transactions: 0, alerts: 0, allocations: 0, outbox_rows: 0, command_rows: 0},
  );
});

test('version-1 databases migrate to 2 before serving queries', async () => {
  const dbPath = newDatabasePath('migration-v1');
  const versionOne = new DatabaseSync(dbPath);
  versionOne.exec(readFileSync(new URL('../db/migrations/001_initial.sql', import.meta.url), 'utf8'));
  versionOne.close();

  const coordinator = createNodeCoordinator(dbPath);
  const [version] = await coordinator.query('PRAGMA user_version');
  const commandLogColumns = await coordinator.query(
    "SELECT name FROM pragma_table_info('processed_commands') ORDER BY cid",
  );

  assert.equal(version.user_version, 2);
  assert.deepEqual(
    commandLogColumns.map(column => column.name),
    ['command_id', 'kind', 'result_json', 'created_at'],
  );
});

test('a database from a future schema version is refused, never reset', () => {
  const dbPath = newDatabasePath('migration-future');
  const future = new DatabaseSync(dbPath);
  future.exec('PRAGMA user_version = 99');
  future.close();

  assert.throws(
    () => createNodeCoordinator(dbPath),
    /user_version 99 is newer than supported version 2/,
  );

  const unchanged = new DatabaseSync(dbPath);
  const version = unchanged.prepare('PRAGMA user_version').get().user_version;
  unchanged.close();
  assert.equal(version, 99);
});
