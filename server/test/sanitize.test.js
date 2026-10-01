import test from 'node:test';
import assert from 'node:assert/strict';
import { stripNulCharacters } from '../src/sync/sanitize.ts';
import { SyncService } from '../src/sync/service.ts';

test('a bank SMS NUL is removed from nested sync fields without changing the input', () => {
  const op = {
    opId: 'alert-1', entity: 'source_alerts', entityId: 'alert-1', action: 'upsert',
    fields: { rawBody: 'paid\u0000 today', nested: [{ text: 'a\u0000b' }] },
    payload: { rawBody: 'paid\u0000 today' },
  };

  const cleaned = stripNulCharacters(op);

  assert.equal(cleaned.fields.rawBody, 'paid today');
  assert.equal(cleaned.fields.nested[0].text, 'ab');
  assert.equal(cleaned.payload.rawBody, 'paid today');
  assert.equal(op.fields.rawBody, 'paid\u0000 today');
  assert.doesNotMatch(JSON.stringify(cleaned), /\\u0000/);
});

test('push serializes account writes before processing operations', async () => {
  const statements = [];
  const db = {
    release() {},
    async query(sql) {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    },
  };

  await new SyncService(db).push('owner-1', 'device-1', []);

  assert.deepEqual(statements, [
    'BEGIN',
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    'COMMIT',
  ]);
});

test('a push with NUL-containing SMS reaches JSONB with clean values', async () => {
  const writes = [];
  const db = {
    release() {},
    async query(sql, values = []) {
      writes.push({ sql, values });
      if (sql.includes("nextval('sync_sequence')")) return { rows: [{ nextval: '1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const op = {
    opId: '11111111-1111-4111-8111-111111111111',
    entity: 'source_alerts', entityId: 'sms:1', action: 'upsert',
    fields: { rawBody: 'bank\u0000 alert' },
    payload: { kind: 'recordSourceAlert', payload: { rawBody: 'bank\u0000 alert' } },
  };

  const result = await new SyncService(db).push('owner-1', 'device-1', [op]);

  assert.equal(result.applied.length, 1);
  assert.doesNotMatch(JSON.stringify(writes), /\\u0000/);
  assert.equal(op.fields.rawBody, 'bank\u0000 alert');
});
