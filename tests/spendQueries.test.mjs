import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {createNodeCoordinator} from '../src/db/coordinator.ts';
import {SqliteSpendRepository} from '../src/features/spend/store/sqliteRepository.ts';

function newDatabasePath(label) {
  return join(mkdtempSync(join(tmpdir(), `spend-${label}-`)), 'spend.sqlite');
}

function freshCoordinator(label) {
  const dbPath = newDatabasePath(label);
  return {dbPath, coordinator: createNodeCoordinator(dbPath)};
}

async function createCategory(coordinator, label) {
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
  {
    amountMinor,
    id = randomUUID(),
    occurredAt = Date.UTC(2026, 7, 10, 6, 0, 0),
    accountingMonthKey = '2026-08',
  },
) {
  const alertId = randomUUID();
  await coordinator.execute({
    commandId: randomUUID(),
    kind: 'createTransactionFromAlert',
    payload: {
      alert: {
        id: alertId,
        rawSender: 'BANK',
        rawBody: `Paid Rs.${amountMinor / 100}`,
        receivedAt: occurredAt,
        providerMessageId: randomUUID(),
      },
      transaction: {
        id,
        occurredAt,
        receivedAt: occurredAt,
        accountingMonthKey,
        amountMinor,
        direction: 'debit',
        merchantRaw: 'Test Merchant',
        counterpartyKey: `merchant:${id}`,
        channel: 'upi',
      },
    },
  });
  return id;
}

test('month and day spend sums use planned debits; lists keep one row per split', async () => {
  const {coordinator} = freshCoordinator('spend-queries');
  const repository = new SqliteSpendRepository(coordinator);

  const groceries = await createCategory(coordinator, 'Groceries');
  const household = await createCategory(coordinator, 'Household');

  const plannedAmountMinor = 10_000;
  const unplannedAmountMinor = 4_000;
  const splitAmountMinor = 15_000;
  const occurredAt = Date.UTC(2026, 7, 10, 6, 0, 0);

  const plannedId = await createTransaction(coordinator, {
    amountMinor: plannedAmountMinor,
    occurredAt,
  });
  const unplannedId = await createTransaction(coordinator, {
    amountMinor: unplannedAmountMinor,
    occurredAt,
  });
  const splitId = await createTransaction(coordinator, {
    amountMinor: splitAmountMinor,
    occurredAt,
  });

  await coordinator.execute({
    commandId: randomUUID(),
    kind: 'setPlanType',
    expectedRevision: 1,
    payload: {transactionId: unplannedId, planType: 'unplanned'},
  });
  await coordinator.execute({
    commandId: randomUUID(),
    kind: 'splitTransaction',
    expectedRevision: 1,
    payload: {
      transactionId: splitId,
      allocations: [
        {categoryId: groceries, amountMinor: 9_000},
        {categoryId: household, amountMinor: 6_000},
      ],
    },
  });

  const expectedSpentMinor = plannedAmountMinor + splitAmountMinor;
  const summary = await repository.monthSummary('2026-08');
  assert.equal(summary.totalSpentMinor, expectedSpentMinor);

  const dayBucket = (await repository.dailyBuckets('2026-08')).find(
    bucket => bucket.date === '2026-08-10',
  );
  assert.ok(dayBucket, '2026-08-10 must appear in dailyBuckets');
  assert.equal(dayBucket.amountMinor, expectedSpentMinor);
  assert.equal(dayBucket.amountMinor, summary.totalSpentMinor);

  const dayList = await repository.transactionsForDay('2026-08-10');
  assert.equal(dayList.length, 3);
  assert.deepEqual(
    new Set(dayList.map(transaction => transaction.id)),
    new Set([plannedId, unplannedId, splitId]),
  );
  assert.ok(
    dayList.some(transaction => transaction.id === unplannedId && transaction.planType === 'unplanned'),
    'day list includes unplanned debits even though sums exclude them',
  );

  const monthList = await repository.transactionsForMonth('2026-08');
  assert.equal(monthList.filter(transaction => transaction.direction === 'debit').length, 3);

  const review = await repository.needsReview('2026-08');
  assert.equal(
    review.some(transaction => transaction.id === splitId),
    false,
    'a fully allocated split must not appear in needsReview',
  );
  assert.ok(review.some(transaction => transaction.id === plannedId));
  assert.ok(review.some(transaction => transaction.id === unplannedId));
});
