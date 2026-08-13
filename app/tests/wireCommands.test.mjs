import test from 'node:test';
import assert from 'node:assert/strict';
import {nextPullCursor, normalizeRemoteCommand, wireOperationId} from '../src/sync/wireCommands.ts';

// A row as the server returns it from /v1/sync/pull.
const pulled = (entity, action, fields, entityId = 'e-1') => ({
  server_seq: 1,
  applied: true,
  op_id: '11111111-1111-4111-8111-111111111111',
  entity_type: entity,
  entity_id: entityId,
  action,
  payload: {opId: '11111111-1111-4111-8111-111111111111', entity, entityId, action, fields},
});

test('a budget op with no kind becomes a setBudgetAmount command', () => {
  // Full backups and server-side repairs send {entity, action, fields} with no
  // command name. These used to normalise to kind:undefined and be dropped, so
  // a restored device showed its categories with every budget blank.
  const command = normalizeRemoteCommand(
    pulled('budgets', 'upsert', {monthKey: '2026-08', categoryId: 'custom:piano', amountMinor: 1600000, recurring: false}, '2026-08:custom:piano'));
  assert.equal(command.kind, 'setBudgetAmount');
  assert.equal(command.commandId, '11111111-1111-4111-8111-111111111111');
  assert.equal(command.payload.amountMinor, 1600000);
  assert.equal(command.payload.categoryId, 'custom:piano');
});

test('a deleted budget line becomes an amount of zero, not a cleared month', () => {
  const command = normalizeRemoteCommand(pulled('budgets', 'delete', undefined, '2026-08:custom:piano'));
  assert.equal(command.kind, 'setBudgetAmount');
  assert.equal(command.payload.monthKey, '2026-08');
  assert.equal(command.payload.categoryId, 'custom:piano');
  assert.equal(command.payload.amountMinor, 0);
});

test('a category op with no kind becomes createCategory, and a delete archives', () => {
  const created = normalizeRemoteCommand(
    pulled('categories', 'upsert', {categoryId: 'custom:piano', label: 'Piano'}, 'custom:piano'));
  assert.equal(created.kind, 'createCategory');
  assert.equal(created.payload.label, 'Piano');

  const archived = normalizeRemoteCommand(pulled('categories', 'delete', undefined, 'custom:piano'));
  assert.equal(archived.kind, 'archiveCategory');
  assert.equal(archived.payload.categoryId, 'custom:piano');
});

test('an op that already carries a kind is still translated by the original path', () => {
  const command = normalizeRemoteCommand({
    op_id: '22222222-2222-4222-8222-222222222222',
    entity_type: 'transactions',
    entity_id: 'sms:8393',
    action: 'upsert',
    payload: {
      kind: 'createTransactionFromAlert',
      opId: '22222222-2222-4222-8222-222222222222',
      fields: {transactionId: 'sms:8393', amountMinor: 42},
    },
  });
  assert.equal(command.kind, 'createTransactionFromAlert');
  assert.equal(command.payload.amountMinor, 42);
  assert.equal(command.expectedRevision, undefined);
});

test('a kind-less transaction upsert with alert and transaction becomes createTransactionFromAlert', () => {
  const command = normalizeRemoteCommand({
    entity_type: 'transactions',
    action: 'upsert',
    op_id: '33333333-3333-4333-8333-333333333333',
    entity_id: 'sms:8393',
    payload: {
      fields: {
        alert: {id: 'sms:8393:alert', receivedAt: 1, parseStatus: 'parsed'},
        transaction: {
          id: 'sms:8393',
          occurredAt: 1,
          receivedAt: 1,
          accountingMonthKey: '2026-08',
          amountMinor: 4200,
          direction: 'debit',
        },
      },
    },
  });
  assert.equal(command.kind, 'createTransactionFromAlert');
  assert.equal(command.commandId, '33333333-3333-4333-8333-333333333333');
  assert.equal(command.payload.alert.id, 'sms:8393:alert');
  assert.equal(command.payload.transaction.id, 'sms:8393');
  assert.equal(command.payload.transaction.amountMinor, 4200);
  assert.equal(command.expectedRevision, undefined);
});

test('an unrecognised transaction shape is left with kind undefined', () => {
  const command = normalizeRemoteCommand(
    pulled('transactions', 'upsert', {transactionId: 'sms:8393', amountMinor: 42}, 'sms:8393'));
  assert.equal(command.kind, undefined);
});

test('a kind-less split upsert becomes splitTransaction and ignore requires an ignore signal', () => {
  const split = normalizeRemoteCommand(pulled('transactions', 'upsert', {
    transactionId: 'sms:8393',
    allocations: [{categoryId: 'custom:food', amountMinor: 10, allocationId: 'a-1'}],
  }, 'sms:8393'));
  assert.equal(split.kind, 'splitTransaction');
  assert.equal(split.payload.transactionId, 'sms:8393');
  assert.equal(split.expectedRevision, undefined);

  const ignored = normalizeRemoteCommand(pulled('transactions', 'upsert', {
    transactionId: 'sms:8393',
    status: 'ignored',
  }, 'sms:8393'));
  assert.equal(ignored.kind, 'ignoreTransaction');
  assert.deepEqual(ignored.payload, {transactionId: 'sms:8393'});
});

test('an unrecognised entity is left alone rather than guessed at', () => {
  const command = normalizeRemoteCommand(pulled('suggestions', 'upsert', {suggestionId: 's-1'}, 's-1'));
  assert.equal(command.kind, undefined);
});

test('a numeric cursor from the server advances the pull', () => {
  // The server sends a number; the client stores text. Rejecting the number
  // froze the cursor, so the device re-pulled page one forever and never saw
  // the ops beyond it — the app reported a clean sync the whole time.
  assert.equal(nextPullCursor(1932, '500'), '1932');
  assert.equal(nextPullCursor('1932', '500'), '1932');
});

test('a cursor that does not move forward is ignored', () => {
  assert.equal(nextPullCursor(400, '500'), '500');
  assert.equal(nextPullCursor(-1, '500'), '500');
  assert.equal(nextPullCursor(undefined, '500'), '500');
  assert.equal(nextPullCursor(null, '500'), '500');
  assert.equal(nextPullCursor('', '500'), '500');
  assert.equal(nextPullCursor('nonsense', '500'), '500');
});

test('an empty starting cursor is treated as zero, not as text', () => {
  assert.equal(nextPullCursor(500, ''), '500');
  assert.equal(nextPullCursor(0, '0'), '0');
});

test('readable local command ids become stable UUIDs on the wire', () => {
  const first = wireOperationId('sms-transaction:8393');
  assert.equal(first, wireOperationId('sms-transaction:8393'));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, wireOperationId('sms-transaction:8394'));
});

test('valid UUID command ids are preserved on the wire', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(wireOperationId(id), id);
});
