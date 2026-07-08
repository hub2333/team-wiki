import { PostgresAdapter } from './postgres.js';
import { SqliteAdapter } from './sqlite.js';
import type { DbAdapter, DbConfig } from './types.js';

let db: DbAdapter | null = null;

export async function initDb(config: DbConfig): Promise<DbAdapter> {
  if (db) return db;

  db = config.provider === 'postgres'
    ? new PostgresAdapter(config)
    : new SqliteAdapter(config);

  await db.init();
  return db;
}

export function getDb(): DbAdapter {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}
