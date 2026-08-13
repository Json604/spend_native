import { Pool } from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './db.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 8, idleTimeoutMillis: 30_000 });
await migrate(pool);
const app = buildApp(pool, config);
await app.listen({ host: config.host, port: config.port });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
