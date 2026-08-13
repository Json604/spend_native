import type { Pool, PoolClient } from 'pg';
import type { Db } from '../db.js';
import { ApiError } from '../errors.js';
import { applyFieldLww, computePullCursor, type RowState, type SyncOp } from './conflict.js';
import { deriveOpId } from './opIds.js';

const TABLES: Record<string, string> = {
  transactions: 'transactions',
  transaction_allocations: 'transaction_allocations',
  categories: 'categories',
  category_memory: 'category_memory',
  budgets: 'budgets',
  source_alerts: 'source_alerts',
  suggestions: 'suggestions'
};

type StoredRow = { data: Record<string, unknown>; field_clocks: Record<string, { seq: number; source?: string }>; deleted_at: Date | null; source?: string | null };

export class SyncService {
  constructor(private readonly db: Db, private readonly maxPushOps = 500, private readonly maxPullOps = 1000) {}

  async push(userId: string, deviceId: string, operations: SyncOp[]): Promise<{ applied: unknown[]; conflicts: unknown[] }> {
    if (!Array.isArray(operations) || operations.length > this.maxPushOps) {
      throw new ApiError(413, 'push_batch_too_large', `A push may contain at most ${this.maxPushOps} operations`);
    }
    const ownClient = !('release' in this.db);
    const client: PoolClient = ownClient ? await (this.db as Pool).connect() : this.db as PoolClient;
    const applied: unknown[] = [];
    const conflicts: unknown[] = [];
    try {
      await client.query('BEGIN');
      for (const operation of operations) {
        const result = await this.applyOne(client, userId, deviceId, operation);
        if (result.conflict) conflicts.push(result.value); else applied.push(result.value);
      }
      await client.query('COMMIT');
      return { applied, conflicts };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* best effort */ }
      throw error;
    } finally {
      if (ownClient) (client as PoolClient).release();
    }
  }

  private async applyOne(client: PoolClient, userId: string, deviceId: string, op: SyncOp): Promise<{ conflict: boolean; value: unknown }> {
    validateOp(op);
    const duplicate = await client.query<{ user_id: string; outcome: unknown }>('SELECT user_id,outcome FROM sync_ops WHERE op_id=$1 FOR UPDATE', [op.opId]);
    if (duplicate.rowCount) {
      if (duplicate.rows[0].user_id !== userId) throw new ApiError(409, 'op_id_taken', 'Operation id belongs to another user');
      return { conflict: false, value: duplicate.rows[0].outcome };
    }
    const seqResult = await client.query<{ nextval: string }>("SELECT nextval('sync_sequence')");
    const seq = Number(seqResult.rows[0].nextval);
    const table = TABLES[op.entity];
    const existingResult = await client.query<StoredRow>(`SELECT data,field_clocks,deleted_at,${op.entity === 'transaction_allocations' ? 'source' : 'NULL::text AS source'} FROM ${table} WHERE id=$1 AND user_id=$2 FOR UPDATE`, [op.entityId, userId]);
    let existing = existingResult.rows[0];

    // The server owns category-label uniqueness, so it also owns resolving a
    // clash. Two devices naming the same category independently generate two
    // ids; without this the second insert violates the unique index and the
    // whole push fails. Redirect the op onto the category that already holds
    // the label instead — the user meant one category, not two.
    // Also fires when the named row is soft-deleted: an upsert now revives a
    // tombstoned row, and reviving one whose label a live twin already holds
    // would violate the uniqueness index and fail the entire push. Redirecting
    // is what the user meant anyway — one category, not a resurrected rival.
    if ((!existing || existing.deleted_at) && op.entity === 'categories' && op.action === 'upsert') {
      const label = typeof op.fields?.label === 'string' ? op.fields.label : null;
      if (label) {
        const claimed = await client.query<{ id: string } & StoredRow>(
          `SELECT id,data,field_clocks,deleted_at,NULL::text AS source FROM ${table}
             WHERE user_id=$1 AND lower(data->>'label')=lower($2) AND deleted_at IS NULL
             LIMIT 1 FOR UPDATE`,
          [userId, label],
        );
        if (claimed.rows[0]) {
          op = { ...op, entityId: claimed.rows[0].id };
          existing = claimed.rows[0];
        }
      }
    }
    // The redirect above resolves IDENTITY — who this row is. The same
    // authority rule has to cover REFERENCES, or the two disagree: the category
    // op lands on the surviving row while a budget op keeps naming the dead one,
    // and the budget ends up live but attached to a tombstone. Invisible to the
    // client, still real in the table. That stranded 18 budget lines here.
    if (op.action === 'upsert' && (op.entity === 'budgets' || op.entity === 'transaction_allocations')) {
      const redirected = await resolveCategoryReference(client, userId, op);
      if (redirected) op = redirected;

      // Rewriting the reference can point this row at a category that already
      // owns a row for the same natural key, which the unique indexes reject —
      // and a rejection fails the entire push, not just this operation. Claim
      // the existing row instead, the same way a label clash is resolved. A
      // soft-deleted row counts too, since an upsert would now revive it into
      // the same collision.
      if (!existing || existing.deleted_at) {
        const claimed = await claimByNaturalKey(client, userId, op);
        if (claimed) {
          op = { ...op, entityId: claimed.id };
          existing = claimed;
        }
      }
    }

    const current: RowState | undefined = existing ? { data: { ...existing.data, ...(existing.source ? { source: existing.source } : {}) }, fieldClocks: existing.field_clocks ?? {}, deletedAt: existing.deleted_at?.toISOString() ?? null } : undefined;
    const result = applyFieldLww(current, op, seq);
    const outcome = { opId: op.opId, entity: op.entity, entityId: op.entityId, serverSeq: seq, changed: result.changed, skipped: result.skipped };
    const source = typeof result.row.data.source === 'string' ? result.row.data.source : null;
    const transactionId = typeof result.row.data.transactionId === 'string' ? result.row.data.transactionId : null;
    if (existing) {
      await client.query(`UPDATE ${table} SET data=$1,field_clocks=$2,updated_at=now(),deleted_at=$3,server_seq=$4${op.entity === 'transaction_allocations' ? ',source=$5' : ''} WHERE id=$${op.entity === 'transaction_allocations' ? 6 : 5} AND user_id=$${op.entity === 'transaction_allocations' ? 7 : 6}`,
        op.entity === 'transaction_allocations' ? [result.row.data, result.row.fieldClocks, result.row.deletedAt, seq, source, op.entityId, userId] : [result.row.data, result.row.fieldClocks, result.row.deletedAt, seq, op.entityId, userId]);
    } else {
      const columns = op.entity === 'transaction_allocations' ? 'id,user_id,transaction_id,source,data,field_clocks,updated_at,deleted_at,server_seq' : 'id,user_id,data,field_clocks,updated_at,deleted_at,server_seq';
      const values = op.entity === 'transaction_allocations' ? [op.entityId, userId, transactionId, source, result.row.data, result.row.fieldClocks, result.row.deletedAt, seq] : [op.entityId, userId, result.row.data, result.row.fieldClocks, result.row.deletedAt, seq];
      const valueSql = op.entity === 'transaction_allocations'
        ? `($1,$2,$3,$4,$5,$6,now(),$7,$8)`
        : `($1,$2,$3,$4,now(),$5,$6)`;
      await client.query(`INSERT INTO ${table}(${columns}) VALUES ${valueSql}`, values);
    }
    await client.query('INSERT INTO sync_ops(op_id,user_id,device_id,entity_type,entity_id,action,payload,outcome,server_seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [op.opId, userId, deviceId, op.entity, op.entityId, op.action, op, outcome, seq]);
    if (op.entity === 'categories' && op.action === 'delete') {
      await this.cascadeCategoryDelete(client, userId, deviceId, op);
    }
    return { conflict: result.skipped, value: outcome };
  }

  /**
   * Deleting a category deletes what depends on it. Without this the budget and
   * allocation rows stay live while pointing at a tombstone: the client filters
   * them out because their category is gone, so the user cannot see or fix them,
   * yet they still exist and still sum. A month of budget went missing that way.
   *
   * Each cascaded delete is written as its own operation with its own sequence,
   * because a client rebuilding from the log has no other way to learn the row
   * died. The child op id is derived from the parent's, so replaying the parent
   * finds the children already recorded instead of deleting a second time.
   */
  private async cascadeCategoryDelete(client: PoolClient, userId: string, deviceId: string, op: SyncOp): Promise<void> {
    for (const entity of ['budgets', 'transaction_allocations'] as const) {
      const table = TABLES[entity];
      const dependents = await client.query<{ id: string }>(
        `SELECT id FROM ${table} WHERE user_id=$1 AND data->>'categoryId'=$2 AND deleted_at IS NULL FOR UPDATE`,
        [userId, op.entityId],
      );
      for (const row of dependents.rows) {
        const childOpId = deriveOpId(op.opId, entity, row.id);
        const seen = await client.query('SELECT 1 FROM sync_ops WHERE op_id=$1', [childOpId]);
        if (seen.rowCount) continue;
        const seqResult = await client.query<{ nextval: string }>("SELECT nextval('sync_sequence')");
        const seq = Number(seqResult.rows[0].nextval);
        await client.query(`UPDATE ${table} SET deleted_at=now(),updated_at=now(),server_seq=$1 WHERE id=$2 AND user_id=$3`, [seq, row.id, userId]);
        const childOp: SyncOp = { opId: childOpId, entity, entityId: row.id, action: 'delete' };
        const childOutcome = { opId: childOpId, entity, entityId: row.id, serverSeq: seq, changed: ['deleted_at'], skipped: false, cascadedFrom: op.opId };
        await client.query('INSERT INTO sync_ops(op_id,user_id,device_id,entity_type,entity_id,action,payload,outcome,server_seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [childOpId, userId, deviceId, entity, row.id, 'delete', childOp, childOutcome, seq]);
      }
    }
  }

  async pull(userId: string, since: number): Promise<{ ops: unknown[]; cursor: number }> {
    if (!Number.isSafeInteger(since) || since < 0) throw new ApiError(400, 'invalid_cursor', 'since must be a non-negative integer');
    const result = await this.db.query<{ server_seq: string; applied: boolean; op_id: string; entity_type: string; entity_id: string; action: string; payload: unknown }>(
      `SELECT server_seq, true AS applied, op_id,entity_type,entity_id,action,payload FROM sync_ops WHERE user_id=$1 AND server_seq>$2 ORDER BY server_seq LIMIT $3`, [userId, since, this.maxPullOps]
    );
    const rows = result.rows.map((row) => ({ serverSeq: Number(row.server_seq), applied: row.applied, value: row }));
    const cursor = computePullCursor(rows, since);
    return { ops: rows.filter((row) => row.serverSeq <= cursor).map((row) => row.value), cursor };
  }
}

/** Fields may arrive bare or wrapped as {value, source}; read through both. */
function plainField(op: SyncOp, name: string): string | null {
  const raw = op.fields?.[name];
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw
    ? (raw as { value: unknown }).value
    : raw;
  return typeof value === 'string' && value !== '' ? value : null;
}

function withField(op: SyncOp, name: string, value: string): SyncOp {
  const raw = op.fields?.[name];
  const wrapped = raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw;
  return { ...op, fields: { ...op.fields, [name]: wrapped ? { ...(raw as object), value } : value } };
}

/**
 * A reference to a soft-deleted category is resolved to the live category that
 * now holds that label. The client is not wrong to name the dead id — it was
 * valid when the device last synced — so the server, which owns the merge,
 * translates rather than rejects.
 */
async function resolveCategoryReference(client: PoolClient, userId: string, op: SyncOp): Promise<SyncOp | null> {
  const categoryId = plainField(op, 'categoryId');
  if (!categoryId) return null;
  const dead = await client.query<{ label: string | null }>(
    `SELECT data->>'label' AS label FROM categories WHERE id=$1 AND user_id=$2 AND deleted_at IS NOT NULL`,
    [categoryId, userId],
  );
  const label = dead.rows[0]?.label;
  if (!label) return null;
  const live = await client.query<{ id: string }>(
    `SELECT id FROM categories WHERE user_id=$1 AND lower(data->>'label')=lower($2) AND deleted_at IS NULL LIMIT 1`,
    [userId, label],
  );
  const liveId = live.rows[0]?.id;
  if (!liveId || liveId === categoryId) return null;
  return withField(op, 'categoryId', liveId);
}

/** Find the row that already owns this op's natural key, so a redirected
 *  reference updates it instead of colliding with its unique index. */
async function claimByNaturalKey(client: PoolClient, userId: string, op: SyncOp): Promise<({ id: string } & StoredRow) | null> {
  const categoryId = plainField(op, 'categoryId');
  if (!categoryId) return null;
  if (op.entity === 'budgets') {
    const monthKey = plainField(op, 'monthKey');
    if (!monthKey) return null;
    const claimed = await client.query<{ id: string } & StoredRow>(
      `SELECT id,data,field_clocks,deleted_at,NULL::text AS source FROM budgets
         WHERE user_id=$1 AND data->>'monthKey'=$2 AND data->>'categoryId'=$3 AND deleted_at IS NULL
         LIMIT 1 FOR UPDATE`,
      [userId, monthKey, categoryId],
    );
    return claimed.rows[0] ?? null;
  }
  const transactionId = plainField(op, 'transactionId');
  if (!transactionId) return null;
  const claimed = await client.query<{ id: string } & StoredRow>(
    `SELECT id,data,field_clocks,deleted_at,source FROM transaction_allocations
       WHERE user_id=$1 AND transaction_id=$2 AND data->>'categoryId'=$3 AND deleted_at IS NULL
       LIMIT 1 FOR UPDATE`,
    [userId, transactionId, categoryId],
  );
  return claimed.rows[0] ?? null;
}

function validateOp(op: SyncOp): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!op || typeof op.opId !== 'string' || !uuid.test(op.opId)) throw new ApiError(400, 'invalid_operation', 'Every operation needs a UUID opId');
  if (!TABLES[op.entity]) throw new ApiError(400, 'invalid_operation', 'Unknown sync entity');
  // entityId is DEVICE-generated and deliberately meaningful — 'sms:8393' embeds
  // the provider message id, which is what makes re-ingesting the same SMS
  // idempotent, and categories use stable slugs like 'custom:fruits'. Requiring a
  // UUID here rejected every real op. opId stays a UUID: the client mints it per
  // operation purely as an idempotency key.
  if (typeof op.entityId !== 'string' || op.entityId.trim() === '' || op.entityId.length > 200) {
    throw new ApiError(400, 'invalid_operation', 'Every operation needs a non-empty entityId of at most 200 characters');
  }
  if (op.action !== 'upsert' && op.action !== 'delete') throw new ApiError(400, 'invalid_operation', 'Operation action must be upsert or delete');
  if (op.action === 'upsert' && (!op.fields || typeof op.fields !== 'object' || Array.isArray(op.fields))) throw new ApiError(400, 'invalid_operation', 'Upsert operations need fields');
}
