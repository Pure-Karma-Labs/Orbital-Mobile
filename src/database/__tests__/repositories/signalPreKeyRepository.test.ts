import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { closeDatabase, resetDatabaseForTesting } from '../../connection';
import {
  getPreKey,
  savePreKey,
  removePreKey,
} from '../../repositories/signalPreKeyRepository';

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

const sampleKeyData = new Uint8Array([1, 2, 3, 4]);

describe('signalPreKeyRepository', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  describe('getPreKey', () => {
    it('queries by id', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getPreKey(42);
      expect(executeSync).toHaveBeenCalledWith(
        'SELECT * FROM signal_pre_keys WHERE id = ?',
        [42],
      );
    });

    it('returns null when not found', () => {
      makeDb(jest.fn(() => ({ rows: [], rowsAffected: 0 })));
      expect(getPreKey(999)).toBeNull();
    });

    it('returns the row when found', () => {
      makeDb(
        jest.fn(() => ({
          rows: [{ id: 42, key_data: sampleKeyData, created_at: 1000 }],
          rowsAffected: 0,
        })),
      );
      const result = getPreKey(42);
      expect(result?.id).toBe(42);
      expect(result?.created_at).toBe(1000);
    });
  });

  describe('savePreKey', () => {
    it('executes INSERT OR REPLACE with all columns', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      savePreKey({ id: 42, key_data: sampleKeyData, created_at: 1000 });
      expect(executeSync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO signal_pre_keys'),
        [42, sampleKeyData, 1000],
      );
    });
  });

  describe('removePreKey', () => {
    it('deletes by id', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      removePreKey(42);
      expect(executeSync).toHaveBeenCalledWith(
        'DELETE FROM signal_pre_keys WHERE id = ?',
        [42],
      );
    });
  });
});
