/**
 * Tests for the bulk-export snapshot (#878 PR 2):
 *   getExportSnapshot, and the access clause getMediaCount now accepts.
 *
 * The SQL itself is asserted, not just the return value, because every
 * property here is SILENT when wrong:
 *  - a dropped conversation `IN (…)` returns the WHOLE library to a batch,
 *    including media from orbits the user has left;
 *  - a dropped author `NOT IN (…)` saves media from someone they blocked
 *    (that clause now rides on the OPTIONS, not on `access` — #897);
 *  - an `author_id` read off the wrong parent applies the blocked decision to
 *    the wrong person;
 *  - a missing LIMIT unbinds the run (and the one iOS picker at the end of it);
 *  - an `IN ()` with no values is a SQLite syntax error, so the empty-list case
 *    must issue no query at all rather than a broken one.
 *
 * Same mocking pattern as mediaRepository.fileLibrary.test.ts.
 */

import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { closeDatabase, resetDatabaseForTesting } from '../../connection';
import {
  getExportSnapshot,
  getMediaCount,
  type GetAllMediaOptions,
  type MediaExportAccessFilter,
} from '../../repositories/mediaRepository';

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

const OPTIONS: GetAllMediaOptions = {
  limit: 0,
  offset: 0,
  sortBy: 'date',
  sortOrder: 'desc',
  contentTypeFilter: null,
  conversationId: null,
};

const ACCESS: MediaExportAccessFilter = {
  conversationIds: ['conv-1', 'conv-2'],
};

/** The last SQL + params handed to the driver. */
function lastCall(executeSync: jest.Mock): [string, unknown[]] {
  const calls = executeSync.mock.calls as unknown as Array<[string, unknown[]]>;
  return calls[calls.length - 1];
}

/** The snapshot query, identified by its projection. */
function snapshotCall(executeSync: jest.Mock): [string, unknown[]] {
  const calls = executeSync.mock.calls as unknown as Array<[string, unknown[]]>;
  const call = calls.find((c) => typeof c[0] === 'string' && c[0].includes('as has_local'));
  expect(call).toBeDefined();
  return call as [string, unknown[]];
}

