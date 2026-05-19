import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import {
  initDatabase,
  getDatabase,
  closeDatabase,
  resetDatabaseForTesting,
} from '../connection';

jest.mock('@op-engineering/op-sqlite', () => ({
  open: jest.fn(() => ({
    executeSync: jest.fn(() => ({ rows: [], rowsAffected: 0 })),
    close: jest.fn(),
  })),
}));

const mockOpen = open as jest.MockedFunction<typeof open>;

function makeMockDb() {
  const mockDb = {
    executeSync: jest.fn(() => ({ rows: [], rowsAffected: 0 })),
    close: jest.fn(),
  };
  mockOpen.mockReturnValueOnce(mockDb as unknown as DB);
  return mockDb;
}

describe('connection', () => {
  beforeEach(() => {
    // Reset module state between tests by closing any open db
    closeDatabase();
    jest.clearAllMocks();
  });

  describe('initDatabase', () => {
    it('opens the database with hex key passphrase', () => {
      makeMockDb();
      initDatabase('deadbeef');
      expect(mockOpen).toHaveBeenCalledWith({
        name: 'orbital.db',
        encryptionKey: 'deadbeef',
      });
    });

    it('sets security and performance PRAGMAs after opening', () => {
      const mockDb = makeMockDb();
      initDatabase('aabbccdd');
      const pragmaCalls = (
        mockDb.executeSync.mock.calls as unknown as [string][]
      ).map((c) => c[0]);
      expect(pragmaCalls).toContain('PRAGMA cipher_memory_security = ON');
      expect(pragmaCalls).toContain('PRAGMA journal_mode = WAL');
      expect(pragmaCalls).toContain('PRAGMA foreign_keys = ON');
      expect(pragmaCalls).toContain('PRAGMA busy_timeout = 5000');
    });

    it('cipher_memory_security is set before other PRAGMAs', () => {
      const mockDb = makeMockDb();
      initDatabase('aabbccdd');
      const pragmaCalls = (
        mockDb.executeSync.mock.calls as unknown as [string][]
      ).map((c) => c[0]);
      const securityIdx = pragmaCalls.indexOf(
        'PRAGMA cipher_memory_security = ON',
      );
      const walIdx = pragmaCalls.indexOf('PRAGMA journal_mode = WAL');
      expect(securityIdx).toBeLessThan(walIdx);
    });

    it('throws if called a second time', () => {
      makeMockDb();
      initDatabase('key1');
      expect(() => initDatabase('key2')).toThrow('Database already initialized');
    });
  });

  describe('getDatabase', () => {
    it('returns the db instance after init', () => {
      const mockDb = makeMockDb();
      initDatabase('testkey');
      expect(getDatabase()).toBe(mockDb);
    });

    it('throws before init with a descriptive message', () => {
      expect(() => getDatabase()).toThrow(
        'Database not initialized — call initDatabase() in bootstrap before accessing the database.',
      );
    });
  });

  describe('closeDatabase', () => {
    it('calls close on the db and allows re-init', () => {
      const mockDb = makeMockDb();
      initDatabase('mykey');
      closeDatabase();
      expect(mockDb.close).toHaveBeenCalledTimes(1);
      // After close, init should work again
      makeMockDb();
      initDatabase('mykey2');
      expect(mockOpen).toHaveBeenCalledTimes(2);
    });

    it('is a no-op when db is already null', () => {
      expect(() => closeDatabase()).not.toThrow();
    });
  });

  describe('resetDatabaseForTesting', () => {
    it('opens an in-memory database', () => {
      makeMockDb();
      resetDatabaseForTesting();
      expect(mockOpen).toHaveBeenCalledWith({ name: ':memory:' });
    });

    it('enables foreign keys after opening', () => {
      const mockDb = makeMockDb();
      resetDatabaseForTesting();
      expect(mockDb.executeSync).toHaveBeenCalledWith('PRAGMA foreign_keys = ON');
    });

    it('returns the db instance so tests can use it directly', () => {
      const mockDb = makeMockDb();
      const result = resetDatabaseForTesting();
      expect(result).toBe(mockDb);
    });
  });
});
