/**
 * Tests for searchRepository — FTS5 full-text search over threads and replies.
 */

import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { closeDatabase, resetDatabaseForTesting } from '../../connection';
import { sanitizeFtsQuery, searchAll } from '../../repositories/searchRepository';

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

// ---------------------------------------------------------------------------
// sanitizeFtsQuery
// ---------------------------------------------------------------------------

describe('sanitizeFtsQuery', () => {
  it('wraps plain text in double quotes', () => {
    expect(sanitizeFtsQuery('hello world')).toBe('"hello world"');
  });

  it('escapes embedded double quotes', () => {
    expect(sanitizeFtsQuery('say "hello"')).toBe('"say ""hello"""');
  });

  it('trims whitespace', () => {
    expect(sanitizeFtsQuery('  search term  ')).toBe('"search term"');
  });

  it('returns empty quoted string for blank input', () => {
    expect(sanitizeFtsQuery('')).toBe('""');
    expect(sanitizeFtsQuery('   ')).toBe('""');
  });

  it('handles FTS5 special characters safely', () => {
    // These would cause parse errors if not quoted
    expect(sanitizeFtsQuery('NOT a*')).toBe('"NOT a*"');
    expect(sanitizeFtsQuery('NEAR/2')).toBe('"NEAR/2"');
  });
});

// ---------------------------------------------------------------------------
// searchAll
// ---------------------------------------------------------------------------

describe('searchAll', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  it('returns empty array when database is not initialized', () => {
    // Do not call resetDatabaseForTesting — DB stays uninitialized
    const result = searchAll('conv-1', 'test');
    expect(result).toEqual([]);
  });

  it('returns empty array for blank query', () => {
    const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(executeSync);
    // resetDatabaseForTesting calls executeSync once (PRAGMA foreign_keys = ON)
    executeSync.mockClear();

    const result = searchAll('conv-1', '');
    expect(result).toEqual([]);
    // Should not have called any search query
    expect(executeSync).not.toHaveBeenCalled();
  });

  it('returns empty array for whitespace-only query', () => {
    const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(executeSync);
    executeSync.mockClear();

    const result = searchAll('conv-1', '   ');
    expect(result).toEqual([]);
    expect(executeSync).not.toHaveBeenCalled();
  });

  it('executes thread and reply FTS5 queries with sanitized input', () => {
    const executeSync = jest.fn(
      (_sql: string, _params?: unknown[]) => ({ rows: [] as Record<string, unknown>[], rowsAffected: 0 }),
    );
    makeDb(executeSync);
    executeSync.mockClear();

    searchAll('conv-1', 'hello');

    // Should have been called twice: once for thread_fts, once for reply_fts
    expect(executeSync).toHaveBeenCalledTimes(2);

    expect(executeSync).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('thread_fts MATCH ?'),
      ['"hello"', 'conv-1'],
    );
    expect(executeSync).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('reply_fts MATCH ?'),
      ['"hello"', 'conv-1'],
    );
  });

  it('returns deduplicated thread IDs with thread matches first', () => {
    let searchCallCount = 0;
    const executeSync = jest.fn((sql: string) => {
      // Skip the PRAGMA call from resetDatabaseForTesting
      if (sql.startsWith('PRAGMA')) {
        return { rows: [], rowsAffected: 0 };
      }
      searchCallCount++;
      if (searchCallCount === 1) {
        // Thread matches
        return {
          rows: [
            { thread_id: 'thread-1', rank: -1.5 },
            { thread_id: 'thread-2', rank: -1.0 },
          ],
          rowsAffected: 0,
        };
      }
      // Reply matches -- thread-1 is a duplicate, thread-3 is new
      return {
        rows: [
          { thread_id: 'thread-1', rank: -2.0 },
          { thread_id: 'thread-3', rank: -0.5 },
        ],
        rowsAffected: 0,
      };
    });
    makeDb(executeSync);

    const result = searchAll('conv-1', 'hello');

    // thread-1 from threads, thread-2 from threads, thread-3 from replies
    // thread-1 from replies is deduplicated
    expect(result).toEqual(['thread-1', 'thread-2', 'thread-3']);
  });

  it('returns only reply-surfaced threads when no thread matches', () => {
    let searchCallCount = 0;
    const executeSync = jest.fn((sql: string) => {
      if (sql.startsWith('PRAGMA')) {
        return { rows: [], rowsAffected: 0 };
      }
      searchCallCount++;
      if (searchCallCount === 1) {
        return { rows: [], rowsAffected: 0 };
      }
      return {
        rows: [{ thread_id: 'thread-5', rank: -1.0 }],
        rowsAffected: 0,
      };
    });
    makeDb(executeSync);

    const result = searchAll('conv-1', 'reply text');
    expect(result).toEqual(['thread-5']);
  });
});
