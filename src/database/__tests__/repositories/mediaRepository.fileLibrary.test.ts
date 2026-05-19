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
