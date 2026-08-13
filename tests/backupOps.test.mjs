import test from 'node:test';
import assert from 'node:assert/strict';
import {deterministicOpId, transactionToBackupOps} from '../src/sync/backupOps.ts';

const baseRow = {
  id: 'tx-1',
  occurred_at: 1_700_000_000_000,
  received_at: 1_700_000_100_000,
  accounting_month_key: '2026-08',
  amount_minor: 4200,
  direction: 'debit',
  currency_code: 'INR',
  merchant_raw: 'Cafe Madras',
  counterparty_key: 'merchant:cafe-madras',
  channel: 'upi',
  status: 'posted',
  plan_type: 'planned',
};

test('a transaction with no alert synthesizes one from the merchant', () => {
  const [create] = transactionToBackupOps(baseRow);
  assert.equal(create.kind, 'createTransactionFromAlert');
  assert.equal(create.entity, 'transactions');
  assert.equal(create.entityId, 'tx-1');
  assert.equal(create.action, 'upsert');
  assert.equal(create.opId, deterministicOpId('transactions', 'tx-1'));
  assert.deepEqual(create.payload.alert, {
    id: 'tx-1:alert',
    receivedAt: 1_700_000_100_000,
    parseStatus: 'parsed',
    rawBody: 'Cafe Madras',
  });
  assert.equal(create.payload.transaction.id, 'tx-1');
  assert.equal(create.payload.transaction.planType, 'planned');
  assert.equal(create.payload.allocation, undefined);
  assert.equal(create.expectedRevision, undefined);
  assert.equal(transactionToBackupOps(baseRow).length, 1);
});

test('exactly one allocation rides on the create payload', () => {
  const [create, ...rest] = transactionToBackupOps({
    ...baseRow,
    alert: {
      id: 'alert-1',
      raw_sender: 'BANK',
      raw_body: 'INR 42.00 paid at Cafe Madras',
      received_at: 1_700_000_050_000,
      provider_message_id: 'sms-9',
      subscription_id: 3,
      bank_reference: 'UPI123',
      parse_status: 'parsed',
    },
    allocations: [{
      id: 'alloc-1',
      category_id: 'custom:food',
      amount_minor: 4200,
      source: 'manual',
      confidence: 1,
    }],
  });
  assert.equal(rest.length, 0);
  assert.deepEqual(create.payload.alert, {
    id: 'alert-1',
    rawSender: 'BANK',
    rawBody: 'INR 42.00 paid at Cafe Madras',
    receivedAt: 1_700_000_050_000,
    providerMessageId: 'sms-9',
    subscriptionId: 3,
    bankReference: 'UPI123',
    parseStatus: 'parsed',
  });
  assert.deepEqual(create.payload.allocation, {
    id: 'alloc-1',
    categoryId: 'custom:food',
    source: 'manual',
    confidence: 1,
  });
  assert.equal(create.payload.transaction.merchantRaw, 'Cafe Madras');
});

test('two allocations become a create followed by a split', () => {
  const ops = transactionToBackupOps({
    ...baseRow,
    allocations: [
      {id: 'a-food', category_id: 'custom:food', amount_minor: 2500, source: 'manual'},
      {id: 'a-fun', category_id: 'custom:fun', amount_minor: 1700, source: 'manual'},
    ],
  });
  assert.equal(ops.length, 2);
  assert.equal(ops[0].kind, 'createTransactionFromAlert');
  assert.equal(ops[0].payload.allocation, undefined);
  assert.equal(ops[1].kind, 'splitTransaction');
  assert.equal(ops[1].opId, deterministicOpId('transactions', 'tx-1:split'));
  assert.equal(ops[1].expectedRevision, undefined);
  assert.deepEqual(ops[1].payload, {
    transactionId: 'tx-1',
    allocations: [
      {categoryId: 'custom:food', amountMinor: 2500, allocationId: 'a-food'},
      {categoryId: 'custom:fun', amountMinor: 1700, allocationId: 'a-fun'},
    ],
  });
});

test('an ignored transaction adds ignoreTransaction after create', () => {
  const ops = transactionToBackupOps({...baseRow, status: 'ignored'});
  assert.equal(ops.length, 2);
  assert.equal(ops[0].payload.transaction.status, 'ignored');
  assert.equal(ops[1].kind, 'ignoreTransaction');
  assert.equal(ops[1].opId, deterministicOpId('transactions', 'tx-1:ignore'));
  assert.deepEqual(ops[1].payload, {transactionId: 'tx-1'});
  assert.equal(ops[1].expectedRevision, undefined);
});

test('unplanned planType stays on create and does not add a second op', () => {
  const ops = transactionToBackupOps({...baseRow, plan_type: 'unplanned'});
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'createTransactionFromAlert');
  assert.equal(ops[0].payload.transaction.planType, 'unplanned');
});
