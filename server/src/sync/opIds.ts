import { createHash } from 'node:crypto';

/**
 * A UUIDv5-shaped id derived from the parent operation, so a cascade is
 * idempotent under replay: the same parent always names the same children.
 *
 * Kept in its own module rather than beside SyncService so it can be tested
 * directly — the service carries constructor parameter properties, which Node's
 * strip-only TypeScript loader refuses to parse.
 */
export function deriveOpId(parentOpId: string, entity: string, entityId: string): string {
  const digest = createHash('sha1').update(`${parentOpId}:${entity}:${entityId}`).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * The op id this server STORES for a client's operation.
 *
 * App builds up to 2.3.13 mint op ids by slicing a hex string, and one of the
 * four terms was a signed xor: a negative value stringifies with a leading "-"
 * that padStart cannot pad away, so roughly one id in 250 arrived shaped like
 * `0552fd08-fa2a-5132-8-87-d3c6ff7dce3a` — six groups, not five. Those were
 * rejected, and because a push is one transaction the whole batch died with it.
 * The device retried the identical batch forever and the app sat on "Backup
 * paused" permanently.
 *
 * The client fix cannot reach those installs: they are signed with a release
 * key that no longer exists, so no update will ever install over them. The
 * server therefore has to accept what they already send. sync_ops.op_id is a
 * Postgres uuid, so a malformed id is folded to a derived one instead of being
 * stored verbatim.
 *
 * The fold is deterministic, so a replay of the same malformed id lands on the
 * same row and idempotency still holds. It goes through a distinct prefix so a
 * folded id can never be steered onto a row a well-formed id owns. A valid
 * UUID is returned untouched, which is what every fixed client sends.
 */
export function canonicalOpId(rawOpId: string): string {
  if (isUuid(rawOpId)) return rawOpId;
  return deriveOpId('spend:legacy-opid-fold:v1', 'op_ids', rawOpId);
}
