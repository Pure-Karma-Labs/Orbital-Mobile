import { closeDatabase } from '../../connection';
import { makeDb } from '../../testUtils/dbMockHelpers';
import {
  saveReply,
  saveReplyBatch,
  getRepliesForThread,
  deleteReply,
  deleteRepliesForThread,
  deleteRepliesForConversation,
  clearAllReplies,
} from '../../repositories/replyRepository';
import type { Reply } from '../../../types/store';

jest.mock('@op-engineering/op-sqlite', () => ({
  open: jest.fn(() => ({
    executeSync: jest.fn(() => ({ rows: [], rowsAffected: 0 })),
    close: jest.fn(),
  })),
}));

const sampleReply: Reply = {
  id: 'reply-1',
  threadId: 'thread-1',
  authorId: 'user-1',
  authorUsername: 'alice',
  body: 'Hello world',
  parentReplyId: null,
  depth: 0,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  syncStatus: 'synced',
};

describe('replyRepository', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  // =========================================================================
  // saveReply
  // =========================================================================

  describe('saveReply', () => {
    it('executes INSERT OR REPLACE with correct params and ms→s conversion', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      saveReply(sampleReply);

      const insertCall = exec.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT OR REPLACE'),
      ) as unknown as [string, unknown[]];
      expect(insertCall).toBeDefined();
      const params = insertCall[1];

      // Column order: id, thread_id, author_id, body, author_username,
      //               parent_reply_id, depth, created_at, updated_at, sync_status
      expect(params[0]).toBe('reply-1');
      expect(params[1]).toBe('thread-1');
      expect(params[2]).toBe('user-1');
      expect(params[3]).toBe('Hello world');
      expect(params[4]).toBe('alice');
      expect(params[5]).toBeNull();    // parentReplyId
      expect(params[6]).toBe(0);       // depth
      // ms→s: 1700000000000 / 1000 = 1700000000
      expect(params[7]).toBe(1700000000);
      expect(params[8]).toBe(1700000000);
      expect(params[9]).toBe('synced');
    });

    it('writes null body when reply.body is null', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      saveReply({ ...sampleReply, body: null });

      const insertCall = exec.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT OR REPLACE'),
      ) as unknown as [string, unknown[]];
      expect(insertCall).toBeDefined();
      expect(insertCall[1][3]).toBeNull();
    });

    it('writes parentReplyId when present', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      saveReply({ ...sampleReply, parentReplyId: 'parent-reply-1' });

      const insertCall = exec.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT OR REPLACE'),
      ) as unknown as [string, unknown[]];
      expect(insertCall).toBeDefined();
      expect(insertCall[1][5]).toBe('parent-reply-1');
    });

    it('no-ops when database is not initialized', () => {
      // No makeDb call — database is null
      saveReply(sampleReply);
      // No crash; isDatabaseInitialized() returns false
    });
  });

  // =========================================================================
  // saveReplyBatch
  // =========================================================================

  describe('saveReplyBatch', () => {
    it('wraps inserts in BEGIN IMMEDIATE / COMMIT', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      saveReplyBatch('thread-1', [sampleReply]);

      const sqlCalls = exec.mock.calls.map((c) => c[0]);
      expect(sqlCalls).toContain('BEGIN IMMEDIATE');
      expect(sqlCalls).toContain('COMMIT');
    });

    it('inserts each reply in the batch', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      const reply2: Reply = { ...sampleReply, id: 'reply-2' };
      saveReplyBatch('thread-1', [sampleReply, reply2]);

      const insertCalls = exec.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT OR REPLACE'),
      );
      expect(insertCalls).toHaveLength(2);
    });

    it('ROLLBACKs on error', () => {
      const exec = jest.fn((sql: string) => {
        if (typeof sql === 'string' && sql.includes('INSERT')) throw new Error('disk full');
        return { rows: [], rowsAffected: 0 };
      });
      makeDb(exec);

      expect(() => saveReplyBatch('thread-1', [sampleReply])).toThrow('disk full');
      const sqlCalls = exec.mock.calls.map((c) => c[0]);
      expect(sqlCalls).toContain('ROLLBACK');
      expect(sqlCalls).not.toContain('COMMIT');
    });

    it('no-ops on empty array', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 }));
      makeDb(exec);

      saveReplyBatch('thread-1', []);

      const sqlCalls = exec.mock.calls.map((c) => c[0]);
      expect(sqlCalls).not.toContain('BEGIN IMMEDIATE');
    });

    it('no-ops when database is not initialized', () => {
      // No makeDb call — database is null
      saveReplyBatch('thread-1', [sampleReply]);
      // No crash
    });

    it('normalises threadId for replies that have a different threadId', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      const wrongThread: Reply = { ...sampleReply, threadId: 'thread-other' };
      saveReplyBatch('thread-1', [wrongThread]);

      const insertCall = exec.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT OR REPLACE'),
      ) as unknown as [string, unknown[]];
      expect(insertCall).toBeDefined();
      // thread_id should be the declared batch threadId, not the reply's threadId
      expect(insertCall[1][1]).toBe('thread-1');
    });
  });

  // =========================================================================
  // getRepliesForThread
  // =========================================================================

  describe('getRepliesForThread', () => {
    it('maps rows to Reply[] with s→ms timestamp conversion', () => {
      const exec = jest.fn((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT')) {
          return {
            rows: [
              {
                id: 'reply-1',
                thread_id: 'thread-1',
                author_id: 'user-1',
                body: 'Hello',
                author_username: 'alice',
                parent_reply_id: null,
                depth: 0,
                created_at: 1700000000,
                updated_at: 1700000000,
                sync_status: 'synced',
              },
            ],
            rowsAffected: 0,
          };
        }
        return { rows: [], rowsAffected: 0 };
      });
      makeDb(exec);

      const replies = getRepliesForThread('thread-1');
      expect(replies).toHaveLength(1);
      // s→ms: 1700000000 * 1000 = 1700000000000
      expect(replies[0].createdAt).toBe(1700000000000);
      expect(replies[0].updatedAt).toBe(1700000000000);
      expect(replies[0].authorUsername).toBe('alice');
      expect(replies[0].body).toBe('Hello');
      expect(replies[0].depth).toBe(0);
      expect(replies[0].syncStatus).toBe('synced');
    });

    it('returns empty array when no rows match', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 }));
      makeDb(exec);

      const replies = getRepliesForThread('thread-no-replies');
      expect(replies).toEqual([]);
    });

    it('defaults authorUsername to empty string when null in DB', () => {
      const exec = jest.fn((sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT')) {
          return {
            rows: [
              {
                id: 'reply-1',
                thread_id: 'thread-1',
                author_id: 'user-1',
                body: null,
                author_username: null,
                parent_reply_id: null,
                depth: 1,
                created_at: 1700000000,
                updated_at: 1700000000,
                sync_status: 'synced',
              },
            ],
            rowsAffected: 0,
          };
        }
        return { rows: [], rowsAffected: 0 };
      });
      makeDb(exec);

      const replies = getRepliesForThread('thread-1');
      expect(replies[0].authorUsername).toBe('');
    });

    it('returns empty array when database not initialized', () => {
      // No makeDb call — database is null
      expect(getRepliesForThread('thread-1')).toEqual([]);
    });
  });

  // =========================================================================
  // delete operations
  // =========================================================================

  describe('delete operations', () => {
    it('deleteReply executes DELETE with id param', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      deleteReply('reply-1');

      const deleteCall = exec.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('DELETE'),
      ) as unknown as [string, unknown[]];
      expect(deleteCall).toBeDefined();
      expect(deleteCall[1]).toEqual(['reply-1']);
    });

    it('deleteRepliesForThread deletes by thread_id', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 3 }));
      makeDb(exec);

      deleteRepliesForThread('thread-1');

      const deleteCall = exec.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('DELETE'),
      ) as unknown as [string, unknown[]];
      expect(deleteCall).toBeDefined();
      expect(deleteCall[1]).toEqual(['thread-1']);
    });

    it('deleteRepliesForConversation uses subquery on orbital_threads', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 5 }));
      makeDb(exec);

      deleteRepliesForConversation('conv-1');

      const deleteCall = exec.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT id FROM orbital_threads'),
      ) as unknown as [string, unknown[]];
      expect(deleteCall).toBeDefined();
      expect(deleteCall[1]).toEqual(['conv-1']);
    });

    it('clearAllReplies deletes all rows', () => {
      const exec = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 10 }));
      makeDb(exec);

      clearAllReplies();

      const deleteCall = exec.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('DELETE FROM orbital_replies'),
      ) as unknown as [string, unknown[]];
      expect(deleteCall).toBeDefined();
    });

    it('deleteReply no-ops when database is not initialized', () => {
      deleteReply('reply-1');
      // No crash
    });

    it('deleteRepliesForThread no-ops when database is not initialized', () => {
      deleteRepliesForThread('thread-1');
      // No crash
    });

    it('deleteRepliesForConversation no-ops when database is not initialized', () => {
      deleteRepliesForConversation('conv-1');
      // No crash
    });

    it('clearAllReplies no-ops when database is not initialized', () => {
      clearAllReplies();
      // No crash
    });
  });
});
