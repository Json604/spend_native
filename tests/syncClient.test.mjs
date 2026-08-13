import test from 'node:test';
import assert from 'node:assert/strict';
import {SpendSyncClient} from '../src/sync/spendSyncClient.ts';

function jsonResponse(body) {
  return {
    ok: true,
    json: async () => body,
  };
}

function stubbedClient({leftover = 0, applyReport = '{"applied":[],"rejected":[]}', pullOps = []} = {}) {
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
    getDeadLetterCount: async () => 0,
  };
  const nativeCoordinator = {
    query: async sql => {
      calls.push(`query:${sql.replace(/\s+/g, ' ').trim()}`);
      if (sql.includes("key = 'owner_id'")) return [{value: 'user-1'}];
      if (sql.includes('FROM outbox')) return [];
      if (sql.includes("key = 'pull_cursor'")) return [{value: '0'}];
      if (sql.includes('FROM sync_rejected')) return [{count: leftover}];
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
