import { open, type DB } from '@op-engineering/op-sqlite';

let db: DB | null = null;

/**
 * Initialize the SQLCipher database with a raw 256-bit key.
 *
 * Must be called once during app bootstrap (see src/bootstrap.ts) after the
 * database encryption key is retrieved from Keychain.
 *
 * Uses raw-key hex syntax (`x'<hex>'`) to bypass PBKDF2 — the key is already
 * 256-bit CSPRNG output from Keychain.
 *
 * IMPORTANT: The encryptionKey parameter must NEVER be logged, serialized, or
 * captured by error reporting.
 *
 * Throws if called more than once to prevent silent re-initialization.
 */
export function initDatabase(encryptionKey: string): void {
  if (db !== null) {
    throw new Error('Database already initialized');
  }

  // op-sqlite's C++ bridge wraps the key in PRAGMA key = '<key>', so passing
  // x'...' here would produce PRAGMA key = 'x'...'' (broken quoting). Pass the
  // hex string directly — SQLCipher will derive the key via PBKDF2.
  db = open({ name: 'orbital.db', encryptionKey });

  // CRITICAL: cipher_memory_security must be set first, before other PRAGMAs.
  // It causes SQLCipher to zero-fill freed memory pages.
  db.executeSync('PRAGMA cipher_memory_security = ON');
  db.executeSync('PRAGMA journal_mode = WAL');
  db.executeSync('PRAGMA foreign_keys = ON');
  db.executeSync('PRAGMA busy_timeout = 5000');
}

/**
 * Returns the initialized DB instance.
 * Throws a descriptive error if initDatabase() has not been called yet.
 */
export function getDatabase(): DB {
  if (db === null) {
    throw new Error(
      'Database not initialized — call initDatabase() in bootstrap before accessing the database. ' +
        'See src/bootstrap.ts for the initialization sequence.',
    );
  }
  return db;
}

/**
 * Returns true if the database has been initialized via initDatabase().
 */
export function isDatabaseInitialized(): boolean {
  return db !== null;
}

/**
 * Close the database connection and release the handle.
 * The database stays open for the process lifetime in production.
 * This is provided for graceful shutdown and test teardown only.
 */
export function closeDatabase(): void {
  if (db !== null) {
    db.close();
    db = null;
  }
}

/**
 * Reset to an in-memory unencrypted database for Jest tests.
 * Never call this in production code.
 *
 * Returns the DB instance so tests can inspect the mock.
 */
export function resetDatabaseForTesting(): DB {
  db = open({ name: ':memory:' });
  db.executeSync('PRAGMA foreign_keys = ON');
  return db;
}
