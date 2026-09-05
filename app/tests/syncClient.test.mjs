import test from 'node:test';
import assert from 'node:assert/strict';
import {SpendSyncClient} from '../src/sync/spendSyncClient.ts';

function jsonResponse(body) {
  return {
    ok: true,
    json: async () => body,
  };
}

function stubbedClient({leftover = 0, stuck = 0, deadLetters = 0, applyReport = '{"applied":[],"rejected":[]}', pullOps = []} = {}) {
  const calls = [];
  const nativeSync = {
    acknowledgeOutbox: async () => 0,
    recordOutboxFailure: async () => 0,
    recoverDeadLettersOnce: async () => {
      calls.push('recoverDeadLettersOnce');
      return 0;
    },
    applyPulledOps: async commandsJson => {
      calls.push('applyPulledOps');
      const commands = JSON.parse(commandsJson);
      if (!Array.isArray(commands) || commands.length === 0) {
        return JSON.stringify({applied: [], rejected: []});
      }
      return applyReport;
    },
    retryRejectedOps: async () => {
      calls.push('retryRejectedOps');
      return JSON.stringify({retried: 0, applied: 0, rejected: 0});
    },
    getDeadLetterCount: async () => deadLetters,
  };
  const nativeCoordinator = {
    query: async sql => {
      calls.push(`query:${sql.replace(/\s+/g, ' ').trim()}`);
      if (sql.includes("key = 'owner_id'")) return [{value: 'user-1'}];
      if (sql.includes('FROM outbox')) return [];
      if (sql.includes("key = 'pull_cursor'")) return [{value: '0'}];
      if (sql.includes('FROM sync_rejected')) {
        return [{count: sql.includes('attempt_count >=') ? stuck : leftover}];
      }
      return [];
    },
  };
  let pullPages = 0;
  const authenticatedFetch = async path => {
    calls.push(`fetch:${path}`);
    if (path.startsWith('/v1/sync/pull')) {
      pullPages += 1;
      if (pullPages > 1) return jsonResponse({ops: [], cursor: 1});
      return jsonResponse({ops: pullOps, cursor: pullOps.length > 0 ? 1 : 0});
    }
    return jsonResponse({applied: [], conflicts: []});
  };
  return {
    calls,
    client: new SpendSyncClient({
      nativeSync,
      nativeCoordinator,
      authenticatedFetch,
      secureDeviceId: async () => 'device-1',
    }),
  };
}

test('retryRejectedOps runs before pull and leftover rejects become report.error', async () => {
  const {calls, client} = stubbedClient({leftover: 2, pullOps: []});
  const report = await client.sync();

  const retryAt = calls.indexOf('retryRejectedOps');
  const pullAt = calls.findIndex(call => call.startsWith('fetch:/v1/sync/pull'));
  assert.notEqual(retryAt, -1);
  assert.notEqual(pullAt, -1);
  assert.ok(retryAt < pullAt, `expected retry before pull, got ${calls.join(' -> ')}`);
  assert.match(report.error ?? '', /2 changes from the server could not be applied/);
});

