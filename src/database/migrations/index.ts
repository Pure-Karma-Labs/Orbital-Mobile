import { getDatabase } from '../connection';
import { VERSION as V1, SQL as SQL_V1 } from './001_initial_schema';
import { VERSION as V2, SQL as SQL_V2 } from './002_media_blur_hash_expires';
import { VERSION as V3, SQL as SQL_V3 } from './003_drop_media_fks';
import { VERSION as V4, SQL as SQL_V4 } from './004_thread_reply_persistence';
import { VERSION as V5, SQL as SQL_V5 } from './005_fts5_search';
import { VERSION as V6, SQL as SQL_V6 } from './006_media_thumbnail_ref';
import { VERSION as V7, SQL as SQL_V7 } from './007_media_archive_confirmed';
import { VERSION as V8, SQL as SQL_V8 } from './008_drop_media_sync_tables';

interface Migration {
  version: number;
  sql: string;
  disableForeignKeys?: boolean;
}

const migrations: Migration[] = [
  { version: V1, sql: SQL_V1 },
  { version: V2, sql: SQL_V2 },
  { version: V3, sql: SQL_V3, disableForeignKeys: true },
  { version: V4, sql: SQL_V4, disableForeignKeys: true },
  { version: V5, sql: SQL_V5 },
  { version: V6, sql: SQL_V6 },
  { version: V7, sql: SQL_V7 },
  { version: V8, sql: SQL_V8 },
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

    if (migration.disableForeignKeys) {
      db.executeSync('PRAGMA foreign_keys = OFF');
    }
    db.executeSync('BEGIN TRANSACTION');
    try {
      db.executeSync(migration.sql);
      db.executeSync(`PRAGMA user_version = ${migration.version}`);
      db.executeSync('COMMIT');
    } catch (error) {
      db.executeSync('ROLLBACK');
      throw error;
    } finally {
      if (migration.disableForeignKeys) {
        db.executeSync('PRAGMA foreign_keys = ON');
        db.executeSync('PRAGMA foreign_key_check');
      }
    }
  }
}
