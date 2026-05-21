import { getDatabase } from '../connection';
import { VERSION as V1, SQL as SQL_V1 } from './001_initial_schema';
import { VERSION as V2, SQL as SQL_V2 } from './002_media_blur_hash_expires';
import { VERSION as V3, SQL as SQL_V3 } from './003_drop_media_fks';

interface Migration {
  version: number;
  sql: string;
}

const migrations: Migration[] = [
  { version: V1, sql: SQL_V1 },
  { version: V2, sql: SQL_V2 },
  { version: V3, sql: SQL_V3 },
];

/**
 * Run all pending migrations in version order.
 *
 * Uses PRAGMA user_version to track the current schema version.
 * Each migration runs in its own transaction — if it throws, the transaction
 * is rolled back and the error propagates so bootstrap can fail loudly.
 */
export function runMigrations(): void {
  const db = getDatabase();
  const result = db.executeSync('PRAGMA user_version');
  const currentVersion = (result.rows[0]?.user_version as number | undefined) ?? 0;

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;

    db.executeSync('BEGIN TRANSACTION');
    try {
      db.executeSync(migration.sql);
      db.executeSync(`PRAGMA user_version = ${migration.version}`);
      db.executeSync('COMMIT');
    } catch (error) {
      db.executeSync('ROLLBACK');
      throw error;
    }
  }
}
