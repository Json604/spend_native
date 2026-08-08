import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { migrate } from './db.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
try {
  await migrate(pool);
  console.log(JSON.stringify({ level: 'info', message: 'migrations applied' }));
} finally {
  await pool.end();
}
