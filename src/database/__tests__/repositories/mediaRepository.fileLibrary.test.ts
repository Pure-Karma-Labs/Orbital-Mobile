/**
 * Tests for File Library repository functions:
 *   getAllMedia, getMediaCount, getLocalStorageUsage, getMediaConversationIds
 *
 * Follows the same mocking pattern as mediaRepository.test.ts.
 */

import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { closeDatabase, resetDatabaseForTesting } from '../../connection';
import {
  getAllMedia,
  getMediaCount,
  getLocalStorageUsage,
  getMediaConversationIds,
} from '../../repositories/mediaRepository';

jest.mock('@op-engineering/op-sqlite', () => ({
  open: jest.fn(() => ({
    executeSync: jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 })),
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

describe('mediaRepository — File Library queries', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // getAllMedia
  // -------------------------------------------------------------------------

  describe('getAllMedia', () => {
    it('returns empty array when database is not initialized', () => {
      // Don't call resetDatabaseForTesting — DB stays null
      closeDatabase();
      const result = getAllMedia({
        limit: 30,
        offset: 0,
        sortBy: 'date',
        sortOrder: 'desc',
      });
      expect(result).toEqual([]);
    });

    it('builds correct SQL with default filters (no contentType, no conversationId)', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);

      getAllMedia({ limit: 30, offset: 0, sortBy: 'date', sortOrder: 'desc' });

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT m.*'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      expect(selectCall[0]).toContain('ORDER BY m.created_at DESC');
      expect(selectCall[0]).toContain('LIMIT ? OFFSET ?');
      expect(selectCall[1]).toEqual([30, 0]);
    });

    it('applies image content type filter', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);

      getAllMedia({
        limit: 30,
        offset: 0,
        sortBy: 'date',
        sortOrder: 'desc',
        contentTypeFilter: 'image',
      });

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT m.*'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      expect(selectCall[0]).toContain("m.content_type LIKE ?");
      expect(selectCall[1]).toContain('image/%');
    });

    it('applies video content type filter', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);

      getAllMedia({
        limit: 30,
        offset: 0,
        sortBy: 'date',
        sortOrder: 'desc',
        contentTypeFilter: 'video',
      });

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT m.*'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      expect(selectCall[1]).toContain('video/%');
    });

    it('applies document content type filter (NOT LIKE image/% AND NOT LIKE video/%)', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);

      getAllMedia({
        limit: 30,
        offset: 0,
        sortBy: 'date',
        sortOrder: 'desc',
        contentTypeFilter: 'document',
      });

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT m.*'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      expect(selectCall[0]).toContain("NOT LIKE 'image/%'");
      expect(selectCall[0]).toContain("NOT LIKE 'video/%'");
    });

    it('applies conversationId filter', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);

      getAllMedia({
        limit: 30,
        offset: 0,
        sortBy: 'date',
        sortOrder: 'desc',
        conversationId: 'conv-1',
      });

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT m.*'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      expect(selectCall[0]).toContain('COALESCE(t.conversation_id, rt.conversation_id) = ?');
      expect(selectCall[1]).toContain('conv-1');
    });

    it('uses allowlisted sort columns — size ASC', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);

      getAllMedia({ limit: 30, offset: 0, sortBy: 'size', sortOrder: 'asc' });

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT m.*'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      expect(selectCall[0]).toContain('ORDER BY m.file_size ASC');
    });

    it('returns rows from the query', () => {
      const sampleRow = {
        id: 'media-1',
        content_type: 'image/png',
        file_size: 1024,
        conversation_id: 'conv-1',
        download_state: 'pending',
        upload_state: 'done',
        created_at: 1700000000000,
      };
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [sampleRow],
        rowsAffected: 0,
      }));
      makeDb(executeSync);

      const result = getAllMedia({ limit: 30, offset: 0, sortBy: 'date', sortOrder: 'desc' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('media-1');
    });

    // -----------------------------------------------------------------------
    // excludeAuthorIds (#897) — the ONE author-exclusion channel, on options,
    // so the grid applies it too. Every property here is silent when wrong: a
    // dropped clause shows a blocked author's media in the File Library, and an
    // always-present clause pins a behaviour that is off by default.
    // -----------------------------------------------------------------------

    it('excludes the given authors with one placeholder each', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [],
        rowsAffected: 0,
      }));
      makeDb(executeSync);

      getAllMedia({
        limit: 30,
        offset: 0,
        sortBy: 'date',
        sortOrder: 'desc',
        excludeAuthorIds: ['u1', 'u2'],
      });

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT m.*'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      // COALESCE, because `NULL NOT IN (…)` is NULL and would filter the row OUT.
      expect(selectCall[0]).toContain(
        "COALESCE(CASE WHEN m.reply_id IS NOT NULL THEN r.author_id ELSE t.author_id END, '') NOT IN (?, ?)",
      );
      expect(selectCall[1]).toEqual(['u1', 'u2', 30, 0]);
    });

    it('emits NO author clause for an empty array', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [],
        rowsAffected: 0,
      }));
      makeDb(executeSync);

      getAllMedia({
        limit: 30,
        offset: 0,
        sortBy: 'date',
        sortOrder: 'desc',
        excludeAuthorIds: [],
      });

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT m.*'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      expect(selectCall[0]).not.toContain('NOT IN');
      expect(selectCall[1]).toEqual([30, 0]);
    });

    it('emits NO author clause when the field is absent', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [],
        rowsAffected: 0,
      }));
      makeDb(executeSync);

      getAllMedia({ limit: 30, offset: 0, sortBy: 'date', sortOrder: 'desc' });

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT m.*'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      expect(selectCall[0]).not.toContain('NOT IN');
    });

    it('never adds the membership IN clause — the grid takes no access filter', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [],
        rowsAffected: 0,
      }));
      makeDb(executeSync);

      getAllMedia({
        limit: 30,
        offset: 0,
        sortBy: 'date',
        sortOrder: 'desc',
        excludeAuthorIds: ['u1', 'u2'],
      });

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT m.*'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      // Leaving an orbit leaves its orbital_media rows behind; those orphans
      // keep showing under "All Orbits" (Alex 2026-10-09).
      expect(selectCall[0]).not.toContain('COALESCE(t.conversation_id, rt.conversation_id) IN (');
      // The author NOT IN is the only ` IN (` the grid ever emits.
      expect((selectCall[0] as string).match(/ IN \(/g)).toHaveLength(1);
    });

    it('orders the params access → authors → conversation → content type', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [],
        rowsAffected: 0,
      }));
      makeDb(executeSync);

      getAllMedia({
        limit: 30,
        offset: 5,
        sortBy: 'date',
        sortOrder: 'desc',
        conversationId: 'conv-1',
        contentTypeFilter: 'image',
        excludeAuthorIds: ['u1', 'u2'],
      });

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT m.*'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      // By value AND index: a misordered bind is a silent wrong-filter bug
      // that every `toContain` assertion above would still pass.
      expect(selectCall[1]).toEqual(['u1', 'u2', 'conv-1', 'image/%', 30, 5]);
      expect(selectCall[1][0]).toBe('u1');
      expect(selectCall[1][1]).toBe('u2');
      expect(selectCall[1][2]).toBe('conv-1');
      expect(selectCall[1][3]).toBe('image/%');
      expect(selectCall[1][4]).toBe(30);
      expect(selectCall[1][5]).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // getMediaCount
  // -------------------------------------------------------------------------

  describe('getMediaCount', () => {
    it('returns 0 when database is not initialized', () => {
      closeDatabase();
      const result = getMediaCount({
        limit: 30,
        offset: 0,
        sortBy: 'date',
        sortOrder: 'desc',
      });
      expect(result).toBe(0);
    });

    it('returns count from query', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [{ cnt: 42 }],
        rowsAffected: 0,
      }));
      makeDb(executeSync);

      const result = getMediaCount({
        limit: 30,
        offset: 0,
        sortBy: 'date',
        sortOrder: 'desc',
      });
      expect(result).toBe(42);
    });

    it('applies contentType and conversationId filters', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [{ cnt: 5 }],
        rowsAffected: 0,
      }));
      makeDb(executeSync);

      getMediaCount({
        limit: 30,
        offset: 0,
        sortBy: 'date',
        sortOrder: 'desc',
        contentTypeFilter: 'image',
        conversationId: 'conv-1',
      });

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('COUNT(*)'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      expect(selectCall[0]).toContain('COALESCE(t.conversation_id, rt.conversation_id) = ?');
      expect(selectCall[0]).toContain('m.content_type LIKE ?');
      expect(selectCall[1]).toContain('conv-1');
      expect(selectCall[1]).toContain('image/%');
    });

    it('excludes the given authors with one placeholder each', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [{ cnt: 3 }],
        rowsAffected: 0,
      }));
      makeDb(executeSync);

      getMediaCount({
        limit: 30,
        offset: 0,
        sortBy: 'date',
        sortOrder: 'desc',
        excludeAuthorIds: ['u1', 'u2'],
      });

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('COUNT(*)'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      expect(selectCall[0]).toContain(
        "COALESCE(CASE WHEN m.reply_id IS NOT NULL THEN r.author_id ELSE t.author_id END, '') NOT IN (?, ?)",
      );
      expect(selectCall[1]).toEqual(['u1', 'u2']);
      // No access argument ⇒ no membership IN, so `matching` still means
      // exactly "what the grid shows" minus the blocked authors.
      expect(selectCall[0]).not.toContain('COALESCE(t.conversation_id, rt.conversation_id) IN (');
    });

    it('emits NO author clause for an empty array or an absent field', () => {
      const withEmpty = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [{ cnt: 3 }],
        rowsAffected: 0,
      }));
      makeDb(withEmpty);
      getMediaCount({
        limit: 30,
        offset: 0,
        sortBy: 'date',
        sortOrder: 'desc',
        excludeAuthorIds: [],
      });
      const emptyCall = withEmpty.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('COUNT(*)'),
      ) as unknown as [string, unknown[]];
      expect(emptyCall).toBeDefined();
      expect(emptyCall[0]).not.toContain('NOT IN');
      expect(emptyCall[1]).toEqual([]);
      closeDatabase();

      const withAbsent = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [{ cnt: 3 }],
        rowsAffected: 0,
      }));
      makeDb(withAbsent);
      getMediaCount({ limit: 30, offset: 0, sortBy: 'date', sortOrder: 'desc' });
      const absentCall = withAbsent.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('COUNT(*)'),
      ) as unknown as [string, unknown[]];
      expect(absentCall).toBeDefined();
      expect(absentCall[0]).not.toContain('NOT IN');
      expect(absentCall[1]).toEqual([]);
    });

    it('orders the params access → authors → conversation → content type', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [{ cnt: 3 }],
        rowsAffected: 0,
      }));
      makeDb(executeSync);

      getMediaCount(
        {
          limit: 30,
          offset: 0,
          sortBy: 'date',
          sortOrder: 'desc',
          conversationId: 'conv-1',
          contentTypeFilter: 'image',
          excludeAuthorIds: ['u1', 'u2'],
        },
        { conversationIds: ['conv-1', 'conv-2'] },
      );

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('COUNT(*)'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      // The access list binds FIRST, then the excluded authors, then the orbit
      // chip, then the content type — by value and by index.
      expect(selectCall[1]).toEqual(['conv-1', 'conv-2', 'u1', 'u2', 'conv-1', 'image/%']);
      expect(selectCall[1][0]).toBe('conv-1');
      expect(selectCall[1][1]).toBe('conv-2');
      expect(selectCall[1][2]).toBe('u1');
      expect(selectCall[1][3]).toBe('u2');
      expect(selectCall[1][4]).toBe('conv-1');
      expect(selectCall[1][5]).toBe('image/%');
    });
  });

  // -------------------------------------------------------------------------
  // getLocalStorageUsage
  // -------------------------------------------------------------------------

  describe('getLocalStorageUsage', () => {
    it('returns 0 when database is not initialized', () => {
      closeDatabase();
      expect(getLocalStorageUsage()).toBe(0);
    });

    it('returns total from query', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [{ total: 10485760 }],
        rowsAffected: 0,
      }));
      makeDb(executeSync);

      expect(getLocalStorageUsage()).toBe(10485760);
    });

    it('returns 0 when no downloaded media', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [{ total: 0 }],
        rowsAffected: 0,
      }));
      makeDb(executeSync);

      expect(getLocalStorageUsage()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getMediaConversationIds
  // -------------------------------------------------------------------------

  describe('getMediaConversationIds', () => {
    it('returns empty array when database is not initialized', () => {
      closeDatabase();
      expect(getMediaConversationIds()).toEqual([]);
    });

    it('returns distinct conversation IDs', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({
        rows: [
          { conversation_id: 'conv-1' },
          { conversation_id: 'conv-2' },
        ],
        rowsAffected: 0,
      }));
      makeDb(executeSync);

      const result = getMediaConversationIds();
      expect(result).toEqual(['conv-1', 'conv-2']);
    });

    it('executes query with correct JOINs and WHERE clause', () => {
      const executeSync = jest.fn((_sql: string, _params?: unknown[]) => ({ rows: [], rowsAffected: 0 }));
      makeDb(executeSync);

      getMediaConversationIds();

      const selectCall = executeSync.mock.calls.find(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT DISTINCT'),
      ) as unknown as [string, unknown[]];
      expect(selectCall).toBeDefined();
      expect(selectCall[0]).toContain('COALESCE(t.conversation_id, rt.conversation_id)');
      expect(selectCall[0]).toContain('LEFT JOIN orbital_threads t');
      expect(selectCall[0]).toContain('LEFT JOIN orbital_replies r');
      expect(selectCall[0]).toContain('IS NOT NULL');
    });
  });
});
