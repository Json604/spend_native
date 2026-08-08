export type FieldClock = { seq: number; source?: string };
export type FieldClocks = Record<string, FieldClock>;
export type RowState = { data: Record<string, unknown>; fieldClocks: FieldClocks; deletedAt?: string | null };
export type SyncOp = {
  opId: string;
  entity: string;
  entityId: string;
  action: 'upsert' | 'delete';
  fields?: Record<string, unknown>;
  source?: string;
};

const MACHINE_SOURCES = new Set(['learned', 'rule', 'similarity', 'llm']);

function machine(source: unknown): boolean { return typeof source === 'string' && MACHINE_SOURCES.has(source); }
function fieldEnvelope(value: unknown, operationSource?: string): { value: unknown; source?: string } {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    const envelope = value as { value: unknown; source?: unknown };
    return { value: envelope.value, source: typeof envelope.source === 'string' ? envelope.source : operationSource };
  }
  return { value, source: operationSource };
}

export function applyFieldLww(row: RowState | undefined, op: SyncOp, serverSeq: number): { row: RowState; changed: string[]; skipped: boolean } {
  const current: RowState = row ?? { data: {}, fieldClocks: {}, deletedAt: null };
  if (op.action === 'delete') {
    return { row: { ...current, deletedAt: new Date().toISOString() }, changed: ['deleted_at'], skipped: false };
  }
  const fields = op.fields ?? {};
  const currentSource = current.data.source;
  const incomingSource = op.source ?? (typeof fields.source === 'string' ? fields.source : undefined);
  if (currentSource === 'manual' && machine(incomingSource)) {
    return { row: current, changed: [], skipped: true };
  }
  const data = { ...current.data };
  const fieldClocks = { ...current.fieldClocks };
  const changed: string[] = [];
  let applied = false;
  for (const [field, rawValue] of Object.entries(fields)) {
    const envelope = fieldEnvelope(rawValue, op.source);
    const previous = fieldClocks[field];
    const previousSource = previous?.source ?? data.source;
    if (previousSource === 'manual' && machine(envelope.source)) continue;
    if (!previous || serverSeq >= previous.seq || envelope.source === 'manual') {
      if (JSON.stringify(data[field]) !== JSON.stringify(envelope.value)) changed.push(field);
      data[field] = envelope.value;
      fieldClocks[field] = { seq: serverSeq, ...(envelope.source ? { source: envelope.source } : {}) };
      applied = true;
    }
  }
  // A tombstone must not outrank a strictly newer write. Previously an upsert
  // always preserved deletedAt, so a client recreating a row it still believed
  // in could never revive it — its fields landed on an invisible row and the
  // data was silently lost. That is what stranded a month of budget lines on
  // categories a server-side dedupe had soft-deleted.
  //
  // Only a write that actually won on at least one field revives the row; an
  // upsert entirely rejected by LWW or by provenance leaves the tombstone
  // standing, so a delete still beats every older write.
  const deletedAt = applied ? null : current.deletedAt ?? null;
  if (applied && current.deletedAt) changed.push('deleted_at');
  return { row: { data, fieldClocks, deletedAt }, changed, skipped: false };
}

export type PullableOp = { serverSeq: number; applied: boolean; value: unknown };
export function computePullCursor(rows: PullableOp[], since: number): number {
  let cursor = since;
  for (const row of rows.sort((a, b) => a.serverSeq - b.serverSeq)) {
    if (!row.applied) break;
    cursor = row.serverSeq;
  }
  return cursor;
}
