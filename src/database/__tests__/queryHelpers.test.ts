import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { closeDatabase, resetDatabaseForTesting } from '../connection';
import { queryOne, queryMany, execute } from '../queryHelpers';

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

describe('queryHelpers', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  describe('queryOne', () => {
    it('returns null when no rows', () => {
      makeDb(jest.fn(() => ({ rows: [], rowsAffected: 0 })));
      const result = queryOne<{ id: string }>('SELECT * FROM items WHERE id = ?', ['missing']);
      expect(result).toBeNull();
    });

    it('returns the first row as a typed object', () => {
      makeDb(
        jest.fn(() => ({
          rows: [{ id: 'foo', value: 'bar' }],
          rowsAffected: 0,
        })),
      );
      const result = queryOne<{ id: string; value: string }>(
        'SELECT * FROM items WHERE id = ?',
        ['foo'],
      );
      expect(result).toEqual({ id: 'foo', value: 'bar' });
    });

    it('converts ArrayBuffer BLOB values to Uint8Array', () => {
      const buf = new ArrayBuffer(4);
      const view = new Uint8Array(buf);
      view[0] = 1; view[1] = 2; view[2] = 3; view[3] = 4;

      makeDb(
        jest.fn(() => ({
          rows: [{ id: 'k', key_data: buf }],
          rowsAffected: 0,
        })),
      );
      const result = queryOne<{ id: string; key_data: unknown }>(
        'SELECT * FROM signal_pre_keys WHERE id = ?',
        [1],
      );
      expect(result?.key_data).toBeInstanceOf(Uint8Array);
      expect(result?.key_data).toEqual(new Uint8Array([1, 2, 3, 4]));
    });

    it('passes sql and params to executeSync', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      queryOne<{ id: string }>('SELECT * FROM items WHERE id = ?', ['myid']);
      expect(executeSync).toHaveBeenCalledWith(
        'SELECT * FROM items WHERE id = ?',
        ['myid'],
      );
    });
  });

  describe('queryMany', () => {
    it('returns empty array when no rows', () => {
      makeDb(jest.fn(() => ({ rows: [], rowsAffected: 0 })));
      const result = queryMany<{ id: string }>('SELECT * FROM items');
      expect(result).toEqual([]);
    });

    it('returns all rows as typed objects', () => {
      makeDb(
        jest.fn(() => ({
          rows: [
            { id: 'a', value: '1' },
            { id: 'b', value: '2' },
          ],
          rowsAffected: 0,
        })),
      );
      const result = queryMany<{ id: string; value: string }>(
        'SELECT * FROM items',
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: 'a', value: '1' });
      expect(result[1]).toEqual({ id: 'b', value: '2' });
    });

    it('converts ArrayBuffer BLOBs to Uint8Array in each row', () => {
      const buf1 = new ArrayBuffer(2);
      new Uint8Array(buf1).set([0xaa, 0xbb]);
      const buf2 = new ArrayBuffer(2);
      new Uint8Array(buf2).set([0xcc, 0xdd]);

      makeDb(
        jest.fn(() => ({
          rows: [
            { id: 1, key_data: buf1 },
            { id: 2, key_data: buf2 },
          ],
          rowsAffected: 0,
        })),
      );
      const result = queryMany<{ id: number; key_data: Uint8Array }>(
        'SELECT * FROM signal_pre_keys',
      );
      expect(result[0].key_data).toBeInstanceOf(Uint8Array);
      expect(result[0].key_data).toEqual(new Uint8Array([0xaa, 0xbb]));
      expect(result[1].key_data).toEqual(new Uint8Array([0xcc, 0xdd]));
    });
  });

  describe('execute', () => {
    it('returns rowsAffected from the result', () => {
      makeDb(jest.fn(() => ({ rows: [], rowsAffected: 3 })));
      const result = execute('DELETE FROM items WHERE id = ?', ['gone']);
      expect(result).toEqual({ rowsAffected: 3 });
    });

    it('returns 0 rowsAffected when result has undefined rowsAffected', () => {
      makeDb(
        jest.fn(() => ({ rows: [], rowsAffected: undefined as unknown as number })),
      );
      const result = execute('DELETE FROM items');
      expect(result).toEqual({ rowsAffected: 0 });
    });

    it('passes sql and params to executeSync', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      execute('UPDATE items SET value = ? WHERE id = ?', ['v', 'k']);
      expect(executeSync).toHaveBeenCalledWith(
        'UPDATE items SET value = ? WHERE id = ?',
        ['v', 'k'],
      );
    });
  });
});
