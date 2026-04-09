import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { closeDatabase, resetDatabaseForTesting } from '../../connection';
import {
  getConversation,
  saveConversation,
  removeConversation,
  getActiveConversations,
  updateUnreadCount,
} from '../../repositories/conversationRepository';
import type { ConversationRow } from '../../../types/database';

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

const sampleConversation: ConversationRow = {
  id: 'conv-1',
  type: 'group',
  name: 'Family Chat',
  avatar_path: null,
  group_master_key: null,
  group_secret_params: null,
  group_public_params: null,
  group_version: 2,
  member_count: 3,
  active: 1,
  mute_until: null,
  last_message_at: 1000,
  unread_count: 2,
  created_at: 500,
  updated_at: 1000,
};

describe('conversationRepository', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  describe('getConversation', () => {
    it('queries by id', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getConversation('conv-1');
      expect(executeSync).toHaveBeenCalledWith(
        'SELECT * FROM conversations WHERE id = ?',
        ['conv-1'],
      );
    });

    it('returns null when not found', () => {
      makeDb(jest.fn(() => ({ rows: [], rowsAffected: 0 })));
      expect(getConversation('missing')).toBeNull();
    });

    it('returns the conversation row when found', () => {
      makeDb(
        jest.fn(() => ({
          rows: [{ ...sampleConversation }],
          rowsAffected: 0,
        })),
      );
      const result = getConversation('conv-1');
      expect(result?.id).toBe('conv-1');
      expect(result?.name).toBe('Family Chat');
    });
  });

  describe('saveConversation', () => {
    it('executes INSERT OR REPLACE with all 15 columns', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      saveConversation(sampleConversation);
      expect(executeSync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO conversations'),
        [
          'conv-1',
          'group',
          'Family Chat',
          null,
          null,
          null,
          null,
          2,
          3,
          1,
          null,
          1000,
          2,
          500,
          1000,
        ],
      );
    });

    it('passes null for nullable BLOB columns', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      saveConversation({
        ...sampleConversation,
        group_master_key: null,
        mute_until: null,
      });
      // group_master_key is param at index 4 (0-based), mute_until at index 10
      const params = (executeSync.mock.calls as unknown as [string, unknown[]][])
        .filter(([sql]) => sql.includes('INSERT OR REPLACE'))[0][1];
      expect(params[4]).toBeNull(); // group_master_key
      expect(params[10]).toBeNull(); // mute_until
    });
  });

  describe('removeConversation', () => {
    it('deletes by id', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      removeConversation('conv-1');
      expect(executeSync).toHaveBeenCalledWith(
        'DELETE FROM conversations WHERE id = ?',
        ['conv-1'],
      );
    });
  });

  describe('getActiveConversations', () => {
    it('queries with active=1 filter, ordered by last_message_at, with limit and offset', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);
      getActiveConversations(20, 40);
      const sqlCall = (executeSync.mock.calls as unknown as [string, unknown[]][]).find(
        ([sql]) => sql.includes('conversations'),
      );
      expect(sqlCall).toBeDefined();
      const [sql, params] = sqlCall!;
      expect(sql).toContain('WHERE active = 1');
      expect(sql).toContain('ORDER BY last_message_at DESC');
      expect(sql).toContain('LIMIT ? OFFSET ?');
      expect(params).toEqual([20, 40]);
    });

    it('returns conversation rows', () => {
      makeDb(
        jest.fn(() => ({
          rows: [sampleConversation, { ...sampleConversation, id: 'conv-2' }],
          rowsAffected: 0,
        })),
      );
      const result = getActiveConversations(10, 0);
      expect(result).toHaveLength(2);
      expect(result[1].id).toBe('conv-2');
    });
  });

  describe('updateUnreadCount', () => {
    it('updates unread_count for the given id', () => {
      const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(executeSync);
      updateUnreadCount('conv-1', 5);
      expect(executeSync).toHaveBeenCalledWith(
        'UPDATE conversations SET unread_count = ? WHERE id = ?',
        [5, 'conv-1'],
      );
    });
  });
});
