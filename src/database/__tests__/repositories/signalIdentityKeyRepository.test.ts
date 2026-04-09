import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { closeDatabase, resetDatabaseForTesting } from '../../connection';
import {
  getIdentityKey,
  saveIdentityKey,
  removeIdentityKey,
  getAllIdentityKeys,
} from '../../repositories/signalIdentityKeyRepository';
import { VerifiedStatus } from '../../../types/database';

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

const sampleKey = new Uint8Array([1, 2, 3]);

describe('signalIdentityKeyRepository', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  describe('getIdentityKey', () => {
    it('queries by address', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getIdentityKey('alice');
      expect(executeSync).toHaveBeenCalledWith(
        'SELECT * FROM signal_identity_keys WHERE address = ?',
        ['alice'],
      );
    });

    it('returns null when not found', () => {
      makeDb(jest.fn(() => ({ rows: [], rowsAffected: 0 })));
      expect(getIdentityKey('nobody')).toBeNull();
    });

    it('returns the row when found', () => {
      makeDb(
        jest.fn(() => ({
          rows: [
            {
              address: 'bob',
              identity_key: sampleKey,
              verified: 1,
              first_use: 1000,
              nonblocking_approval: 0,
            },
          ],
          rowsAffected: 0,
        })),
      );
      const result = getIdentityKey('bob');
      expect(result?.address).toBe('bob');
      expect(result?.verified).toBe(1);
    });
  });

  describe('saveIdentityKey', () => {
    it('executes INSERT OR REPLACE with all columns', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      saveIdentityKey({
        address: 'carol',
        identity_key: sampleKey,
        verified: VerifiedStatus.Verified,
        first_use: 2000,
        nonblocking_approval: 1,
      });
      expect(executeSync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO signal_identity_keys'),
        ['carol', sampleKey, VerifiedStatus.Verified, 2000, 1],
      );
    });
  });

  describe('removeIdentityKey', () => {
    it('deletes by address', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      removeIdentityKey('dave');
      expect(executeSync).toHaveBeenCalledWith(
        'DELETE FROM signal_identity_keys WHERE address = ?',
        ['dave'],
      );
    });
  });

  describe('getAllIdentityKeys', () => {
    it('selects all rows without params', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getAllIdentityKeys();
      expect(executeSync).toHaveBeenCalledWith(
        'SELECT * FROM signal_identity_keys',
        undefined,
      );
    });

    it('returns all rows', () => {
      makeDb(
        jest.fn(() => ({
          rows: [
            {
              address: 'x',
              identity_key: sampleKey,
              verified: 0,
              first_use: 0,
              nonblocking_approval: 0,
            },
            {
              address: 'y',
              identity_key: sampleKey,
              verified: 0,
              first_use: 0,
              nonblocking_approval: 0,
            },
          ],
          rowsAffected: 0,
        })),
      );
      const result = getAllIdentityKeys();
      expect(result).toHaveLength(2);
      expect(result[0].address).toBe('x');
      expect(result[1].address).toBe('y');
    });
  });
});
