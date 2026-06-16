import { closeDatabase } from '../../connection';
import { makeDb } from '../../testUtils/dbMockHelpers';
import {
  saveThread,
  saveThreadBatch,
  getThreadsForConversation,
  getThread,
  getConversationIdsWithThreads,
  deleteThread,
  deleteThreadsForConversation,
  clearAllThreads,
} from '../../repositories/threadRepository';
import type { Thread } from '../../../types/store';

jest.mock('@op-engineering/op-sqlite', () => ({
  open: jest.fn(() => ({
    executeSync: jest.fn(() => ({ rows: [], rowsAffected: 0 })),
    close: jest.fn(),
  })),
}));

const sampleThread: Thread = {
  id: 'thread-1',
  conversationId: 'conv-1',
  authorId: 'user-1',
  authorUsername: 'alice',
  title: 'Hello world',
  body: 'First post',
  contentType: 'text',
  pinned: false,
  replyCount: 3,
  lastReplyAt: 1700000000000,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  syncStatus: 'synced',
};

describe('threadRepository', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  describe('saveThread', () => {
    it('executes INSERT OR REPLACE with correct params and ms→s conversion', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      saveThread(sampleThread);

      const insertCall = exec.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT OR REPLACE'),
      ) as unknown as [string, unknown[]];
      expect(insertCall).toBeDefined();
      const params = insertCall[1];
      expect(params[0]).toBe('thread-1');
      expect(params[1]).toBe('conv-1');
      // ms→s: 1700000000000 / 1000 = 1700000000
      expect(params[10]).toBe(1700000000);
      expect(params[11]).toBe(1700000000);
      // pinned false → 0
      expect(params[7]).toBe(0);
    });

    it('no-ops when database is not initialized', () => {
      saveThread(sampleThread);
      // No crash, no calls — isDatabaseInitialized() returns false
    });
  });

  describe('saveThreadBatch', () => {
    it('wraps inserts in BEGIN IMMEDIATE / COMMIT', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      saveThreadBatch('conv-1', [sampleThread]);

      const sqlCalls = exec.mock.calls.map((c) => c[0]);
      expect(sqlCalls).toContain('BEGIN IMMEDIATE');
      expect(sqlCalls).toContain('COMMIT');
    });

    it('ROLLBACKs on error', () => {
      const exec = jest.fn((sql: string) => {
        if (typeof sql === 'string' && sql.includes('INSERT')) throw new Error('disk full');
        return { rows: [], rowsAffected: 0 };
      });
      makeDb(exec);

      expect(() => saveThreadBatch('conv-1', [sampleThread])).toThrow('disk full');
      const sqlCalls = exec.mock.calls.map((c) => c[0]);
      expect(sqlCalls).toContain('ROLLBACK');
      expect(sqlCalls).not.toContain('COMMIT');
    });

    it('no-ops on empty array', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 }));
      makeDb(exec);

      saveThreadBatch('conv-1', []);
      const sqlCalls = exec.mock.calls.map((c) => c[0]);
      expect(sqlCalls).not.toContain('BEGIN IMMEDIATE');
    });
  });

  describe('getThreadsForConversation', () => {
    it('maps rows with s→ms timestamp conversion', () => {
      const exec = jest.fn((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT')) {
          return {
            rows: [{
              id: 'thread-1',
              conversation_id: 'conv-1',
              author_id: 'user-1',
              author_username: 'alice',
              title: 'Hello',
              body: 'World',
              content_type: 'text',
              pinned: 1,
              reply_count: 5,
              last_reply_at: 1700000000,
              created_at: 1700000000,
              updated_at: 1700000000,
              sync_status: 'synced',
            }],
            rowsAffected: 0,
          };
        }
        return { rows: [], rowsAffected: 0 };
      });
      makeDb(exec);

      const threads = getThreadsForConversation('conv-1');
      expect(threads).toHaveLength(1);
      expect(threads[0].createdAt).toBe(1700000000000);
      expect(threads[0].pinned).toBe(true);
      expect(threads[0].authorUsername).toBe('alice');
    });

    it('returns empty array when database not initialized', () => {
      expect(getThreadsForConversation('conv-1')).toEqual([]);
    });
  });

  describe('getThread', () => {
    it('returns null when not found', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 }));
      makeDb(exec);
      expect(getThread('nonexistent')).toBeNull();
    });
  });

  describe('getConversationIdsWithThreads', () => {
    it('returns distinct conversation IDs', () => {
      const exec = jest.fn((sql: string) => {
        if (typeof sql === 'string' && sql.includes('DISTINCT')) {
          return { rows: [{ conversation_id: 'c1' }, { conversation_id: 'c2' }], rowsAffected: 0 };
        }
        return { rows: [], rowsAffected: 0 };
      });
      makeDb(exec);
      expect(getConversationIdsWithThreads()).toEqual(['c1', 'c2']);
    });
  });

  describe('delete operations', () => {
    it('deleteThread executes DELETE with id param', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);
      deleteThread('thread-1');
      const deleteCall = exec.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('DELETE'),
      ) as unknown as [string, unknown[]];
      expect(deleteCall).toBeDefined();
      expect(deleteCall[1]).toEqual(['thread-1']);
    });

    it('deleteThreadsForConversation deletes by conversation_id', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 3 }));
      makeDb(exec);
      deleteThreadsForConversation('conv-1');
      const deleteCall = exec.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('DELETE'),
      ) as unknown as [string, unknown[]];
      expect(deleteCall).toBeDefined();
      expect(deleteCall[1]).toEqual(['conv-1']);
    });

    it('clearAllThreads deletes all rows', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 10 }));
      makeDb(exec);
      clearAllThreads();
      const deleteCall = exec.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('DELETE FROM orbital_threads'),
      ) as unknown as [string, unknown[]];
      expect(deleteCall).toBeDefined();
    });
  });
});
