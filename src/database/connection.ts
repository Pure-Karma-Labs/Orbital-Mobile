import { open, type DB } from '@op-engineering/op-sqlite';

let db: DB | null = null;

/**
 * Initialize the SQLCipher database with a 256-bit CSPRNG key.
 *
 * Must be called once during app bootstrap (see src/bootstrap.ts) after the
 * database encryption key is retrieved from Keychain.
 *
 * The key is passed to op-sqlite's `open()` as a bare hex string. SQLCipher's
 * `sqlite3_key_v2()` receives it as a length-delimited buffer (no SQL
 * wrapping) and derives the actual cipher key via PBKDF2.
 *
 * NEVER wrap the key in `x'...'` / `X'...'`. SQLCipher's raw-key detection
 * lives in the codec layer (`sqlcipher_cipher_ctx_key_derive`) and fires on
 * the key buffer regardless of the delivering API: a case-insensitive
 * `x'`/`X'` prefix + trailing `'` + hex body at any of the three AES-256
 * exact lengths (67 bytes — raw key, 99 bytes — raw key + salt, 163 bytes —
 * raw key + HMAC key + salt) bypasses PBKDF2 entirely, making the existing
 * `orbital.db` permanently unopenable.
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

  // Pass the bare hex string — see the function doc above for why it must
  // never be wrapped in x'...' / X'...'.
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
