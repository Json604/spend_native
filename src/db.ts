import { Pool, type PoolClient } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Db = Pool | PoolClient;

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const migrationsDir = join(process.cwd(), 'db', 'migrations');
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
    if (exists.rowCount) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
