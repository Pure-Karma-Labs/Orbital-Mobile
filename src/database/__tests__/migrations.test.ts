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
        return { rows: [{ user_version: 3 }], rowsAffected: 0 };
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
