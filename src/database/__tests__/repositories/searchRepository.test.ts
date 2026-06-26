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
  it('tokenizes and quotes each word with prefix on last token', () => {
    expect(sanitizeFtsQuery('hello world')).toBe('"hello" "world"*');
  });

  it('appends prefix wildcard to single token', () => {
    expect(sanitizeFtsQuery('hello')).toBe('"hello"*');
  });

  it('supports prefix matching on partial words', () => {
    expect(sanitizeFtsQuery('hel')).toBe('"hel"*');
    expect(sanitizeFtsQuery('hello wor')).toBe('"hello" "wor"*');
  });

  it('strips special characters and quotes are removed', () => {
    expect(sanitizeFtsQuery('say "hello"')).toBe('"say" "hello"*');
  });

  it('trims whitespace', () => {
    expect(sanitizeFtsQuery('  search term  ')).toBe('"search" "term"*');
  });

  it('returns empty quoted string for blank input', () => {
    expect(sanitizeFtsQuery('')).toBe('""');
    expect(sanitizeFtsQuery('   ')).toBe('""');
  });

  it('filters FTS5 reserved words', () => {
    expect(sanitizeFtsQuery('NOT a*')).toBe('""'); // 'a' is single char after filtering
    expect(sanitizeFtsQuery('cats AND dogs')).toBe('"cats" "dogs"*');
    expect(sanitizeFtsQuery('NOT hello')).toBe('"hello"*');
  });

  it('returns empty for all-reserved-word input', () => {
    expect(sanitizeFtsQuery('NOT')).toBe('""');
    expect(sanitizeFtsQuery('NOT AND OR')).toBe('""');
  });

  it('filters reserved words case-insensitively', () => {
    expect(sanitizeFtsQuery('not applicable')).toBe('"applicable"*');
    expect(sanitizeFtsQuery('near here')).toBe('"here"*');
  });

  it('strips FTS5 operators from input', () => {
    expect(sanitizeFtsQuery('NEAR/2')).toBe('""'); // '2' is single char after filtering
    expect(sanitizeFtsQuery('hello*')).toBe('"hello"*');
    expect(sanitizeFtsQuery('(test)')).toBe('"test"*');
  });

  it('returns empty for single-character input', () => {
    expect(sanitizeFtsQuery('a')).toBe('""');
    expect(sanitizeFtsQuery('x')).toBe('""');
  });

  it('allows single token of 2+ characters', () => {
    expect(sanitizeFtsQuery('ab')).toBe('"ab"*');
    expect(sanitizeFtsQuery('hi')).toBe('"hi"*');
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
    const result = searchAll('conv-1', 'test');
    expect(result).toEqual([]);
  });

  it('returns empty array for blank query', () => {
    const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(executeSync);
    executeSync.mockClear();

    const result = searchAll('conv-1', '');
    expect(result).toEqual([]);
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

    expect(executeSync).toHaveBeenCalledTimes(2);

    expect(executeSync).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('thread_fts MATCH ?'),
      ['"hello"*', 'conv-1'],
    );
    expect(executeSync).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('reply_fts MATCH ?'),
      ['"hello"*', 'conv-1'],
    );
  });

  it('returns deduplicated thread IDs with thread matches first', () => {
    let searchCallCount = 0;
    const executeSync = jest.fn((sql: string) => {
      if (sql.startsWith('PRAGMA')) {
        return { rows: [], rowsAffected: 0 };
      }
      searchCallCount++;
      if (searchCallCount === 1) {
        return {
          rows: [
            { thread_id: 'thread-1', rank: -1.5 },
            { thread_id: 'thread-2', rank: -1.0 },
          ],
          rowsAffected: 0,
        };
      }
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
