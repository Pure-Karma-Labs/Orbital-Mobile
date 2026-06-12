import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { closeDatabase, resetDatabaseForTesting } from '../../connection';
import {
  getConversation,
  removeConversation,
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
});
