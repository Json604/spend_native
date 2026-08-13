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
