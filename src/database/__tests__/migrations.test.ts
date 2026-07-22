import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { closeDatabase, resetDatabaseForTesting } from '../connection';
import { runMigrations } from '../migrations';

jest.mock('@op-engineering/op-sqlite', () => ({
  open: jest.fn(() => ({
    executeSync: jest.fn(() => ({ rows: [], rowsAffected: 0 })),
    close: jest.fn(),
  })),
}));

const mockOpen = open as jest.MockedFunction<typeof open>;

function makeDb(executeSync: jest.Mock) {
  const mockDb = { executeSync, close: jest.fn() };
  mockOpen.mockReturnValueOnce(mockDb as unknown as DB);
  resetDatabaseForTesting();
  return mockDb;
}

describe('runMigrations', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  it('runs pending migration and wraps it in a transaction when user_version is 0', () => {
    const executeSync = jest.fn((sql: string) => {
      if (sql === 'PRAGMA user_version') {
        return { rows: [{ user_version: 0 }], rowsAffected: 0 };
      }
      return { rows: [], rowsAffected: 0 };
    });
    makeDb(executeSync);
    runMigrations();

    const sqls = (executeSync.mock.calls as unknown as [string][]).map(
      ([sql]) => sql,
    );
    expect(sqls).toContain('BEGIN TRANSACTION');
    expect(sqls).toContain('COMMIT');
  });

  it('sets user_version to 1 after running migration 001', () => {
    const appliedPragmas: string[] = [];
    const executeSync = jest.fn((sql: string) => {
      if (sql === 'PRAGMA user_version') {
        return { rows: [{ user_version: 0 }], rowsAffected: 0 };
      }
      if (sql.startsWith('PRAGMA user_version =')) {
        appliedPragmas.push(sql);
      }
      return { rows: [], rowsAffected: 0 };
    });
    makeDb(executeSync);
    runMigrations();
    expect(appliedPragmas).toContain('PRAGMA user_version = 1');
  });

  it('skips migration that has already been applied', () => {
    const executeSync = jest.fn((sql: string) => {
      if (sql === 'PRAGMA user_version') {
        return { rows: [{ user_version: 8 }], rowsAffected: 0 };
      }
      return { rows: [], rowsAffected: 0 };
    });
    makeDb(executeSync);
    runMigrations();

    const sqls = (executeSync.mock.calls as unknown as [string][]).map(
      ([sql]) => sql,
    );
    expect(sqls).not.toContain('BEGIN TRANSACTION');
    expect(sqls).not.toContain('COMMIT');
  });

  it('runs v7 migration adding archive_confirmed column', () => {
    const executeSync = jest.fn((sql: string) => {
      if (sql === 'PRAGMA user_version') {
        return { rows: [{ user_version: 6 }], rowsAffected: 0 };
      }
      return { rows: [], rowsAffected: 0 };
    });
    makeDb(executeSync);
    runMigrations();

    const sqls = (executeSync.mock.calls as unknown as [string][]).map(
      ([sql]) => sql,
    );
    // V7 SQL runs and contains the archive_confirmed column
    const v7Sql = sqls.find((s) => s.includes('archive_confirmed'));
    expect(v7Sql).toBeDefined();
    expect(v7Sql).toContain('ALTER TABLE orbital_media ADD COLUMN archive_confirmed');
    expect(v7Sql).toContain('INTEGER NOT NULL DEFAULT 0');
    // user_version set to 7
    expect(sqls).toContain('PRAGMA user_version = 7');
    // V7 does NOT disable foreign keys (no disableForeignKeys flag)
    // Only one FK disable pair for the already-applied v4 migration is possible,
    // but since v6 was already applied, no FK disable should occur
    const fkOffCount = sqls.filter((s) => s === 'PRAGMA foreign_keys = OFF').length;
    expect(fkOffCount).toBe(0);
  });

  it('runs v8 migration dropping dead media sync tables', () => {
    const executeSync = jest.fn((sql: string) => {
      if (sql === 'PRAGMA user_version') {
        return { rows: [{ user_version: 7 }], rowsAffected: 0 };
      }
      return { rows: [], rowsAffected: 0 };
    });
    makeDb(executeSync);
    runMigrations();

    const sqls = (executeSync.mock.calls as unknown as [string][]).map(
      ([sql]) => sql,
    );
    // V8 SQL drops both media sync tables
    const v8Sql = sqls.find((s) => s.includes('orbital_media_sync_requests'));
    expect(v8Sql).toBeDefined();
    expect(v8Sql).toContain('DROP TABLE IF EXISTS orbital_media_sync_requests');
    expect(v8Sql).toContain('DROP TABLE IF EXISTS orbital_media_sync_pending_uploads');
    // user_version set to 8
    expect(sqls).toContain('PRAGMA user_version = 8');
    // V8 does NOT disable foreign keys (no disableForeignKeys flag)
    const fkOffCount = sqls.filter((s) => s === 'PRAGMA foreign_keys = OFF').length;
    expect(fkOffCount).toBe(0);
  });

  it('disables foreign keys around V3 migration (table rebuild)', () => {
    const executeSync = jest.fn((sql: string) => {
      if (sql === 'PRAGMA user_version') {
        return { rows: [{ user_version: 2 }], rowsAffected: 0 };
      }
      return { rows: [], rowsAffected: 0 };
    });
    makeDb(executeSync);
    runMigrations();

    const sqls = (executeSync.mock.calls as unknown as [string][]).map(
      ([sql]) => sql,
    );

    const fkOff = sqls.indexOf('PRAGMA foreign_keys = OFF');
    const fkOn = sqls.lastIndexOf('PRAGMA foreign_keys = ON');
    const fkCheck = sqls.lastIndexOf('PRAGMA foreign_key_check');
    const v3Version = sqls.indexOf('PRAGMA user_version = 3');

    expect(fkOff).toBeGreaterThanOrEqual(0);
    expect(fkOn).toBeGreaterThan(v3Version);
    expect(fkCheck).toBeGreaterThan(fkOn);
    expect(v3Version).toBeGreaterThan(fkOff);
  });

  it('rolls back and rethrows on migration error', () => {
    const executeSync = jest.fn((sql: string) => {
      if (sql === 'PRAGMA user_version') {
        return { rows: [{ user_version: 0 }], rowsAffected: 0 };
      }
      if (sql.startsWith('PRAGMA user_version =')) {
        throw new Error('disk I/O error');
      }
      return { rows: [], rowsAffected: 0 };
    });
    makeDb(executeSync);
    expect(() => runMigrations()).toThrow('disk I/O error');

    const sqls = (executeSync.mock.calls as unknown as [string][]).map(
      ([sql]) => sql,
    );
    expect(sqls).toContain('ROLLBACK');
  });
});
