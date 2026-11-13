/**
 * Migration 009 DDL, EXECUTED (#921).
 *
 * Every other migration test in this repo asserts on the SQL *string*, because
 * op-sqlite is mocked everywhere — which means no test has ever executed a
 * migration. A typo in a partial index, a misspelled `ON DELETE CASCADE` or a
 * `WHERE` clause SQLite rejects would ship, and the failure would surface as a
 * bricked bootstrap on a member's device.
 *
 * So this suite runs the real `SQL` export through `node:sqlite`'s
 * `DatabaseSync`. Node 24.22.1 (the pinned toolchain) bundles SQLite 3.53.x,
 * the same series op-sqlite ships, so the DDL dialect checked here is the
 * dialect the device parses.
 *
 * 009 is executed ALONE: it only CREATEs, references no table from 001-008 and
 * takes no FK outside its own three tables, so a minimal in-memory DB is a
 * faithful stage — and one that does not depend on Node's SQLite being built
 * with FTS5 (migration 005).
 */

import { DatabaseSync } from 'node:sqlite';
import { SQL as SQL_V9, VERSION as V9 } from '../migrations/009_meta_import_tables';

const JOB = 'job-1';

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SQL_V9);
  return db;
}

function insertJob(db: DatabaseSync, id = JOB): void {
  db.prepare(
    `INSERT INTO import_jobs (id, conversation_id, source, key_fingerprint, created_at, updated_at)
     VALUES (?, ?, 'facebook', 'fp-gen-1', 1700000000000, 1700000000000)`,
  ).run(id, 'orbit-1');
}

function insertItem(
  db: DatabaseSync,
  id: string,
  ordinal: number,
  importKey: Uint8Array | null,
  jobId = JOB,
): { changes: number } {
  const result = db
    .prepare(
      `INSERT INTO import_items (id, job_id, ordinal, import_key, status, body)
       VALUES (?, ?, ?, ?, 'pending', 'body text')
       ON CONFLICT (job_id, import_key) WHERE import_key IS NOT NULL DO NOTHING`,
    )
    .run(id, jobId, ordinal, importKey);
  return { changes: Number(result.changes) };
}

const KEY_A = new Uint8Array(16).fill(0xa1);
const KEY_B = new Uint8Array(16).fill(0xb2);

describe('migration 009 DDL (executed on node:sqlite)', () => {
  it('declares VERSION 9', () => {
    expect(V9).toBe(9);
  });

  it('creates the three tables and their four indexes', () => {
    const db = openDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(['import_item_media', 'import_items', 'import_jobs']);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual([
      'idx_import_items_job_key',
      'idx_import_items_job_reason',
      'idx_import_items_job_status',
      'idx_import_jobs_active',
    ]);
    db.close();
  });

  it('rejects a second item with the same (job_id, import_key) — changes 0, first row kept', () => {
    const db = openDb();
    insertJob(db);

    expect(insertItem(db, 'item-1', 0, KEY_A).changes).toBe(1);
    // Same key, different id: the partial UNIQUE index catches it and
    // DO NOTHING keeps the FIRST row (parseArchive emits the settled item
    // before its duplicate_in_archive copies).
    expect(insertItem(db, 'item-2', 1, KEY_A).changes).toBe(0);
    expect(insertItem(db, 'item-3', 2, KEY_B).changes).toBe(1);

    const ids = db
      .prepare('SELECT id FROM import_items ORDER BY ordinal')
      .all()
      .map((r) => r.id);
    expect(ids).toEqual(['item-1', 'item-3']);
    db.close();
  });

  it('scopes the unique key to the job — the same import_key inserts under another job', () => {
    const db = openDb();
    insertJob(db, 'job-a');
    insertJob(db, 'job-b');

    expect(insertItem(db, 'item-a', 0, KEY_A, 'job-a').changes).toBe(1);
    expect(insertItem(db, 'item-b', 0, KEY_A, 'job-b').changes).toBe(1);
    db.close();
  });

  it('lets NULL-key skips coexist — the unique index is partial', () => {
    const db = openDb();
    insertJob(db);

    expect(insertItem(db, 'skip-1', 0, null).changes).toBe(1);
    expect(insertItem(db, 'skip-2', 1, null).changes).toBe(1);
    expect(insertItem(db, 'skip-3', 2, null).changes).toBe(1);

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM import_items WHERE import_key IS NULL')
      .get();
    expect(Number(count!.n)).toBe(3);
    db.close();
  });

  it('round-trips a 16-byte import_key BLOB', () => {
    const db = openDb();
    insertJob(db);
    insertItem(db, 'item-1', 0, KEY_A);

    const row = db.prepare('SELECT import_key FROM import_items WHERE id = ?').get('item-1');
    const stored = row!.import_key as Uint8Array;
    expect(stored).toHaveLength(16);
    expect(Array.from(stored)).toEqual(Array.from(KEY_A));
    db.close();
  });

  it('cascades a job delete two levels, into items and their media', () => {
    const db = openDb();
    insertJob(db);
    insertItem(db, 'item-1', 0, KEY_A);
    db.prepare(
      `INSERT INTO import_item_media (item_id, ordinal, media_id, entry_id)
       VALUES (?, 0, '7f1d0b9e-1c1a-4a3e-9c1a-0b9e7f1d0b9e', 'entry-1')`,
    ).run('item-1');

    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM import_item_media').get()!.n)).toBe(1);

    db.prepare('DELETE FROM import_jobs WHERE id = ?').run(JOB);

    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM import_items').get()!.n)).toBe(0);
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM import_item_media').get()!.n)).toBe(0);
    db.close();
  });

  it('enforces the item -> job foreign key', () => {
    const db = openDb();
    expect(() => insertItem(db, 'orphan', 0, KEY_A, 'no-such-job')).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('applies the column defaults the repository relies on', () => {
    const db = openDb();
    insertJob(db);
    insertItem(db, 'item-1', 0, KEY_A);
    db.prepare(
      `INSERT INTO import_item_media (item_id, ordinal, media_id, entry_id)
       VALUES (?, 0, 'media-1', 'entry-1')`,
    ).run('item-1');

    expect(db.prepare('SELECT status FROM import_jobs WHERE id = ?').get(JOB)!.status).toBe(
      'parsing',
    );
    expect(
      Number(
        db.prepare('SELECT dropped_duplicates AS d FROM import_jobs WHERE id = ?').get(JOB)!.d,
      ),
    ).toBe(0);
    expect(db.prepare('SELECT status FROM import_items WHERE id = ?').get('item-1')!.status).toBe(
      'pending',
    );
    expect(
      db.prepare('SELECT upload_state AS u FROM import_item_media WHERE item_id = ?').get('item-1')!
        .u,
    ).toBe('pending');
    db.close();
  });

  it('leaves the database consistent: integrity_check ok, no FK violations', () => {
    const db = openDb();
    insertJob(db);
    insertItem(db, 'item-1', 0, KEY_A);
    db.prepare(
      `INSERT INTO import_item_media (item_id, ordinal, media_id, entry_id)
       VALUES (?, 0, 'media-1', 'entry-1')`,
    ).run('item-1');

    const integrity = db.prepare('PRAGMA integrity_check').all();
    expect(integrity).toEqual([{ integrity_check: 'ok' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('carries no source_item_id column on any of the three tables (#921/#925)', () => {
    const db = openDb();
    for (const table of ['import_jobs', 'import_items', 'import_item_media']) {
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => String(r.name));
      expect(columns).not.toContain('source_item_id');
    }
    db.close();
  });
});
