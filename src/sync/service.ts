import type { Pool, PoolClient } from 'pg';
import type { Db } from '../db.js';
import { ApiError } from '../errors.js';
import { applyFieldLww, computePullCursor, type RowState, type SyncOp } from './conflict.js';

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
    const existing = existingResult.rows[0];
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
    return { conflict: result.skipped, value: outcome };
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

function validateOp(op: SyncOp): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!op || typeof op.opId !== 'string' || !uuid.test(op.opId)) throw new ApiError(400, 'invalid_operation', 'Every operation needs a UUID opId');
  if (!TABLES[op.entity]) throw new ApiError(400, 'invalid_operation', 'Unknown sync entity');
  if (!uuid.test(op.entityId)) throw new ApiError(400, 'invalid_operation', 'Every operation needs a UUID entityId');
  if (op.action !== 'upsert' && op.action !== 'delete') throw new ApiError(400, 'invalid_operation', 'Operation action must be upsert or delete');
  if (op.action === 'upsert' && (!op.fields || typeof op.fields !== 'object' || Array.isArray(op.fields))) throw new ApiError(400, 'invalid_operation', 'Upsert operations need fields');
}
