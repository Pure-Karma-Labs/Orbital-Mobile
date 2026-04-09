import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { closeDatabase, resetDatabaseForTesting } from '../../connection';
import {
  getSession,
  saveSession,
  removeSession,
  getSessionsForService,
  removeAllSessionsForService,
} from '../../repositories/signalSessionRepository';

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

const sampleRecord = new Uint8Array([10, 20, 30]);

describe('signalSessionRepository', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  describe('getSession', () => {
    it('queries by composite key', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getSession('ourId', 'theirId', 1);
      expect(executeSync).toHaveBeenCalledWith(
        'SELECT * FROM signal_sessions WHERE our_service_id = ? AND service_id = ? AND device_id = ?',
        ['ourId', 'theirId', 1],
      );
    });

    it('returns null when not found', () => {
      makeDb(jest.fn(() => ({ rows: [], rowsAffected: 0 })));
      expect(getSession('ourId', 'nobody', 1)).toBeNull();
    });

    it('returns the row when found', () => {
      makeDb(
        jest.fn(() => ({
          rows: [
            {
              our_service_id: 'ourId',
              service_id: 'theirId',
              device_id: 1,
              record: sampleRecord,
              version: 2,
            },
          ],
          rowsAffected: 0,
        })),
      );
      const result = getSession('ourId', 'theirId', 1);
      expect(result?.service_id).toBe('theirId');
      expect(result?.device_id).toBe(1);
      expect(result?.version).toBe(2);
    });
  });

  describe('saveSession', () => {
    it('executes INSERT OR REPLACE with all columns', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      saveSession({
        our_service_id: 'ourId',
        service_id: 'theirId',
        device_id: 1,
        record: sampleRecord,
        version: 2,
      });
      expect(executeSync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO signal_sessions'),
        ['ourId', 'theirId', 1, sampleRecord, 2],
      );
    });
  });

  describe('removeSession', () => {
    it('deletes by composite key', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      removeSession('ourId', 'theirId', 1);
      expect(executeSync).toHaveBeenCalledWith(
        'DELETE FROM signal_sessions WHERE our_service_id = ? AND service_id = ? AND device_id = ?',
        ['ourId', 'theirId', 1],
      );
    });
  });

  describe('getSessionsForService', () => {
    it('queries by service_id only', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getSessionsForService('theirId');
      expect(executeSync).toHaveBeenCalledWith(
        'SELECT * FROM signal_sessions WHERE service_id = ?',
        ['theirId'],
      );
    });

    it('returns multiple rows', () => {
      makeDb(
        jest.fn(() => ({
          rows: [
            {
              our_service_id: 'ourId',
              service_id: 'theirId',
              device_id: 1,
              record: sampleRecord,
              version: 2,
            },
            {
              our_service_id: 'ourId',
              service_id: 'theirId',
              device_id: 2,
              record: sampleRecord,
              version: 2,
            },
          ],
          rowsAffected: 0,
        })),
      );
      const result = getSessionsForService('theirId');
      expect(result).toHaveLength(2);
      expect(result[0].device_id).toBe(1);
      expect(result[1].device_id).toBe(2);
    });
  });

  describe('removeAllSessionsForService', () => {
    it('deletes all sessions for service_id', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 3 }));
      makeDb(executeSync);
      removeAllSessionsForService('theirId');
      expect(executeSync).toHaveBeenCalledWith(
        'DELETE FROM signal_sessions WHERE service_id = ?',
        ['theirId'],
      );
    });
  });
});
