import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { closeDatabase, resetDatabaseForTesting } from '../../connection';
import {
  getItem,
  setItem,
  removeItem,
  getAllItems,
} from '../../repositories/itemRepository';

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

describe('itemRepository', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  describe('getItem', () => {
    it('queries by id', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getItem('registrationIdMap');
      expect(executeSync).toHaveBeenCalledWith(
        'SELECT * FROM items WHERE id = ?',
        ['registrationIdMap'],
      );
    });

    it('returns null when not found', () => {
      makeDb(jest.fn(() => ({ rows: [], rowsAffected: 0 })));
      expect(getItem('missing')).toBeNull();
    });

    it('returns the value string when found', () => {
      makeDb(
        jest.fn(() => ({
          rows: [{ id: 'registrationIdMap', value: '{"default":42}' }],
          rowsAffected: 0,
        })),
      );
      expect(getItem('registrationIdMap')).toBe('{"default":42}');
    });
  });

  describe('setItem', () => {
    it('executes INSERT OR REPLACE with id and value', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      setItem('profileKey', '{"key":"abc"}');
      expect(executeSync).toHaveBeenCalledWith(
        'INSERT OR REPLACE INTO items (id, value) VALUES (?, ?)',
        ['profileKey', '{"key":"abc"}'],
      );
    });
  });

  describe('removeItem', () => {
    it('deletes by id', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      removeItem('profileKey');
      expect(executeSync).toHaveBeenCalledWith(
        'DELETE FROM items WHERE id = ?',
        ['profileKey'],
      );
    });
  });

  describe('getAllItems', () => {
    it('selects all rows without params', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getAllItems();
      // queryMany passes undefined as params when none given
      expect(executeSync).toHaveBeenCalledWith(
        'SELECT * FROM items',
        undefined,
      );
    });

    it('returns all item rows', () => {
      makeDb(
        jest.fn(() => ({
          rows: [
            { id: 'a', value: '1' },
            { id: 'b', value: '2' },
          ],
          rowsAffected: 0,
        })),
      );
      const result = getAllItems();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: 'a', value: '1' });
      expect(result[1]).toEqual({ id: 'b', value: '2' });
    });
  });
});