describe('getExportSnapshot', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  it('returns an empty array when the database is not initialized', () => {
    closeDatabase();
    expect(getExportSnapshot(OPTIONS, ACCESS, 500)).toEqual([]);
  });

  it('projects exactly the five facts a batch needs', () => {
    const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(executeSync);

    getExportSnapshot(OPTIONS, ACCESS, 500);

    const [sql] = snapshotCall(executeSync);
    expect(sql).toContain('m.id');
    expect(sql).toContain('m.content_type');
    expect(sql).toContain('m.file_size');
    expect(sql).toContain('m.download_state');
    expect(sql).toContain(
      'CASE WHEN m.local_path IS NOT NULL THEN 1 ELSE 0 END as has_local',
    );
    // The runner must never see a path, a peer file name or a key.
    expect(sql).not.toContain('m.local_path,');
    expect(sql).not.toContain('m.file_name');
    expect(sql).not.toContain('attachment_key IS NULL');
    expect(sql).not.toContain('m.*');
  });

  it('narrows to the conversations the user is in, with one placeholder each', () => {
    const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(executeSync);

    getExportSnapshot(OPTIONS, ACCESS, 500);

    const [sql, params] = snapshotCall(executeSync);
    expect(sql).toContain(
      'COALESCE(t.conversation_id, rt.conversation_id) IN (?, ?)',
    );
    expect(params).toEqual(['conv-1', 'conv-2', 500]);
  });

  it('keeps the base filters (keyed, uploaded, non-thumbnail)', () => {
    const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(executeSync);

    getExportSnapshot(OPTIONS, ACCESS, 500);

    const [sql] = snapshotCall(executeSync);
    expect(sql).toContain('m.attachment_key IS NOT NULL');
    expect(sql).toContain("m.upload_state = 'done'");
    expect(sql).toContain('COALESCE(m.is_thumbnail, 0) = 0');
  });

  it('adds the author NOT IN clause ONLY when someone is blocked', () => {
    const withoutBlocks = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(withoutBlocks);
    getExportSnapshot(OPTIONS, ACCESS, 500);
    expect(snapshotCall(withoutBlocks)[0]).not.toContain('NOT IN');
    closeDatabase();

    // #897: the blocked set travels on the OPTIONS now, so the snapshot and
    // the grid cannot disagree about who is excluded.
    const withBlocks = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(withBlocks);
    getExportSnapshot(
      { ...OPTIONS, excludeAuthorIds: ['user-bad', 'user-worse'] },
      { conversationIds: ['conv-1'] },
      500,
    );

    const [sql, params] = snapshotCall(withBlocks);
    // COALESCE, because `NULL NOT IN (…)` is NULL and would filter the row OUT.
    expect(sql).toContain(
      "COALESCE(CASE WHEN m.reply_id IS NOT NULL THEN r.author_id ELSE t.author_id END, '') NOT IN (?, ?)",
    );
    expect(params).toEqual(['conv-1', 'user-bad', 'user-worse', 500]);
  });

  it('resolves a reply’s conversation through the reply’s own thread', () => {
    const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(executeSync);

    getExportSnapshot(OPTIONS, ACCESS, 500);

    const [sql] = snapshotCall(executeSync);
    expect(sql).toContain('LEFT JOIN orbital_threads t ON m.thread_id = t.id');
    expect(sql).toContain('LEFT JOIN orbital_replies r ON m.reply_id = r.id');
    expect(sql).toContain('LEFT JOIN orbital_threads rt ON r.thread_id = rt.id');
  });

  it('runs NO query at all when the conversation list is empty', () => {
    const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(executeSync);
    // resetDatabaseForTesting runs the pragma/migration statements, so count
    // the calls from here rather than asserting zero overall.
    const before = executeSync.mock.calls.length;

    const result = getExportSnapshot(
      { ...OPTIONS, excludeAuthorIds: ['user-bad'] },
      { conversationIds: [] },
      500,
    );

    expect(result).toEqual([]);
    expect(executeSync.mock.calls.length).toBe(before);
  });

  it('binds the item bound as the LIMIT, last', () => {
    const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(executeSync);

    getExportSnapshot(OPTIONS, ACCESS, 7);

    const [sql, params] = snapshotCall(executeSync);
    expect(sql).toContain('LIMIT ?');
    expect(sql).not.toContain('OFFSET');
    expect(params[params.length - 1]).toBe(7);
  });

  it('inherits the grid’s sort and content-type filter', () => {
    const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(executeSync);

    getExportSnapshot(
      { ...OPTIONS, sortBy: 'size', sortOrder: 'asc', contentTypeFilter: 'video' },
      ACCESS,
      500,
    );

    const [sql, params] = snapshotCall(executeSync);
    expect(sql).toContain('ORDER BY m.file_size ASC');
    expect(sql).toContain('m.content_type LIKE ?');
    expect(params).toEqual(['conv-1', 'conv-2', 'video/%', 500]);
  });

  it('applies the orbit chip on top of the access list', () => {
    const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(executeSync);

    getExportSnapshot({ ...OPTIONS, conversationId: 'conv-2' }, ACCESS, 500);

    const [sql, params] = snapshotCall(executeSync);
    expect(sql).toContain('IN (?, ?)');
    expect(sql).toContain('COALESCE(t.conversation_id, rt.conversation_id) = ?');
    expect(params).toEqual(['conv-1', 'conv-2', 'conv-2', 500]);
  });

  it('returns the driver rows unchanged', () => {
    const row = {
      id: 'm-1',
      content_type: 'image/jpeg',
      file_size: 2048,
      download_state: 'pending',
      has_local: 0,
    };
    const executeSync = jest.fn(() => ({ rows: [row], rowsAffected: 0 }));
    makeDb(executeSync);

    expect(getExportSnapshot(OPTIONS, ACCESS, 500)).toEqual([row]);
  });
});

describe('getMediaCount — access argument', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  it('counts WITHOUT the access clause when none is passed', () => {
    const executeSync = jest.fn(() => ({ rows: [{ cnt: 9 }], rowsAffected: 0 }));
    makeDb(executeSync);

    expect(getMediaCount(OPTIONS)).toBe(9);

    const [sql, params] = lastCall(executeSync);
    expect(sql).toContain('COUNT(*)');
    expect(sql).not.toContain(' IN (');
    expect(params).toEqual([]);
  });

  it('counts WITH the access clause when one is passed', () => {
    const executeSync = jest.fn(() => ({ rows: [{ cnt: 4 }], rowsAffected: 0 }));
    makeDb(executeSync);

    expect(getMediaCount(OPTIONS, ACCESS)).toBe(4);

    const [sql, params] = lastCall(executeSync);
    expect(sql).toContain('COALESCE(t.conversation_id, rt.conversation_id) IN (?, ?)');
    expect(params).toEqual(['conv-1', 'conv-2']);
  });

  it('returns 0 and runs no query for an empty conversation list', () => {
    const executeSync = jest.fn(() => ({ rows: [{ cnt: 9 }], rowsAffected: 0 }));
    makeDb(executeSync);
    const before = executeSync.mock.calls.length;

    expect(getMediaCount(OPTIONS, { conversationIds: [] })).toBe(0);
    expect(executeSync.mock.calls.length).toBe(before);
  });
});
