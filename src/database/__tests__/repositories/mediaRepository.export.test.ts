/**
 * Tests for getMediaExportAccess (#878).
 *
 * Follows the same mocking pattern as mediaRepository.fileLibrary.test.ts.
 *
 * Two facts are asserted about the SQL itself, because both are silent when
 * wrong: the conversation id must COALESCE through BOTH parent shapes (media
 * hangs off a thread or off a reply, and a reply resolves its conversation via
 * its own thread), and the author must be picked by which parent the row
 * actually has — reading `t.author_id` for reply media would attribute a reply
 * to the thread starter and so apply the WRONG blocked-author decision in bulk.
 */

import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import { closeDatabase, resetDatabaseForTesting } from '../../connection';
import { getMediaExportAccess } from '../../repositories/mediaRepository';

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

describe('getMediaExportAccess', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  it('returns null when the database is not initialized', () => {
    closeDatabase();
    expect(getMediaExportAccess('m-1')).toBeNull();
  });

  it('resolves the conversation through either parent and binds the id', () => {
    const executeSync = jest.fn(() => ({
      rows: [{ conversation_id: 'conv-1', author_id: 'user-9' }],
      rowsAffected: 0,
    }));
    makeDb(executeSync);

    const result = getMediaExportAccess('m-1');

    expect(result).toEqual({ conversation_id: 'conv-1', author_id: 'user-9' });

    const calls = executeSync.mock.calls as unknown as Array<[string, unknown[]]>;
    const call = calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('as conversation_id'),
    );
    expect(call).toBeDefined();
    const [sql, params] = call as [string, unknown[]];
    expect(sql).toContain('COALESCE(t.conversation_id, rt.conversation_id)');
    // The reply's own thread is what carries a reply's conversation.
    expect(sql).toContain('LEFT JOIN orbital_threads rt ON r.thread_id = rt.id');
    expect(sql).toContain('WHERE m.id = ?');
    expect(params).toEqual(['m-1']);
  });

  it('picks the author from the row’s actual parent', () => {
    const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(executeSync);

    getMediaExportAccess('m-2');

    const calls = executeSync.mock.calls as unknown as Array<[string, unknown[]]>;
    const sql = calls[calls.length - 1][0];
    expect(sql).toContain(
      'CASE WHEN m.reply_id IS NOT NULL THEN r.author_id ELSE t.author_id END as author_id',
    );
  });

  it('returns null for a media id that has no row', () => {
    const executeSync = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
    makeDb(executeSync);

    expect(getMediaExportAccess('missing')).toBeNull();
  });

  it('returns a null conversation for an ORPHAN rather than throwing', () => {
    // Leaving an orbit deletes its threads and replies but leaves
    // orbital_media rows behind, so both JOINs miss. The export service turns
    // this into `notAllowed`; the File Library grid still shows the row.
    const executeSync = jest.fn(() => ({
      rows: [{ conversation_id: null, author_id: null }],
      rowsAffected: 0,
    }));
    makeDb(executeSync);

    expect(getMediaExportAccess('orphan')).toEqual({
      conversation_id: null,
      author_id: null,
    });
  });
});
