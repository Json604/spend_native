import test from 'node:test';
import assert from 'node:assert/strict';
import { RefreshFamilyStore } from '../src/auth/refresh.ts';
import { applyFieldLww, computePullCursor } from '../src/sync/conflict.ts';
import { IdempotencyStore } from '../src/sync/idempotency.ts';

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

test('a tombstone propagates and cursor stops before an unapplied operation', () => {
  const row = applyFieldLww({ data: { amount: 4 }, fieldClocks: {}, deletedAt: null }, { opId: 'd', entity: 'transactions', entityId: 'x', action: 'delete' }, 7).row;
  assert.ok(row.deletedAt);
  assert.equal(computePullCursor([
    { serverSeq: 8, applied: true, value: 'a' },
    { serverSeq: 9, applied: false, value: 'b' },
    { serverSeq: 10, applied: true, value: 'c' }
  ], 7), 8);
});
