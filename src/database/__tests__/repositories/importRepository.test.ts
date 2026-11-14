/**
 * importRepository (#921) — the SQL and the bindings, against a mocked
 * op-sqlite. The DDL itself is executed for real in
 * `src/database/__tests__/migrations.ddl.test.ts`.
 */

import { closeDatabase } from '../../connection';
import { makeDb } from '../../testUtils/dbMockHelpers';
import {
  createImportJob,
  getActiveImportJob,
  getImportJob,
  setImportJobParsed,
  startImportJob,
  finishImportJob,
  setArchiveBookmark,
  deleteImportJob,
  deleteAllImportJobs,
  insertImportItems,
  getPendingImportItems,
  markItemsUploading,
  requeueImportItems,
  applyBatchResults,
  IMPORT_RESULT_UNKNOWN,
  countImportItemsByStatus,
  countImportSkipsByReason,
  getSkippedItems,
  markMediaUploaded,
  replaceMediaId,
} from '../../repositories/importRepository';
import type { ImportItemInsert, ImportBatchResult } from '../../repositories/importRepository';

jest.mock('@op-engineering/op-sqlite', () => ({
  open: jest.fn(() => ({
    executeSync: jest.fn(() => ({ rows: [], rowsAffected: 0 })),
    close: jest.fn(),
  })),
}));

type ExecCall = [string, unknown[] | undefined];

const KEY = new Uint8Array(16).fill(0x7c);

/** An importable post, as the parser hands it over. */
function post(overrides: Partial<ImportItemInsert> = {}): ImportItemInsert {
  return {
    id: 'item-1',
    ordinal: 0,
    importKey: KEY,
    status: 'pending',
    skipReason: null,
    originalDate: 1700000000000,
    body: 'hello world',
    sourceFile: 'your_posts_1.json',
    sourceIndex: 3,
    idKind: 1,
    ...overrides,
  };
}

/** A skip with no frame (malformed_post / missing_timestamp / invalid_timestamp). */
function skip(overrides: Partial<ImportItemInsert> = {}): ImportItemInsert {
  return post({
    id: 'skip-1',
    importKey: null,
    status: 'skipped',
    skipReason: 'missing_timestamp',
    originalDate: null,
    body: null,
    ...overrides,
  });
}

/** Every call's SQL, in order, excluding the connection-setup PRAGMA. */
function sqls(exec: jest.Mock): string[] {
  return (exec.mock.calls as unknown as ExecCall[])
    .map(([sql]) => sql)
    .filter((sql) => !sql.startsWith('PRAGMA'));
}

/** The first call whose SQL matches, as [sql, params]. */
function callMatching(exec: jest.Mock, needle: string | RegExp): ExecCall {
  const found = (exec.mock.calls as unknown as ExecCall[]).find(([sql]) =>
    typeof needle === 'string' ? sql.includes(needle) : needle.test(sql),
  );
  expect(found).toBeDefined();
  return found as ExecCall;
}

function rows(result: Record<string, unknown>[]): { rows: unknown[]; rowsAffected: number } {
  return { rows: result, rowsAffected: result.length };
}

