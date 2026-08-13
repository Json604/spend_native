import { createHash, randomBytes, randomUUID } from 'node:crypto';

export type RefreshState = {
  id: string;
  familyId: string;
  tokenHash: string;
  parentId?: string;
  expiresAt: number;
  usedAt?: number;
  revokedAt?: number;
};

export type RefreshRotation = { token: string; record: RefreshState };

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class RefreshFamilyStore {
  private readonly tokens = new Map<string, RefreshState>();
  private readonly families = new Map<string, boolean>();

  // familyId is annotated explicitly: without it TypeScript infers randomUUID()'s
  // `${string}-${string}-...` template-literal type, which then rejects a plain string.
  issue(userId: string, ttlMs: number, familyId: string = randomUUID(), parentId?: string): RefreshRotation {
    const token = randomBytes(48).toString('base64url');
    const record: RefreshState = {
      id: randomUUID(), familyId, tokenHash: hashRefreshToken(token), expiresAt: Date.now() + ttlMs,
      parentId, ...(userId ? {} : {})
    };
    this.tokens.set(record.tokenHash, record);
    this.families.set(familyId, false);
    return { token, record };
  }

  rotate(token: string, ttlMs: number): RefreshRotation {
    const old = this.tokens.get(hashRefreshToken(token));
    if (!old || old.expiresAt <= Date.now()) throw new Error('invalid_refresh');
    if (old.usedAt || old.revokedAt || this.families.get(old.familyId)) {
      this.families.set(old.familyId, true);
      for (const candidate of this.tokens.values()) {
        if (candidate.familyId === old.familyId) candidate.revokedAt = Date.now();
      }
      throw new Error('refresh_reuse_detected');
    }
    old.usedAt = Date.now();
    return this.issue('unused', ttlMs, old.familyId, old.id);
  }

  familyRevoked(familyId: string): boolean { return this.families.get(familyId) === true; }
  get(token: string): RefreshState | undefined { return this.tokens.get(hashRefreshToken(token)); }
}