test('backUpEverything sends createTransactionFromAlert ops after categories and before budgets', async () => {
  const pushed = [];
  const nativeCoordinator = {
    query: async sql => {
      if (sql.includes("key = 'owner_id'")) return [{value: 'user-1'}];
      if (sql.includes('FROM categories')) {
        return [{id: 'cat-1', label: 'Food', tint: null, parent_id: null, is_system: 0, catalog_version: 1}];
      }
      if (sql.includes('FROM transactions')) {
        return [{
          id: 'tx-1',
          occurred_at: 1,
          received_at: 2,
          accounting_month_key: '2026-08',
          amount_minor: 4200,
          direction: 'debit',
          currency_code: 'INR',
          merchant_raw: 'Cafe',
          counterparty_key: 'cafe',
          channel: 'upi',
          status: 'posted',
          plan_type: 'unplanned',
        }];
      }
      if (sql.includes('FROM source_alerts')) {
        return [{
          id: 'alert-1',
          transaction_id: 'tx-1',
          raw_sender: 'BANK',
          raw_body: 'paid 42',
          received_at: 2,
          provider_message_id: 'm-1',
          subscription_id: null,
          bank_reference: null,
          parse_status: 'parsed',
        }];
      }
      if (sql.includes('FROM transaction_allocations')) {
        return [{
          id: 'alloc-1',
          transaction_id: 'tx-1',
          category_id: 'cat-1',
          amount_minor: 4200,
          source: 'manual',
          confidence: 1,
        }];
      }
      if (sql.includes('FROM budgets')) {
        return [{month_key: '2026-08', category_id: 'cat-1', amount_minor: 500, recurring: 0}];
      }
      return [];
    },
  };
  const client = new SpendSyncClient({
    nativeSync: {
      acknowledgeOutbox: async () => 0,
      recordOutboxFailure: async () => 0,
      recoverDeadLettersOnce: async () => 0,
      applyPulledOps: async () => '{"applied":[],"rejected":[]}',
      retryRejectedOps: async () => '{"retried":0}',
      getDeadLetterCount: async () => 0,
    },
    nativeCoordinator,
    authenticatedFetch: async (path, init) => {
      if (path === '/v1/sync/push') pushed.push(JSON.parse(init.body));
      return jsonResponse({applied: [], conflicts: []});
    },
    secureDeviceId: async () => 'device-1',
  });

  const report = await client.backUpEverything();
  assert.equal(report.error, undefined);
  assert.equal(report.sent, 3);
  assert.deepEqual(pushed.map(body => body.ops.map(op => op.entity)), [
    ['categories'],
    ['transactions'],
    ['budgets'],
  ]);
  const transaction = pushed[1].ops[0];
  assert.equal(transaction.kind, 'createTransactionFromAlert');
  assert.equal(transaction.payload.transaction.planType, 'unplanned');
  assert.equal(transaction.payload.alert.id, 'alert-1');
  assert.deepEqual(transaction.payload.allocation, {
    id: 'alloc-1',
    categoryId: 'cat-1',
    source: 'manual',
    confidence: 1,
  });
  assert.equal(transaction.expectedRevision, undefined);
});

test('an apply-report reject is an error even when leftover COUNT is zero', async () => {
  const {client} = stubbedClient({
    leftover: 0,
    applyReport: JSON.stringify({applied: [], rejected: [{error: 'persist missed'}]}),
    pullOps: [{
      op_id: '11111111-1111-4111-8111-111111111111',
      entity_type: 'categories',
      entity_id: 'cat-1',
      action: 'upsert',
      payload: {kind: 'createCategory', commandId: 'c1', payload: {categoryId: 'cat-1', label: 'Food'}},
    }],
  });
  const report = await client.sync();
  assert.match(report.error ?? '', /1 change from the server could not be applied/);
});

// A reject that has exhausted its retries can never apply — the allocation op
// pausing backup today is keyed by its own JSON blob, so nothing will ever
// match it. Blocking sync on it forever lets one dead row hide the health of
// everything else, and with updates now costing a full reinstall that is an
// expensive corner to be painted into.
test('an exhausted reject stops blocking sync and is surfaced instead', async () => {
  const {client} = stubbedClient({leftover: 0, stuck: 3});
  const report = await client.sync();
  assert.equal(report.error, undefined);
  assert.equal(report.deadLetterCount, 3);
});

test('an exhausted reject is counted alongside outbox dead letters', async () => {
  const {client} = stubbedClient({stuck: 2, deadLetters: 5});
  assert.equal(await client.deadLetterCount(), 7);
});

// The escape hatch must not swallow a reject that is still worth retrying.
test('a reject still inside its retry budget still reports as an error', async () => {
  const {client} = stubbedClient({leftover: 1, stuck: 0});
  const report = await client.sync();
  assert.match(report.error ?? '', /could not be applied/);
});
