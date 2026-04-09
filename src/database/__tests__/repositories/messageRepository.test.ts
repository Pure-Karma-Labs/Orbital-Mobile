import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { closeDatabase, resetDatabaseForTesting } from '../../connection';
import {
  getMessage,
  saveMessage,
  saveMessages,
  getMessagesForConversation,
  markAsRead,
  deleteExpiredMessages,
} from '../../repositories/messageRepository';
import type { MessageRow } from '../../../types/database';

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

const sampleMessage: MessageRow = {
  id: 'msg-1',
  conversation_id: 'conv-1',
  sender_id: 'user-abc',
  type: 'message',
  body_encrypted: null,
  body_iv: null,
  server_timestamp: 2000,
  received_at: 2001,
  read: 0,
  expires_at: null,
};

describe('messageRepository', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  describe('getMessage', () => {
    it('queries by id', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getMessage('msg-1');
      expect(executeSync).toHaveBeenCalledWith(
        'SELECT * FROM messages WHERE id = ?',
        ['msg-1'],
      );
    });

    it('returns null when not found', () => {
      makeDb(jest.fn(() => ({ rows: [], rowsAffected: 0 })));
      expect(getMessage('missing')).toBeNull();
    });

    it('returns the message row when found', () => {
      makeDb(
        jest.fn(() => ({
          rows: [{ ...sampleMessage }],
          rowsAffected: 0,
        })),
      );
      const result = getMessage('msg-1');
      expect(result?.id).toBe('msg-1');
      expect(result?.sender_id).toBe('user-abc');
    });
  });

  describe('saveMessage', () => {
    it('executes INSERT OR REPLACE with all 10 columns', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      saveMessage(sampleMessage);
      expect(executeSync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO messages'),
        [
          'msg-1',
          'conv-1',
          'user-abc',
          'message',
          null,
          null,
          2000,
          2001,
          0,
          null,
        ],
      );
    });

    it('passes null for nullable fields', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      saveMessage({ ...sampleMessage, body_encrypted: null, expires_at: null });
      const calls = executeSync.mock.calls as unknown as [string, unknown[]][];
      const insertCall = calls.find(([sql]) => sql.includes('INSERT OR REPLACE INTO messages'));
      expect(insertCall).toBeDefined();
      const params = insertCall![1];
      expect(params[4]).toBeNull(); // body_encrypted
      expect(params[9]).toBeNull(); // expires_at
    });
  });

  describe('saveMessages', () => {
    it('wraps batch in a transaction', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      saveMessages([sampleMessage, { ...sampleMessage, id: 'msg-2' }]);
      const sqls = (executeSync.mock.calls as unknown as [string][]).map(
        ([sql]) => sql,
      );
      expect(sqls).toContain('BEGIN TRANSACTION');
      expect(sqls).toContain('COMMIT');
      const insertCount = sqls.filter((s) =>
        s.includes('INSERT OR REPLACE INTO messages'),
      ).length;
      expect(insertCount).toBe(2);
    });

    it('rolls back on error and rethrows', () => {
      let insertCallCount = 0;
      const executeSync = jest.fn((sql: string) => {
        if (sql.includes('INSERT OR REPLACE INTO messages')) {
          insertCallCount++;
          if (insertCallCount >= 2) {
            throw new Error('write error');
          }
        }
        return { rows: [], rowsAffected: 1 };
      });
      makeDb(executeSync);
      expect(() =>
        saveMessages([sampleMessage, { ...sampleMessage, id: 'msg-2' }]),
      ).toThrow('write error');
      const sqls = (executeSync.mock.calls as unknown as [string][]).map(
        ([sql]) => sql,
      );
      expect(sqls).toContain('ROLLBACK');
    });
  });

  describe('getMessagesForConversation', () => {
    it('queries without cursor when beforeTimestamp is omitted', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getMessagesForConversation('conv-1', 50);
      const calls = executeSync.mock.calls as unknown as [string, unknown[]][];
      const msgCall = calls.find(([sql]) => sql.includes('FROM messages'));
      expect(msgCall).toBeDefined();
      const [sql, params] = msgCall!;
      expect(sql).toContain('WHERE conversation_id = ?');
      expect(sql).toContain('ORDER BY server_timestamp DESC');
      expect(sql).not.toContain('AND server_timestamp <');
      expect(params).toEqual(['conv-1', 50]);
    });

    it('queries with cursor when beforeTimestamp is provided', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getMessagesForConversation('conv-1', 20, 9999);
      const calls = executeSync.mock.calls as unknown as [string, unknown[]][];
      const msgCall = calls.find(([sql]) => sql.includes('AND server_timestamp <'));
      expect(msgCall).toBeDefined();
      expect(msgCall![1]).toEqual(['conv-1', 9999, 20]);
    });

    it('returns messages', () => {
      makeDb(
        jest.fn(() => ({
          rows: [sampleMessage, { ...sampleMessage, id: 'msg-2' }],
          rowsAffected: 0,
        })),
      );
      const result = getMessagesForConversation('conv-1', 10);
      expect(result).toHaveLength(2);
    });
  });

  describe('markAsRead', () => {
    it('updates read=1 for the given id', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      markAsRead('msg-1');
      expect(executeSync).toHaveBeenCalledWith(
        'UPDATE messages SET read = 1 WHERE id = ?',
        ['msg-1'],
      );
    });
  });

  describe('deleteExpiredMessages', () => {
    it('deletes messages where expires_at is in the past', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 3 }));
      makeDb(executeSync);
      const deleted = deleteExpiredMessages();
      expect(executeSync).toHaveBeenCalledWith(
        'DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < ?',
        [expect.any(Number)],
      );
      expect(deleted).toBe(3);
    });

    it('passes a unix epoch timestamp in seconds', () => {
      const before = Math.floor(Date.now() / 1000);
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      deleteExpiredMessages();
      const after = Math.floor(Date.now() / 1000);
      const calls = executeSync.mock.calls as unknown as [string, number[]][];
      const deleteCall = calls.find(([sql]) =>
        sql.includes('DELETE FROM messages'),
      );
      expect(deleteCall).toBeDefined();
      const ts = deleteCall![1][0];
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });
});
