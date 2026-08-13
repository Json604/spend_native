import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { ApiError, isApiError } from './errors.js';
import { googleVerifier } from './auth/google.js';
import { AuthService } from './auth/service.js';
import { SyncService } from './sync/service.js';
import { registerClassifyRoute } from './classify/groq.js';

declare module 'fastify' {
  interface FastifyRequest { userId?: string }
}

export function buildApp(pool: Pool, config: Config): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const auth = new AuthService(pool, config.accessTokenSecret, config.accessTokenTtl, config.refreshTokenTtlDays);
  const sync = new SyncService(pool, config.maxPushOps, config.maxPullOps);
  const verifyGoogle = googleVerifier(config.googleIssuer, config.googleClientId);

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/v1/auth/google', async (request) => {
    const body = request.body as { id_token?: unknown };
    if (typeof body?.id_token !== 'string' || !body.id_token) throw new ApiError(400, 'invalid_request', 'id_token is required');
    return auth.signIn(await verifyGoogle(body.id_token));
  });

  app.post('/v1/auth/refresh', async (request) => {
    const body = request.body as { refresh?: unknown };
    if (typeof body?.refresh !== 'string') throw new ApiError(400, 'invalid_request', 'refresh is required');
    return auth.rotate(body.refresh);
  });

  app.post('/v1/sync/push', { preHandler: requireAccess(auth) }, async (request) => {
    const body = request.body as { ops?: unknown; deviceId?: unknown };
    if (typeof body?.deviceId !== 'string' || !body.deviceId || !Array.isArray(body.ops)) throw new ApiError(400, 'invalid_request', 'ops and deviceId are required');
    await pool.query(`INSERT INTO devices(id,user_id,device_id,last_seen_at) VALUES ($1,$2,$3,now()) ON CONFLICT(user_id,device_id) DO UPDATE SET last_seen_at=now()`, [randomUUID(), request.userId, body.deviceId]);
    return sync.push(request.userId!, body.deviceId, body.ops as never[]);
  });

  app.get('/v1/sync/pull', { preHandler: requireAccess(auth) }, async (request) => {
    const sinceValue = (request.query as { since?: string }).since;
    const since = sinceValue === undefined ? 0 : Number(sinceValue);
    return sync.pull(request.userId!, since);
  });

  registerClassifyRoute(app, { groqApiKey: config.groqApiKey, authenticate: requireAccess(auth) });

  app.setErrorHandler((error, request, reply) => {
    if (isApiError(error)) {
      // Log WHY, not just the status code. A bare 400 in the access log is
      // undiagnosable from the server side, which cost real time chasing the
      // first device sync failure.
      request.log.warn(
        { code: error.code, reason: error.message, url: request.url, details: error.details },
        'request rejected'
      );
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    request.log.error(error);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });
  return app;
}

function requireAccess(auth: AuthService) {
  return async (request: FastifyRequest) => {
    const value = request.headers.authorization;
    if (!value?.startsWith('Bearer ')) throw new ApiError(401, 'unauthorized', 'Bearer access token required');
    request.userId = (await auth.authenticateAccess(value.slice(7))).userId;
  };
}
