import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { SignJWT, jwtVerify } from 'jose';
import type { Db } from '../db.js';
import { ApiError } from '../errors.js';
import { hashRefreshToken } from './refresh.js';
import type { GoogleIdentity } from './google.js';

type User = { id: string; googleSub: string; email?: string; name?: string; picture?: string };

export class AuthService {
  private readonly secret: Uint8Array;
  constructor(private readonly db: Db, private readonly accessSecret: string, private readonly accessTtl: string, private readonly refreshDays: number) {
    this.secret = new TextEncoder().encode(accessSecret);
  }

  async signIn(identity: GoogleIdentity): Promise<{ access: string; refresh: string; user: User }> {
    const userResult = await this.db.query<User & { google_sub: string }>(
      `INSERT INTO users(id, google_sub, email, name, picture) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (google_sub) DO UPDATE SET email=EXCLUDED.email, name=EXCLUDED.name, picture=EXCLUDED.picture, updated_at=now()
       RETURNING id, google_sub, email, name, picture`,
      [randomUUID(), identity.sub, identity.email ?? null, identity.name ?? null, identity.picture ?? null]
    );
    return this.issuePair(this.mapUser(userResult.rows[0]));
  }

  async rotate(refresh: string): Promise<{ access: string; refresh: string; user: User }> {
    if (!refresh || refresh.length < 40) throw new ApiError(401, 'invalid_refresh', 'Refresh token is invalid');
    const ownClient = !('release' in this.db);
    const client = ownClient ? await (this.db as Pool).connect() : this.db;
    try {
      await client.query('BEGIN');
      const found = await client.query<{ id: string; user_id: string; family_id: string; expires_at: Date; used_at: Date | null; revoked_at: Date | null }>(
        `SELECT id,user_id,family_id,expires_at,used_at,revoked_at FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE`, [hashRefreshToken(refresh)]
      );
      const row = found.rows[0];
      if (!row || row.expires_at.getTime() <= Date.now()) {
        await client.query('ROLLBACK');
        throw new ApiError(401, 'invalid_refresh', 'Refresh token is invalid');
      }
      if (row.used_at || row.revoked_at) {
        await client.query('UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE family_id=$1', [row.family_id]);
        await client.query('COMMIT');
        throw new ApiError(401, 'refresh_reuse_detected', 'Refresh token reuse detected; session family revoked');
      }
      const next = randomBytesToken();
      const nextId = randomUUID();
      await client.query('UPDATE refresh_tokens SET used_at=now() WHERE id=$1', [row.id]);
      await client.query(
        `INSERT INTO refresh_tokens(id,user_id,family_id,token_hash,parent_id,expires_at) VALUES ($1,$2,$3,$4,$5,now()+($6 * interval '1 day'))`,
        [nextId, row.user_id, row.family_id, hashRefreshToken(next), row.id, this.refreshDays]
      );
      const userResult = await client.query<User & { google_sub: string }>('SELECT id,google_sub,email,name,picture FROM users WHERE id=$1', [row.user_id]);
      await client.query('COMMIT');
      const user = this.mapUser(userResult.rows[0]);
      return { access: await this.issueAccess(user), refresh: next, user };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* already committed/rolled back */ }
      throw error;
    } finally {
      if (ownClient) (client as { release: () => void }).release();
    }
  }

  async authenticateAccess(token: string): Promise<{ userId: string }> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { algorithms: ['HS256'] });
      if (typeof payload.sub !== 'string') throw new Error('no subject');
      return { userId: payload.sub };
    } catch {
      throw new ApiError(401, 'unauthorized', 'Access token is invalid or expired');
    }
  }

  private async issuePair(user: User) {
    const access = await this.issueAccess(user);
    const refresh = randomBytesToken();
    await this.db.query(
      `INSERT INTO refresh_tokens(id,user_id,family_id,token_hash,expires_at) VALUES ($1,$2,$3,$4,now()+($5 * interval '1 day'))`,
      [randomUUID(), user.id, randomUUID(), hashRefreshToken(refresh), this.refreshDays]
    );
    return { access, refresh, user };
  }

  private async issueAccess(user: User): Promise<string> {
    return new SignJWT({ typ: 'access' }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(user.id).setIssuedAt().setExpirationTime(this.accessTtl).sign(this.secret);
  }

  private mapUser(row: User & { google_sub: string }): User {
    return { id: row.id, googleSub: row.google_sub, email: row.email, name: row.name, picture: row.picture };
  }
}

function randomBytesToken(): string {
  return randomBytes(48).toString('base64url');
}
