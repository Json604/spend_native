import test from 'node:test';
import assert from 'node:assert/strict';
import { RefreshFamilyStore } from '../src/auth/refresh.ts';
import { applyFieldLww, computePullCursor } from '../src/sync/conflict.ts';
import { IdempotencyStore } from '../src/sync/idempotency.ts';
import { canonicalOpId, deriveOpId } from '../src/sync/opIds.ts';

test('reuse of a rotated refresh token revokes the whole family', () => {
  const store = new RefreshFamilyStore();
  const first = store.issue('user', 60_000);
  const second = store.rotate(first.token, 60_000);
  assert.throws(() => store.rotate(first.token, 60_000), /refresh_reuse_detected/);
  assert.equal(store.familyRevoked(first.record.familyId), true);
  assert.throws(() => store.rotate(second.token, 60_000), /refresh_reuse_detected/);
});

test('replaying an operation id is a no-op returning the original outcome', () => {
  const seen = new IdempotencyStore();
  let calls = 0;
  const first = seen.apply('op-1', () => { calls += 1; return { changed: ['amount'] }; });
  const replay = seen.apply('op-1', () => { calls += 1; return { changed: ['different'] }; });
  assert.deepEqual(replay, { outcome: first.outcome, replay: true });
  assert.equal(calls, 1);
});

test('per-field LWW resolves each field independently in server order', () => {
  let row;
  row = applyFieldLww(row, { opId: 'a', entity: 'transactions', entityId: 'x', action: 'upsert', fields: { amount: 10, note: 'old' } }, 1).row;
  row = applyFieldLww(row, { opId: 'b', entity: 'transactions', entityId: 'x', action: 'upsert', fields: { amount: 20 } }, 2).row;
  row = applyFieldLww(row, { opId: 'c', entity: 'transactions', entityId: 'x', action: 'upsert', fields: { note: 'new' } }, 3).row;
  assert.deepEqual(row.data, { amount: 20, note: 'new' });
  assert.equal(row.fieldClocks.amount.seq, 2);
  assert.equal(row.fieldClocks.note.seq, 3);
});

test('manual allocation survives a later machine-sourced operation', () => {
  const first = applyFieldLww(undefined, { opId: 'a', entity: 'transaction_allocations', entityId: 'x', action: 'upsert', source: 'manual', fields: { categoryId: 'food', source: 'manual' } }, 1).row;
  const later = applyFieldLww(first, { opId: 'b', entity: 'transaction_allocations', entityId: 'x', action: 'upsert', source: 'llm', fields: { categoryId: 'travel', source: 'llm' } }, 2);
  assert.equal(later.skipped, true);
  assert.equal(later.row.data.categoryId, 'food');
});

test('a newer upsert revives a soft-deleted row instead of writing to a ghost', () => {
  // The incident: a dedupe soft-deleted a category the device still believed in.
  // Every later write landed on an invisible row and the budget vanished.
  const deleted = applyFieldLww({ data: { label: 'Piano' }, fieldClocks: {}, deletedAt: '2026-08-08T04:00:00.000Z' },
    { opId: 'a', entity: 'categories', entityId: 'x', action: 'upsert', fields: { label: 'Piano' } }, 9);
  assert.equal(deleted.row.deletedAt, null);
  assert.ok(deleted.changed.includes('deleted_at'));
});

test('a tombstone still outranks a write that loses on every field', () => {
  const row = { data: { categoryId: 'food', source: 'manual' }, fieldClocks: { categoryId: { seq: 5, source: 'manual' } }, deletedAt: '2026-08-08T04:00:00.000Z' };
  const machineWrite = applyFieldLww(row,
    { opId: 'b', entity: 'transaction_allocations', entityId: 'x', action: 'upsert', source: 'llm', fields: { categoryId: 'travel', source: 'llm' } }, 11);
  assert.equal(machineWrite.skipped, true);
  assert.equal(machineWrite.row.deletedAt, '2026-08-08T04:00:00.000Z');
});

test('reviving a row does not let a machine source overwrite a manual field', () => {
  const row = { data: { categoryId: 'food', source: 'manual' }, fieldClocks: { categoryId: { seq: 5, source: 'manual' } }, deletedAt: '2026-08-08T04:00:00.000Z' };
  const revived = applyFieldLww(row,
    { opId: 'c', entity: 'transaction_allocations', entityId: 'x', action: 'upsert', fields: { note: 'hello', categoryId: { value: 'travel', source: 'llm' } } }, 12);
  assert.equal(revived.row.deletedAt, null);
  assert.equal(revived.row.data.categoryId, 'food');
  assert.equal(revived.row.data.note, 'hello');
});

test('cascade operation ids are deterministic, distinct, and valid uuids', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const first = deriveOpId('11111111-1111-4111-8111-111111111111', 'budgets', 'row-1');
  assert.match(first, uuid);
  assert.equal(first, deriveOpId('11111111-1111-4111-8111-111111111111', 'budgets', 'row-1'));
  assert.notEqual(first, deriveOpId('11111111-1111-4111-8111-111111111111', 'budgets', 'row-2'));
  assert.notEqual(first, deriveOpId('11111111-1111-4111-8111-111111111111', 'transaction_allocations', 'row-1'));
  assert.notEqual(first, deriveOpId('22222222-2222-4222-8222-222222222222', 'budgets', 'row-1'));
});

test('a tombstone propagates and cursor stops before an unapplied operation', () => {
  const row = applyFieldLww({ data: { amount: 4 }, fieldClocks: {}, deletedAt: null }, { opId: 'd', entity: 'transactions', entityId: 'x', action: 'delete' }, 7).row;
  assert.ok(row.deletedAt);
  assert.equal(computePullCursor([
    { serverSeq: 8, applied: true, value: 'a' },
    { serverSeq: 9, applied: false, value: 'b' },
    { serverSeq: 10, applied: true, value: 'c' }
  ], 7), 8);
});

// Builds up to 2.3.13 mint op ids with a signed-xor bug that emits a stray "-",
// e.g. `0552fd08-fa2a-5132-8-87-d3c6ff7dce3a`. Those installs are signed with a
// key that no longer exists, so they can never be updated: the server has to
// accept what they send. sync_ops.op_id is a Postgres uuid, so a malformed id
// is folded to a stable uuid rather than stored verbatim.
test('a malformed client op id folds to a stable uuid', () => {
  const malformed = '0552fd08-fa2a-5132-8-87-d3c6ff7dce3a';
  const folded = canonicalOpId(malformed);
  assert.match(folded, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Stable, or idempotency breaks and every retry duplicates the operation.
  assert.equal(folded, canonicalOpId(malformed));
  assert.notEqual(folded, canonicalOpId('615f861f-9eaf-595d-b0-f-00be000eff7c'));
});

test('a well-formed op id is left exactly as it is', () => {
  const valid = '11111111-1111-4111-8111-111111111111';
  assert.equal(canonicalOpId(valid), valid);
  // Fixed clients send real UUIDs; folding those would orphan existing rows.
  assert.equal(canonicalOpId(valid.toUpperCase()), valid.toUpperCase());
});

test('folding cannot collide with a uuid a client could legitimately send', () => {
  // The fold is derived through a distinct prefix, so no malformed id can be
  // engineered onto an existing op's row.
  const seen = new Set();
  for (let index = 0; index < 5_000; index += 1) {
    seen.add(canonicalOpId(`0552fd08-fa2a-5132-8-87-d3c6ff7dce${index}`));
  }
  assert.equal(seen.size, 5_000);
});
