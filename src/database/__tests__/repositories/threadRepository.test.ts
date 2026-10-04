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
    it('executes INSERT OR REPLACE with correct params and writes epoch MILLISECONDS (#844)', () => {
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
      // No ms→s division since #844: the ms value is bound verbatim.
      // params: [9]=last_reply_at, [10]=created_at, [11]=updated_at
      expect(params[9]).toBe(1700000000000);
      expect(params[10]).toBe(1700000000000);
      expect(params[11]).toBe(1700000000000);
      // pinned false → 0
      expect(params[7]).toBe(0);
    });

    it('floors fractional ms without dividing', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      saveThread({
        ...sampleThread,
        lastReplyAt: 1758800000123.7,
        createdAt: 1758800000123.7,
        updatedAt: 1758800000456.2,
      });

      const insertCall = exec.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT OR REPLACE'),
      ) as unknown as [string, unknown[]];
      expect(insertCall).toBeDefined();
      const params = insertCall[1];
      expect(params[9]).toBe(1758800000123);
      expect(params[10]).toBe(1758800000123);
      expect(params[11]).toBe(1758800000456);
    });

    it('binds null for a null lastReplyAt', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      saveThread({ ...sampleThread, lastReplyAt: null });

      const insertCall = exec.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT OR REPLACE'),
      ) as unknown as [string, unknown[]];
      expect(insertCall).toBeDefined();
      expect(insertCall[1][9]).toBeNull();
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
    it('tolerantly reads a legacy epoch-SECONDS row (< 1e11) as ms', () => {
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
      expect(threads[0].lastReplyAt).toBe(1700000000000);
      expect(threads[0].updatedAt).toBe(1700000000000);
      expect(threads[0].pinned).toBe(true);
      expect(threads[0].authorUsername).toBe('alice');
    });

    it('reads a post-#844 epoch-ms row (>= 1e11) unchanged', () => {
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
              pinned: 0,
              reply_count: 5,
              last_reply_at: 1758800000123,
              created_at: 1758800000123,
              updated_at: 1758800000123,
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
      // >= 1e11 → already ms, used as-is
      expect(threads[0].createdAt).toBe(1758800000123);
      expect(threads[0].lastReplyAt).toBe(1758800000123);
      expect(threads[0].updatedAt).toBe(1758800000123);
    });

    it('keeps a null last_reply_at as null, never 0', () => {
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
              pinned: 0,
              reply_count: 0,
              last_reply_at: null,
              created_at: 1758800000123,
              updated_at: 1758800000123,
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
      expect(threads[0].lastReplyAt).toBeNull();
    });

    it('maps a mixed-precision pair to the correct chronological order', () => {
      // thread-old was written before #844 (seconds); thread-new after (ms).
      // thread-old's wall-clock time is earlier, and the mapped values must
      // preserve that ordering despite the different raw precisions.
      const exec = jest.fn((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT')) {
          return {
            rows: [
              {
                id: 'thread-old',
                conversation_id: 'conv-1',
                author_id: 'user-1',
                author_username: 'alice',
                title: 'Old (seconds row)',
                body: 'Old',
                content_type: 'text',
                pinned: 0,
                reply_count: 0,
                last_reply_at: null,
                created_at: 1758800000, // seconds: 2025-09-25T...Z
                updated_at: 1758800000,
                sync_status: 'synced',
              },
              {
                id: 'thread-new',
                conversation_id: 'conv-1',
                author_id: 'user-1',
                author_username: 'alice',
                title: 'New (ms row)',
                body: 'New',
                content_type: 'text',
                pinned: 0,
                reply_count: 0,
                last_reply_at: null,
                created_at: 1758800000123, // ms: 123 ms later
                updated_at: 1758800000123,
                sync_status: 'synced',
              },
            ],
            rowsAffected: 0,
          };
        }
        return { rows: [], rowsAffected: 0 };
      });
      makeDb(exec);

      const threads = getThreadsForConversation('conv-1');
      expect(threads).toHaveLength(2);
      const older = threads.find((t) => t.id === 'thread-old')!;
      const newer = threads.find((t) => t.id === 'thread-new')!;
      expect(older.createdAt).toBe(1758800000000);
      expect(newer.createdAt).toBe(1758800000123);
      expect(older.createdAt).toBeLessThan(newer.createdAt);
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

    it('tolerantly reads a legacy epoch-SECONDS row fetched by id as ms (#844)', () => {
      const exec = jest.fn((sql: string) => {
        if (typeof sql === 'string' && sql.includes('WHERE id = ?')) {
          return {
            rows: [{
              id: 'thread-legacy',
              conversation_id: 'conv-1',
              author_id: 'user-1',
              author_username: 'alice',
              title: 'Old',
              body: 'Row',
              content_type: 'text',
              pinned: 0,
              reply_count: 0,
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

      const thread = getThread('thread-legacy');
      expect(thread).not.toBeNull();
      expect(thread!.createdAt).toBe(1700000000000);
      expect(thread!.updatedAt).toBe(1700000000000);
      expect(thread!.lastReplyAt).toBe(1700000000000);
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