describe('importRepository', () => {
  afterEach(() => {
    closeDatabase();
    jest.clearAllMocks();
  });

  // =========================================================================
  // Jobs
  // =========================================================================

  describe('createImportJob', () => {
    it('inserts in a transaction with key_fingerprint and status parsing', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      createImportJob({
        id: 'job-1',
        conversationId: 'orbit-1',
        source: 'facebook',
        keyFingerprint: 'fp-generation-1',
        createdAt: 1700000000000,
      });

      const order = sqls(exec);
      expect(order[0]).toBe('BEGIN IMMEDIATE');
      expect(order[order.length - 1]).toBe('COMMIT');

      const [sql, params] = callMatching(exec, 'INSERT INTO import_jobs');
      expect(sql).toContain("'parsing'");
      expect(params).toEqual([
        'job-1',
        'orbit-1',
        'facebook',
        'fp-generation-1',
        1700000000000,
        1700000000000,
      ]);
    });

    it('throws and rolls back when a non-terminal job already exists', () => {
      const exec = jest.fn((sql: string) => {
        if (sql.includes('SELECT id FROM import_jobs')) return rows([{ id: 'job-0' }]);
        return { rows: [], rowsAffected: 1 };
      });
      makeDb(exec);

      expect(() =>
        createImportJob({
          id: 'job-1',
          conversationId: 'orbit-1',
          source: 'instagram',
          keyFingerprint: 'fp-generation-1',
          createdAt: 1700000000000,
        }),
      ).toThrow('IMPORT_JOB_ALREADY_ACTIVE');

      expect(sqls(exec)).toContain('ROLLBACK');
      expect(sqls(exec).some((s) => s.includes('INSERT INTO import_jobs'))).toBe(false);
    });

    it('binds the active-status list rather than interpolating it', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      createImportJob({
        id: 'job-1',
        conversationId: 'orbit-1',
        source: 'facebook',
        keyFingerprint: 'fp',
        createdAt: 1,
      });

      const [sql, params] = callMatching(exec, 'SELECT id FROM import_jobs');
      expect(sql).toContain('IN (?, ?, ?)');
      expect(params).toEqual(['parsing', 'ready', 'in_progress']);
    });
  });

  describe('getActiveImportJob', () => {
    it('binds the three active statuses and takes the newest', () => {
      const exec = jest.fn(() => rows([{ id: 'job-1', key_fingerprint: 'fp' }]));
      makeDb(exec);

      const job = getActiveImportJob();

      const [sql, params] = callMatching(exec, 'SELECT * FROM import_jobs');
      expect(sql).toContain('IN (?, ?, ?)');
      expect(sql).toContain('ORDER BY created_at DESC');
      expect(params).toEqual(['parsing', 'ready', 'in_progress']);
      expect(job?.id).toBe('job-1');
    });
  });

  describe('getImportJob', () => {
    it('binds the id and returns the mapped row', () => {
      const exec = jest.fn(() => rows([{ id: 'job-1', status: 'ready', key_fingerprint: 'fp' }]));
      makeDb(exec);

      const job = getImportJob('job-1');

      const [sql, params] = callMatching(exec, 'SELECT * FROM import_jobs');
      expect(sql).toContain('WHERE id = ?');
      expect(params).toEqual(['job-1']);
      expect(job?.id).toBe('job-1');
      expect(job?.status).toBe('ready');
    });

    it('returns null when the job is gone', () => {
      const exec = jest.fn(() => rows([]));
      makeDb(exec);
      expect(getImportJob('job-1')).toBeNull();
    });
  });

  describe('setImportJobParsed / startImportJob', () => {
    it('setImportJobParsed moves to ready with the declared totals', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      const moved = setImportJobParsed('job-1', { declaredPosts: 120, declaredBytes: 4096 });

      const [sql, params] = callMatching(exec, 'UPDATE import_jobs');
      expect(sql).toContain("status = 'ready'");
      expect(params?.[0]).toBe(120);
      expect(params?.[1]).toBe(4096);
      expect(params?.[3]).toBe('job-1');
      expect(moved).toBe(true);
    });

    it('startImportJob writes session_id only — never key_fingerprint', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      const moved = startImportJob('job-1', { sessionId: 'import-abc' });

      const [sql, params] = callMatching(exec, 'UPDATE import_jobs');
      expect(sql).toContain("status = 'in_progress'");
      expect(sql).toContain('session_id = ?');
      expect(sql).not.toContain('key_fingerprint');
      expect(params?.[0]).toBe('import-abc');
      expect(params?.[2]).toBe('job-1');
      expect(moved).toBe(true);
    });
  });

  // Every job writer re-asserts the status it is transitioning FROM, so a
  // cancelled or finished job cannot be resurrected by a caller holding a
  // stale copy of the row — and reports the miss, because at the SQL level a
  // failed predicate is indistinguishable from success.
  describe('status predicates on the job writers', () => {
    it('setImportJobParsed only fires on a parsing job, and reports a miss', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(exec);

      const moved = setImportJobParsed('job-1', { declaredPosts: 1, declaredBytes: 1 });

      expect(callMatching(exec, 'UPDATE import_jobs')[0]).toContain("AND status = 'parsing'");
      expect(moved).toBe(false);
    });

    it('startImportJob only fires on a ready job, and reports a miss', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(exec);

      const moved = startImportJob('job-1', { sessionId: 's' });

      expect(callMatching(exec, 'UPDATE import_jobs')[0]).toContain("AND status = 'ready'");
      expect(moved).toBe(false);
    });

    it('setArchiveBookmark only fires on an active job, binding the status list', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 0 }));
      makeDb(exec);

      const written = setArchiveBookmark('job-1', '[]');

      const [sql, params] = callMatching(exec, 'archive_bookmark = ?');
      expect(sql).toContain('AND status IN (?, ?, ?)');
      // The list is BOUND, not interpolated — same rule as everywhere else.
      expect(params?.slice(3)).toEqual(['parsing', 'ready', 'in_progress']);
      expect(written).toBe(false);
    });

    it('markItemsUploading only promotes pending rows and returns how many moved', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 2 }));
      makeDb(exec);

      const moved = markItemsUploading('job-1', ['item-1', 'item-2', 'item-3']);

      const [sql] = callMatching(exec, "status = 'uploading'");
      expect(sql).toContain("AND status = 'pending'");
      // A short count is the signal that the caller's batch is stale.
      expect(moved).toBe(2);
    });
  });

  // The only way back out of `uploading`/`failed`. Without it a kill between
  // markItemsUploading and applyBatchResults strands items where
  // getPendingImportItems can never see them again.
  describe('requeueImportItems', () => {
    it('requeues every uploading item of the job when no ids are given', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 7 }));
      makeDb(exec);

      const moved = requeueImportItems('job-1', { from: 'uploading' });

      const [sql, params] = callMatching(exec, "status = 'pending'");
      expect(sql).toContain('error_code = NULL');
      expect(sql).toContain('WHERE job_id = ? AND status = ?');
      expect(sql).not.toContain('id IN (');
      expect(params).toEqual(['job-1', 'uploading']);
      expect(moved).toBe(7);
    });

    it('keeps the body — it is the payload the retry resubmits', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      requeueImportItems('job-1', { from: 'failed' });

      expect(callMatching(exec, "status = 'pending'")[0]).not.toMatch(/\bbody\b/);
    });

    it('binds and chunks an explicit id list at 500', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      const moved = requeueImportItems('job-1', {
        from: 'failed',
        itemIds: Array.from({ length: 501 }, (_, i) => `item-${i}`),
      });

      const calls = (exec.mock.calls as unknown as ExecCall[]).filter(([sql]) =>
        sql.includes("status = 'pending'"),
      );
      expect(calls).toHaveLength(2);
      expect(calls[0][1]).toHaveLength(2 + 500); // job id + from + a full chunk
      expect(calls[1][1]).toHaveLength(2 + 1);
      expect(calls[0][1]?.[1]).toBe('failed');
      expect(calls[0][0]).not.toContain('item-0');
      expect(moved).toBe(2);
    });

    it('treats an EMPTY id list as "nothing", never as "all"', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 9 }));
      makeDb(exec);

      expect(requeueImportItems('job-1', { from: 'uploading', itemIds: [] })).toBe(0);
      expect(sqls(exec)).toHaveLength(0);
    });
  });

  describe('finishImportJob', () => {
    it('nulls the bookmark in the same UPDATE and returns the prior value', () => {
      const bookmark = JSON.stringify([{ ref: 'token-a' }, { ref: 'token-b' }]);
      const exec = jest.fn((sql: string) => {
        if (sql.startsWith('SELECT archive_bookmark')) {
          return rows([{ archive_bookmark: bookmark }]);
        }
        return { rows: [], rowsAffected: 1 };
      });
      makeDb(exec);

      const prior = finishImportJob('job-1', 'completed');

      expect(prior).toBe(bookmark);
      const [sql, params] = callMatching(exec, 'UPDATE import_jobs');
      expect(sql).toContain('status = ?');
      expect(sql).toContain('archive_bookmark = NULL');
      expect(params?.[0]).toBe('completed');
      expect(params?.[2]).toBe('job-1');
    });

    it('returns null when there was no bookmark', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);
      expect(finishImportJob('job-1', 'cancelled')).toBeNull();
    });

    // A terminal job keeps no plaintext. created/duplicate items were emptied
    // when their result landed; pending, uploading and failed ones would
    // otherwise hold the member's post text until the next logout or wipe.
    it('drops the body of every item that was never submitted', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      finishImportJob('job-1', 'completed');

      const [sql, params] = callMatching(exec, 'UPDATE import_items');
      expect(sql).toContain('SET body = NULL');
      expect(sql).toContain('WHERE job_id = ? AND body IS NOT NULL AND status NOT IN (?, ?)');
      expect(params).toEqual(['job-1', 'created', 'duplicate']);
    });

    it('sweeps the bodies on cancelled and failed too, not only completed', () => {
      for (const status of ['cancelled', 'failed'] as const) {
        const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
        makeDb(exec);

        finishImportJob('job-1', status);

        expect(sqls(exec).some((s) => s.includes('SET body = NULL'))).toBe(true);
        closeDatabase();
        jest.clearAllMocks();
      }
    });
  });

  describe('setArchiveBookmark / delete', () => {
    it('binds the whole serialized value', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);
      const json = JSON.stringify([{ ref: 'token-a' }]);

      setArchiveBookmark('job-1', json);

      const [sql, params] = callMatching(exec, 'archive_bookmark = ?');
      expect(sql).toContain('UPDATE import_jobs');
      expect(params?.[0]).toBe(json);
      expect(params?.[2]).toBe('job-1');
    });

    it('deleteImportJob binds the id; deleteAllImportJobs clears the table', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      deleteImportJob('job-1');
      expect(callMatching(exec, 'DELETE FROM import_jobs WHERE id = ?')[1]).toEqual(['job-1']);

      deleteAllImportJobs();
      const all = sqls(exec).filter((s) => s === 'DELETE FROM import_jobs');
      expect(all).toHaveLength(1);
    });
  });

  // =========================================================================
  // insertImportItems
  // =========================================================================

  describe('insertImportItems', () => {
    it('wraps items and media in one BEGIN IMMEDIATE / COMMIT with the conflict clause', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      const result = insertImportItems('job-1', [
        post({
          media: [
            { ordinal: 0, mediaId: 'media-a', entryId: 'entry-a', originalDate: 1700000000001 },
            { ordinal: 1, mediaId: 'media-b', entryId: 'entry-b', originalDate: null },
          ],
        }),
      ]);

      const order = sqls(exec);
      expect(order[0]).toBe('BEGIN IMMEDIATE');
      expect(order[order.length - 1]).toBe('COMMIT');
      expect(result).toEqual({ inserted: 1, duplicates: 0 });

      const [itemSql, itemParams] = callMatching(exec, 'INSERT INTO import_items');
      expect(itemSql).toContain(
        'ON CONFLICT (job_id, import_key) WHERE import_key IS NOT NULL DO NOTHING',
      );
      expect(itemParams?.[1]).toBe('job-1');

      const mediaCalls = (exec.mock.calls as unknown as ExecCall[]).filter(([sql]) =>
        sql.includes('INSERT INTO import_item_media'),
      );
      expect(mediaCalls).toHaveLength(2);
      expect(mediaCalls[0][1]).toEqual(['item-1', 0, 'media-a', 'entry-a', 1700000000001]);
      expect(mediaCalls[1][1]).toEqual(['item-1', 1, 'media-b', 'entry-b', null]);
    });

    it('counts conflicts and bumps dropped_duplicates inside the same transaction', () => {
      let seen = 0;
      const exec = jest.fn((sql: string) => {
        if (sql.includes('INSERT INTO import_items')) {
          seen += 1;
          // Second row is the duplicate the partial unique index rejects.
          return { rows: [], rowsAffected: seen === 2 ? 0 : 1 };
        }
        return { rows: [], rowsAffected: 1 };
      });
      makeDb(exec);

      const result = insertImportItems('job-1', [
        post({ id: 'item-1', ordinal: 0 }),
        post({ id: 'item-2', ordinal: 1 }),
        post({ id: 'item-3', ordinal: 2 }),
      ]);

      expect(result).toEqual({ inserted: 2, duplicates: 1 });

      const order = sqls(exec);
      const begin = order.indexOf('BEGIN IMMEDIATE');
      const commit = order.indexOf('COMMIT');
      const bump = order.findIndex((s) =>
        s.includes('dropped_duplicates = dropped_duplicates + ?'),
      );
      expect(bump).toBeGreaterThan(begin);
      expect(bump).toBeLessThan(commit);

      const [, bumpParams] = callMatching(exec, 'dropped_duplicates = dropped_duplicates + ?');
      expect(bumpParams?.[0]).toBe(1);
      expect(bumpParams?.[2]).toBe('job-1');
    });

    it('skips the bump entirely when nothing conflicted', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      insertImportItems('job-1', [post()]);

      expect(sqls(exec).some((s) => s.includes('dropped_duplicates'))).toBe(false);
    });

    it('does not open a transaction for an empty batch', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      expect(insertImportItems('job-1', [])).toEqual({ inserted: 0, duplicates: 0 });
      expect(sqls(exec)).toHaveLength(0);
    });

    it('rolls back and rethrows when a row fails', () => {
      const exec = jest.fn((sql: string) => {
        if (sql.includes('INSERT INTO import_items')) throw new Error('disk I/O error');
        return { rows: [], rowsAffected: 1 };
      });
      makeDb(exec);

      expect(() => insertImportItems('job-1', [post()])).toThrow('disk I/O error');
      expect(sqls(exec)).toContain('ROLLBACK');
      expect(sqls(exec)).not.toContain('COMMIT');
    });

    it('binds import_key as a Uint8Array and never as text', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      insertImportItems('job-1', [post()]);

      const [, params] = callMatching(exec, 'INSERT INTO import_items');
      const bound = params?.[3];
      expect(bound).toBeInstanceOf(Uint8Array);
      expect(bound).toHaveLength(16);
      expect(typeof bound).not.toBe('string');
    });

    it('inserts a NULL-key skip with a NULL body and its reason', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      const result = insertImportItems('job-1', [skip()]);

      expect(result).toEqual({ inserted: 1, duplicates: 0 });
      const [, params] = callMatching(exec, 'INSERT INTO import_items');
      expect(params?.[3]).toBeNull(); // import_key
      expect(params?.[4]).toBe('skipped'); // status
      expect(params?.[5]).toBe('missing_timestamp');
      expect(params?.[6]).toBeNull(); // original_date
      expect(params?.[7]).toBeNull(); // body
    });

    it('binds body for an importable post and the local-UI columns alongside it', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      insertImportItems('job-1', [post()]);

      const [, params] = callMatching(exec, 'INSERT INTO import_items');
      expect(params?.[7]).toBe('hello world'); // body
      expect(params?.[8]).toBe('your_posts_1.json'); // source_file (F18)
      expect(params?.[9]).toBe(3); // source_index
      expect(params?.[10]).toBe(1); // id_kind
    });

    it.each([
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['1e21 (not a safe integer)', 1e21],
      ['a fractional ms value', 1700000000000.5],
      ['a negative epoch', -1],
    ])('binds NULL for an item original_date that is %s', (_label, value) => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      insertImportItems('job-1', [post({ originalDate: value })]);

      const [, params] = callMatching(exec, 'INSERT INTO import_items');
      expect(params?.[6]).toBeNull();
    });

    it('applies the same date guard to media original_date', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      insertImportItems('job-1', [
        post({
          media: [{ ordinal: 0, mediaId: 'media-a', entryId: 'entry-a', originalDate: 1e21 }],
        }),
      ]);

      const [, params] = callMatching(exec, 'INSERT INTO import_item_media');
      expect(params?.[4]).toBeNull();
    });

    it('writes no media for a row the conflict clause rejected', () => {
      const exec = jest.fn((sql: string) => {
        if (sql.includes('INSERT INTO import_items')) return { rows: [], rowsAffected: 0 };
        return { rows: [], rowsAffected: 1 };
      });
      makeDb(exec);

      insertImportItems('job-1', [
        post({
          media: [{ ordinal: 0, mediaId: 'media-a', entryId: 'entry-a', originalDate: null }],
        }),
      ]);

      expect(sqls(exec).some((s) => s.includes('INSERT INTO import_item_media'))).toBe(false);
    });
  });

  // =========================================================================
  // Reads
  // =========================================================================

  describe('getPendingImportItems', () => {
    it('reads through queryMany, so an ArrayBuffer BLOB comes back as a Uint8Array', () => {
      const blob = new ArrayBuffer(16);
      new Uint8Array(blob).fill(0x7c);
      const exec = jest.fn((sql: string) => {
        if (sql.includes('FROM import_items')) {
          return rows([{ id: 'item-1', job_id: 'job-1', ordinal: 0, import_key: blob, body: 'b' }]);
        }
        return rows([]);
      });
      makeDb(exec);

      const items = getPendingImportItems('job-1', 100);

      expect(items).toHaveLength(1);
      expect(items[0].import_key).toBeInstanceOf(Uint8Array);
      expect(items[0].import_key).toHaveLength(16);
      expect(items[0].body).toBe('b');
      expect(items[0].media).toEqual([]);
    });

    it('fetches media in a second bound query and groups it by item', () => {
      const exec = jest.fn((sql: string) => {
        if (sql.includes('FROM import_items')) {
          return rows([
            { id: 'item-1', job_id: 'job-1', ordinal: 0 },
            { id: 'item-2', job_id: 'job-1', ordinal: 1 },
          ]);
        }
        if (sql.includes('FROM import_item_media')) {
          return rows([
            { item_id: 'item-1', ordinal: 0, media_id: 'm-a', entry_id: 'e-a' },
            { item_id: 'item-1', ordinal: 1, media_id: 'm-b', entry_id: 'e-b' },
            { item_id: 'item-2', ordinal: 0, media_id: 'm-c', entry_id: 'e-c' },
          ]);
        }
        return rows([]);
      });
      makeDb(exec);

      const items = getPendingImportItems('job-1', 100);

      const [itemSql, itemParams] = callMatching(exec, 'FROM import_items');
      expect(itemSql).toContain("status = 'pending'");
      expect(itemSql).toContain('ORDER BY ordinal ASC');
      expect(itemParams).toEqual(['job-1', 100]);

      const [mediaSql, mediaParams] = callMatching(exec, 'FROM import_item_media');
      expect(mediaSql).toContain('item_id IN (?, ?)');
      expect(mediaParams).toEqual(['item-1', 'item-2']);

      expect(items[0].media.map((m) => m.media_id)).toEqual(['m-a', 'm-b']);
      expect(items[1].media.map((m) => m.media_id)).toEqual(['m-c']);
    });

    it('does not query media when there are no pending items', () => {
      const exec = jest.fn(() => rows([]));
      makeDb(exec);

      expect(getPendingImportItems('job-1', 100)).toEqual([]);
      expect(sqls(exec).some((s) => s.includes('import_item_media'))).toBe(false);
    });

    it('chunks the media id list to 500 bound placeholders per query', () => {
      const many = Array.from({ length: 501 }, (_, i) => ({
        id: `item-${i}`,
        job_id: 'job-1',
        ordinal: i,
      }));
      const exec = jest.fn((sql: string) => {
        if (sql.includes('FROM import_items')) return rows(many);
        return rows([]);
      });
      makeDb(exec);

      getPendingImportItems('job-1', 1000);

      const mediaCalls = (exec.mock.calls as unknown as ExecCall[]).filter(([sql]) =>
        sql.includes('FROM import_item_media'),
      );
      expect(mediaCalls).toHaveLength(2);
      expect(mediaCalls[0][1]).toHaveLength(500);
      expect(mediaCalls[1][1]).toHaveLength(1);
      // Placeholders only — no id is ever interpolated into the SQL text.
      expect(mediaCalls[0][0]).not.toContain('item-0');
    });
  });

  describe('markItemsUploading', () => {
    it('binds every id and chunks at 500', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      markItemsUploading(
        'job-1',
        Array.from({ length: 501 }, (_, i) => `item-${i}`),
      );

      const calls = (exec.mock.calls as unknown as ExecCall[]).filter(([sql]) =>
        sql.includes("status = 'uploading'"),
      );
      expect(calls).toHaveLength(2);
      expect(calls[0][1]).toHaveLength(1 + 500); // job id + a full chunk of item ids
      expect(calls[1][1]).toHaveLength(1 + 1); // job id + the remainder
      expect(calls[0][1]?.[0]).toBe('job-1');
      expect(calls[0][0]).toContain('id IN (');
      expect(calls[0][0]).not.toContain('item-0');
    });

    it('is a no-op for an empty id list', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);
      markItemsUploading('job-1', []);
      expect(sqls(exec)).toHaveLength(0);
    });
  });

  // =========================================================================
  // applyBatchResults
  // =========================================================================

  describe('applyBatchResults', () => {
    it('sets thread_id and NULLs the body for created and duplicate, keyed by item id', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      applyBatchResults('job-1', [
        { itemId: 'item-1', status: 'created', threadId: 'thread-1' },
        { itemId: 'item-2', status: 'duplicate', threadId: 'thread-2' },
      ]);

      const updates = (exec.mock.calls as unknown as ExecCall[]).filter(([sql]) =>
        sql.includes('UPDATE import_items SET status = ?'),
      );
      expect(updates).toHaveLength(2);
      expect(updates[0][0]).toContain('body = NULL');
      expect(updates[0][0]).toContain('WHERE id = ? AND job_id = ?');
      expect(updates[0][1]).toEqual(['created', 'thread-1', 'item-1', 'job-1']);
      expect(updates[1][1]).toEqual(['duplicate', 'thread-2', 'item-2', 'job-1']);
    });

    it('marks a rejected result failed with its error_code and leaves the body alone', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      applyBatchResults('job-1', [{ itemId: 'item-9', status: 'rejected', code: 'BODY_TOO_LONG' }]);

      const [sql, params] = callMatching(exec, "status = 'failed'");
      expect(sql).toContain('error_code = ?');
      expect(sql).not.toContain('body = NULL');
      expect(params).toEqual(['BODY_TOO_LONG', 'item-9', 'job-1']);
    });

    it('runs the whole batch in one transaction and rolls back on error', () => {
      const exec = jest.fn((sql: string) => {
        if (sql.includes('UPDATE import_items')) throw new Error('disk I/O error');
        return { rows: [], rowsAffected: 1 };
      });
      makeDb(exec);

      expect(() =>
        applyBatchResults('job-1', [{ itemId: 'item-1', status: 'created', threadId: 't' }]),
      ).toThrow('disk I/O error');
      expect(sqls(exec)).toContain('ROLLBACK');
    });

    it('is a no-op for an empty result list', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);
      applyBatchResults('job-1', []);
      expect(sqls(exec)).toHaveLength(0);
    });

    // The wire is not the type system. `ImportBatchResult['status']` is erased
    // at runtime, so a server that grows a fourth result status must not be
    // able to steer import_items.status — the column the resume loop reads —
    // outside ImportItemStatus.
    it('parks an unknown status as failed with the local sentinel, never writing it through', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      applyBatchResults('job-1', [
        {
          itemId: 'item-1',
          // A status this build has never heard of.
          status: 'quarantined' as unknown as ImportBatchResult['status'],
          threadId: 'thread-1',
        },
      ]);

      const [sql, params] = callMatching(exec, 'UPDATE import_items');
      expect(sql).toContain("status = 'failed'");
      expect(params).toEqual([IMPORT_RESULT_UNKNOWN, 'item-1', 'job-1']);
      for (const s of sqls(exec)) {
        expect(s).not.toContain('quarantined');
      }
      const bound = (exec.mock.calls as unknown as ExecCall[]).flatMap(([, p]) => p ?? []);
      expect(bound).not.toContain('quarantined');
    });

    it('still writes created and duplicate through — the allowlist is only the else-arm', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      applyBatchResults('job-1', [
        { itemId: 'item-1', status: 'created', threadId: 't1' },
        { itemId: 'item-2', status: 'duplicate', threadId: null },
      ]);

      const updates = (exec.mock.calls as unknown as ExecCall[]).filter(([sql]) =>
        sql.includes('UPDATE import_items SET status = ?'),
      );
      expect(updates).toHaveLength(2);
      expect(updates[0][1]?.[0]).toBe('created');
      expect(updates[1][1]?.[0]).toBe('duplicate');
      // #315's narrow delete race: `duplicate` can arrive without a thread_id.
      expect(updates[1][1]?.[1]).toBeNull();
    });

    it('never interpolates a server-returned value into SQL', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      applyBatchResults('job-1', [
        { itemId: "item'); DROP TABLE import_items;--", status: 'rejected', code: "x'--" },
      ]);

      for (const sql of sqls(exec)) {
        expect(sql).not.toContain('DROP TABLE');
      }
    });
  });

  // =========================================================================
  // Counts
  // =========================================================================

  describe('countImportItemsByStatus', () => {
    it('returns an exhaustive record with zeros for the statuses with no rows', () => {
      const exec = jest.fn(() =>
        rows([
          { status: 'pending', n: 4 },
          { status: 'created', n: 7 },
        ]),
      );
      makeDb(exec);

      expect(countImportItemsByStatus('job-1')).toEqual({
        pending: 4,
        uploading: 0,
        created: 7,
        duplicate: 0,
        failed: 0,
        skipped: 0,
      });
    });

    // `in` walks the prototype chain, so a row whose status is the name of an
    // Object.prototype member would have passed the guard and written a count
    // onto a key no caller declares. `hasOwnProperty.call` is what closes it.
    it('ignores a status that only matches an Object.prototype key', () => {
      const exec = jest.fn(() =>
        rows([
          { status: 'toString', n: 3 },
          { status: 'constructor', n: 2 },
          { status: 'pending', n: 1 },
        ]),
      );
      makeDb(exec);

      const counts = countImportItemsByStatus('job-1');

      expect(counts).toEqual({
        pending: 1,
        uploading: 0,
        created: 0,
        duplicate: 0,
        failed: 0,
        skipped: 0,
      });
      expect(Object.keys(counts)).toHaveLength(6);
    });
  });

  describe('countImportSkipsByReason', () => {
    it('folds dropped_duplicates into the duplicate_in_archive bucket', () => {
      const exec = jest.fn((sql: string) => {
        if (sql.includes('GROUP BY skip_reason')) {
          return rows([
            { skip_reason: 'held_video', n: 2 },
            { skip_reason: 'empty_post', n: 1 },
          ]);
        }
        if (sql.includes('dropped_duplicates')) return rows([{ dropped_duplicates: 5 }]);
        return rows([]);
      });
      makeDb(exec);

      const counts = countImportSkipsByReason('job-1');

      expect(counts.held_video).toBe(2);
      expect(counts.empty_post).toBe(1);
      expect(counts.duplicate_in_archive).toBe(5);
      // Exhaustive: every reason has a bucket, zero included.
      expect(counts.text_too_long).toBe(0);
      expect(counts.malformed_post).toBe(0);
      expect(Object.keys(counts)).toHaveLength(13);
    });

    it('adds a stored duplicate_in_archive row to the counter rather than replacing it', () => {
      const exec = jest.fn((sql: string) => {
        if (sql.includes('GROUP BY skip_reason')) {
          return rows([{ skip_reason: 'duplicate_in_archive', n: 1 }]);
        }
        if (sql.includes('dropped_duplicates')) return rows([{ dropped_duplicates: 5 }]);
        return rows([]);
      });
      makeDb(exec);

      expect(countImportSkipsByReason('job-1').duplicate_in_archive).toBe(6);
    });

    it('survives a missing job row', () => {
      const exec = jest.fn(() => rows([]));
      makeDb(exec);
      expect(countImportSkipsByReason('job-1').duplicate_in_archive).toBe(0);
    });

    it('ignores a skip_reason that only matches an Object.prototype key', () => {
      const exec = jest.fn((sql: string) => {
        if (sql.includes('GROUP BY skip_reason')) {
          return rows([
            { skip_reason: 'valueOf', n: 4 },
            { skip_reason: 'held_video', n: 1 },
          ]);
        }
        return rows([]);
      });
      makeDb(exec);

      const counts = countImportSkipsByReason('job-1');

      expect(counts.held_video).toBe(1);
      expect(Object.keys(counts)).toHaveLength(13);
      expect(Object.keys(counts)).not.toContain('valueOf');
    });
  });

  describe('getSkippedItems', () => {
    it('selects the #928 columns only — never the plaintext body', () => {
      const exec = jest.fn(() => rows([]));
      makeDb(exec);

      getSkippedItems('job-1');

      const [sql, params] = callMatching(exec, 'FROM import_items');
      expect(sql).toContain('SELECT id, skip_reason, original_date, source_file, source_index');
      expect(sql).not.toMatch(/\bbody\b/);
      expect(sql).toContain('skip_reason IS NOT NULL');
      expect(params).toEqual(['job-1']);
    });

    it('binds the reason filter when one is given', () => {
      const exec = jest.fn(() => rows([]));
      makeDb(exec);

      getSkippedItems('job-1', 'held_video');

      const [sql, params] = callMatching(exec, 'FROM import_items');
      expect(sql).toContain('skip_reason = ?');
      expect(params).toEqual(['job-1', 'held_video']);
    });
  });

  // =========================================================================
  // Media
  // =========================================================================

  describe('media', () => {
    it('markMediaUploaded touches exactly one (item_id, ordinal)', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      markMediaUploaded('item-1', 2);

      const [sql, params] = callMatching(exec, 'UPDATE import_item_media');
      expect(sql).toContain("upload_state = 'uploaded'");
      expect(sql).toContain('WHERE item_id = ? AND ordinal = ?');
      expect(params).toEqual(['item-1', 2]);
    });

    it('replaceMediaId rewrites one row and resets its upload cache flag', () => {
      const exec = jest.fn(() => ({ rows: [], rowsAffected: 1 }));
      makeDb(exec);

      replaceMediaId('item-1', 2, '7f1d0b9e-1c1a-4a3e-9c1a-0b9e7f1d0b9e');

      const [sql, params] = callMatching(exec, 'UPDATE import_item_media');
      expect(sql).toContain('media_id = ?');
      expect(sql).toContain("upload_state = 'pending'");
      expect(sql).toContain('WHERE item_id = ? AND ordinal = ?');
      expect(params).toEqual(['7f1d0b9e-1c1a-4a3e-9c1a-0b9e7f1d0b9e', 'item-1', 2]);
      expect(sqls(exec).filter((s) => s.includes('UPDATE import_item_media'))).toHaveLength(1);
    });
  });

  // =========================================================================
  // DB-not-initialized guard
  // =========================================================================

  describe('without an initialized database', () => {
    it('every function is a no-op and returns its empty value', () => {
      // No makeDb() — the connection module holds no DB.
      expect(() =>
        createImportJob({
          id: 'job-1',
          conversationId: 'orbit-1',
          source: 'facebook',
          keyFingerprint: 'fp',
          createdAt: 1,
        }),
      ).not.toThrow();
      expect(getActiveImportJob()).toBeNull();
      expect(getImportJob('job-1')).toBeNull();
      // The writers report "nothing moved" rather than claiming success.
      expect(setImportJobParsed('job-1', { declaredPosts: 1, declaredBytes: 1 })).toBe(false);
      expect(startImportJob('job-1', { sessionId: 's' })).toBe(false);
      expect(finishImportJob('job-1', 'failed')).toBeNull();
      expect(setArchiveBookmark('job-1', '[]')).toBe(false);
      expect(() => deleteImportJob('job-1')).not.toThrow();
      expect(() => deleteAllImportJobs()).not.toThrow();
      expect(insertImportItems('job-1', [post()])).toEqual({ inserted: 0, duplicates: 0 });
      expect(getPendingImportItems('job-1', 10)).toEqual([]);
      expect(markItemsUploading('job-1', ['item-1'])).toBe(0);
      expect(requeueImportItems('job-1', { from: 'uploading' })).toBe(0);
      expect(requeueImportItems('job-1', { from: 'failed', itemIds: ['item-1'] })).toBe(0);
      expect(() =>
        applyBatchResults('job-1', [{ itemId: 'item-1', status: 'created', threadId: 't' }]),
      ).not.toThrow();
      expect(countImportItemsByStatus('job-1').pending).toBe(0);
      expect(countImportSkipsByReason('job-1').held_video).toBe(0);
      expect(getSkippedItems('job-1')).toEqual([]);
      expect(() => markMediaUploaded('item-1', 0)).not.toThrow();
      expect(() => replaceMediaId('item-1', 0, 'new-id')).not.toThrow();
    });
  });
});
