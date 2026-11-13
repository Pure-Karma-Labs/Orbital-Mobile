/**
 * Meta import persistence (#921) — CRUD over `import_jobs`, `import_items`
 * and `import_item_media` (migration 009).
 *
 * The #926 runner parses an archive ONCE, persists the result here before any
 * network call, and resumes from these rows after a restart without
 * re-parsing. This module is the whole storage contract for that run; the
 * runner, the #928 UI and nothing else call it.
 *
 * ## Rules every function in this file follows
 *
 *  - It opens with the `isDatabaseInitialized()` guard. Fast Refresh and the
 *    wipe paths both close the DB underneath live module state.
 *  - **Reads go through `queryOne`/`queryMany`**, never a raw `executeSync`:
 *    `mapRow` is what converts op-sqlite's BLOB `ArrayBuffer` into the
 *    `Uint8Array` that `import_key` is typed as. A raw read hands back an
 *    `ArrayBuffer` that compares unequal to every key the caller holds.
 *  - **Every id list is bound**, `?` placeholders chunked to <= 500. Nothing is
 *    interpolated into SQL — least of all a server-returned value.
 *  - `original_date` (item and media) is bound only when it is a safe integer
 *    inside a sane epoch-ms range; anything else binds NULL rather than
 *    poisoning the column with NaN.
 *
 * ## Handling classes (see migration 009's header)
 *
 *  - `import_items.body` is PLAINTEXT-CLASS: never logged, never in a thrown
 *    message, a breadcrumb or telemetry. It is NULLed as soon as the item
 *    reaches `created`/`duplicate`.
 *  - `import_items.source_file` / `source_index` are LOCAL-UI-class (F18).
 *  - `import_jobs.key_fingerprint` and `archive_bookmark` are never logged and
 *    never sent to the server. The bookmark is written ONLY from a live
 *    `ArchiveSession.parts` (order-preserving, never de-duplicated), and the
 *    runner RELEASES the parts BEFORE calling `finishImportJob`, which nulls
 *    the bookmark and hands back the JSON it cleared as a backstop.
 *  - There is deliberately no `sourceItemId` anywhere in this file.
 *
 * ## Removal trigger
 *
 * When #926 and #928 merge, delete every exported function here with zero
 * call sites outside `__tests__/repositories/importRepository.test.ts`.
 */

import { queryOne, queryMany, execute } from '../queryHelpers';
import { getDatabase, isDatabaseInitialized } from '../connection';
import type {
  ImportJobRow,
  ImportItemRow,
  ImportItemMediaRow,
  ImportItemStatus,
} from '../../types/database';
// The parser's skip-reason registry. `metaImport/types` imports NOTHING (it is
// a contract leaf by construction), so this edge drags no service graph into
// the database layer. It is imported rather than re-declared so that a new
// `SkipReason` shows up in the counts instead of silently missing a bucket.
import { SKIP_REASON_CLASS } from '../../services/metaImport/types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The statuses a launch-time resume has to consider. */
const ACTIVE_STATUSES = ['parsing', 'ready', 'in_progress'] as const;

/** Bound-parameter chunk size for `IN (…)` lists. SQLite's default cap is 999. */
const ID_CHUNK = 500;

/** 2100-01-01T00:00:00Z — anything beyond is not a date this app will see. */
const MAX_EPOCH_MS = 4102444800000;

/**
 * Epoch-ms guard for `original_date` on both tables.
 *
 * The value comes from a member's export, through a parser that bounds it —
 * but a column holding NaN or 1e21 is unqueryable and un-fixable afterwards,
 * so an out-of-range date is stored as "unknown" instead.
 */
function safeEpochMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) return null;
  if (value < 0 || value > MAX_EPOCH_MS) return null;
  return value;
}

/** Split an id list into bound-placeholder-sized chunks. */
function chunkIds(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    chunks.push(ids.slice(i, i + ID_CHUNK));
  }
  return chunks;
}

/** `?, ?, ?` for a bound `IN (…)` list. Never interpolates a value. */
function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface CreateImportJobInput {
  id: string;
  conversationId: string;
  source: ImportJobRow['source'];
  /**
   * `ImportKeySession.keyFingerprint`, taken from the session opened BEFORE
   * the parse. NOT NULL from creation so that a `ready` job's stored keys
   * carry their generation stamp; every resume transition re-opens a session
   * and compares.
   */
  keyFingerprint: string;
  /** Epoch ms. */
  createdAt: number;
}

/**
 * Create a job in `parsing`.
 *
 * Throws when a non-terminal job already exists: one import at a time per
 * device, and a second job would race the first over the same orbit, the same
 * server session and the same SAF grants.
 */
export function createImportJob(input: CreateImportJobInput): void {
  if (!isDatabaseInitialized()) return;

  const db = getDatabase();
  db.executeSync('BEGIN IMMEDIATE');
  try {
    const existing = queryOne<{ id: string }>(
      `SELECT id FROM import_jobs WHERE status IN (${placeholders(ACTIVE_STATUSES.length)}) LIMIT 1`,
      [...ACTIVE_STATUSES],
    );
    if (existing !== null) {
      throw new Error('IMPORT_JOB_ALREADY_ACTIVE');
    }
    execute(
      `INSERT INTO import_jobs
         (id, conversation_id, source, status, key_fingerprint,
          dropped_duplicates, created_at, updated_at)
       VALUES (?, ?, ?, 'parsing', ?, 0, ?, ?)`,
      [
        input.id,
        input.conversationId,
        input.source,
        input.keyFingerprint,
        Math.floor(input.createdAt),
        Math.floor(input.createdAt),
      ],
    );
    db.executeSync('COMMIT');
  } catch (error) {
    db.executeSync('ROLLBACK');
    throw error;
  }
}

/**
 * The one job a launch-time resume has to deal with, newest first.
 *
 * Served by `idx_import_jobs_active`.
 */
export function getActiveImportJob(): ImportJobRow | null {
  if (!isDatabaseInitialized()) return null;

  return queryOne<ImportJobRow>(
    `SELECT * FROM import_jobs
      WHERE status IN (${placeholders(ACTIVE_STATUSES.length)})
      ORDER BY created_at DESC
      LIMIT 1`,
    [...ACTIVE_STATUSES],
  );
}

export function getImportJob(id: string): ImportJobRow | null {
  if (!isDatabaseInitialized()) return null;
  return queryOne<ImportJobRow>('SELECT * FROM import_jobs WHERE id = ?', [id]);
}

/** Parse finished: record the declared totals (held items excluded) and move to `ready`. */
export function setImportJobParsed(
  id: string,
  { declaredPosts, declaredBytes }: { declaredPosts: number; declaredBytes: number },
): void {
  if (!isDatabaseInitialized()) return;

  execute(
    `UPDATE import_jobs
        SET status = 'ready', declared_posts = ?, declared_bytes = ?, updated_at = ?
      WHERE id = ?`,
    [Math.floor(declaredPosts), Math.floor(declaredBytes), Date.now(), id],
  );
}

/**
 * The server session exists: store its `import_id` and move to `in_progress`.
 *
 * Deliberately does NOT touch `key_fingerprint` — the stamp belongs to the key
 * generation the items were derived under, which is fixed at creation.
 */
export function startImportJob(id: string, { sessionId }: { sessionId: string }): void {
  if (!isDatabaseInitialized()) return;

  execute(
    `UPDATE import_jobs
        SET status = 'in_progress', session_id = ?, updated_at = ?
      WHERE id = ?`,
    [sessionId, Date.now(), id],
  );
}

export type TerminalImportJobStatus = 'completed' | 'cancelled' | 'failed';

/**
 * Move a job to a terminal status and clear its bookmark in the SAME UPDATE.
 *
 * Returns the bookmark JSON it cleared, or null. The contract is RELEASE the
 * archive parts FIRST, then finish — the return value is only a backstop for a
 * runner that has not released yet, so a terminal job never leaves a grant
 * behind with no record of which parts it held.
 *
 * The read and the write are two statements but cannot interleave: both are
 * synchronous `executeSync` calls with no await between them, and JS is the
 * only writer.
 */
export function finishImportJob(id: string, status: TerminalImportJobStatus): string | null {
  if (!isDatabaseInitialized()) return null;

  const prior = queryOne<{ archive_bookmark: string | null }>(
    'SELECT archive_bookmark FROM import_jobs WHERE id = ?',
    [id],
  );
  execute(
    `UPDATE import_jobs
        SET status = ?, archive_bookmark = NULL, updated_at = ?
      WHERE id = ?`,
    [status, Date.now(), id],
  );
  return prior?.archive_bookmark ?? null;
}

/**
 * Persist `JSON.stringify(session.parts)`.
 *
 * The caller passes the WHOLE serialized array and only when it differs from
 * the stored value; a token's interior is never inspected, and
 * `pickArchiveParts()` output is never persisted (it is uncapped — a live
 * session's `parts` is what bounds this to 64 entries).
 */
export function setArchiveBookmark(id: string, json: string): void {
  if (!isDatabaseInitialized()) return;

  execute('UPDATE import_jobs SET archive_bookmark = ?, updated_at = ? WHERE id = ?', [
    json,
    Date.now(),
    id,
  ]);
}

/** Delete one job. Cascades to its items and their media (migration 009 FKs). */
export function deleteImportJob(id: string): void {
  if (!isDatabaseInitialized()) return;
  execute('DELETE FROM import_jobs WHERE id = ?', [id]);
}

/**
 * Drop ALL import state. Called by `authService.localWipe` on logout and
 * deletion: the rows carry a member's post bodies and a key-generation stamp,
 * and the next account on this device must not inherit either. Cascades two
 * levels.
 */
export function deleteAllImportJobs(): void {
  if (!isDatabaseInitialized()) return;
  execute('DELETE FROM import_jobs');
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** One media attachment of a parsed post, as the parser hands it over. */
export interface ImportItemMediaInsert {
  /** Display order within the post. */
  ordinal: number;
  /** Lowercase UUIDv4 from `generateUUID()`. Stable across retries. */
  mediaId: string;
  /** Opaque archive entry id. Never parsed or truncated. */
  entryId: string;
  /** Epoch ms UTC, or null. */
  originalDate: number | null;
}

/** One parsed post — importable or skipped — as the parser hands it over. */
export interface ImportItemInsert {
  id: string;
  /** 0-based parse order within the job. Gaps from dropped duplicates are fine. */
  ordinal: number;
  /** 16 bytes (#924), or null for exactly the three pre-frame skips. */
  importKey: Uint8Array | null;
  status: ImportItemStatus;
  skipReason: ImportItemRow['skip_reason'];
  originalDate: number | null;
  /** PLAINTEXT-CLASS. Set for importable posts only; null for every skip. */
  body: string | null;
  sourceFile: string | null;
  sourceIndex: number | null;
  idKind: ImportItemRow['id_kind'];
  media?: readonly ImportItemMediaInsert[];
}

export interface InsertImportItemsResult {
  inserted: number;
  /** Rows the partial unique index rejected: the archive held the post twice. */
  duplicates: number;
}

/**
 * Insert a batch of parsed items and their media in ONE transaction.
 *
 * The transaction is per CALL, not per parse: #926 buffers ~100 items per
 * flush, and a single transaction spanning a minutes-long parse would starve
 * every other writer past the 5 s `busy_timeout`.
 *
 * Dedup: `ON CONFLICT (job_id, import_key) WHERE import_key IS NOT NULL DO
 * NOTHING` keeps the FIRST row, which is correct because `parseArchive` emits
 * the settled item before its `duplicate_in_archive` copies. The conflict
 * count is added to the job's `dropped_duplicates` inside the same
 * transaction, which is where that skip reason is stored.
 */
export function insertImportItems(
  jobId: string,
  rows: readonly ImportItemInsert[],
): InsertImportItemsResult {
  if (!isDatabaseInitialized() || rows.length === 0) {
    return { inserted: 0, duplicates: 0 };
  }

  const db = getDatabase();
  let inserted = 0;
  let duplicates = 0;

  db.executeSync('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const result = execute(
        `INSERT INTO import_items
           (id, job_id, ordinal, import_key, status, skip_reason,
            original_date, body, source_file, source_index, id_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (job_id, import_key) WHERE import_key IS NOT NULL DO NOTHING`,
        [
          row.id,
          jobId,
          row.ordinal,
          row.importKey,
          row.status,
          row.skipReason,
          safeEpochMs(row.originalDate),
          row.body,
          row.sourceFile,
          row.sourceIndex,
          row.idKind,
        ],
      );

      if (result.rowsAffected === 0) {
        duplicates += 1;
        continue;
      }
      inserted += 1;

      for (const media of row.media ?? []) {
        execute(
          `INSERT INTO import_item_media
             (item_id, ordinal, media_id, entry_id, original_date, upload_state)
           VALUES (?, ?, ?, ?, ?, 'pending')`,
          [row.id, media.ordinal, media.mediaId, media.entryId, safeEpochMs(media.originalDate)],
        );
      }
    }

    if (duplicates > 0) {
      execute(
        `UPDATE import_jobs
            SET dropped_duplicates = dropped_duplicates + ?, updated_at = ?
          WHERE id = ?`,
        [duplicates, Date.now(), jobId],
      );
    }

    db.executeSync('COMMIT');
  } catch (error) {
    db.executeSync('ROLLBACK');
    throw error;
  }

  return { inserted, duplicates };
}

/** A pending item plus its media, which is what one upload batch needs. */
export interface PendingImportItem extends ImportItemRow {
  media: ImportItemMediaRow[];
}

/**
 * The next `limit` pending items in parse order, each with its media.
 *
 * Two queries, not a join: a join would repeat every item's `body` once per
 * media row. Served by `idx_import_items_job_status` and the media PK.
 */
export function getPendingImportItems(jobId: string, limit: number): PendingImportItem[] {
  if (!isDatabaseInitialized()) return [];

  const items = queryMany<ImportItemRow>(
    `SELECT * FROM import_items
      WHERE job_id = ? AND status = 'pending'
      ORDER BY ordinal ASC
      LIMIT ?`,
    [jobId, Math.max(0, Math.floor(limit))],
  );
  if (items.length === 0) return [];

  const byItem = new Map<string, ImportItemMediaRow[]>();
  for (const chunk of chunkIds(items.map((i) => i.id))) {
    const media = queryMany<ImportItemMediaRow>(
      `SELECT * FROM import_item_media
        WHERE item_id IN (${placeholders(chunk.length)})
        ORDER BY item_id, ordinal ASC`,
      chunk,
    );
    for (const row of media) {
      const list = byItem.get(row.item_id);
      if (list === undefined) byItem.set(row.item_id, [row]);
      else list.push(row);
    }
  }

  return items.map((item) => ({ ...item, media: byItem.get(item.id) ?? [] }));
}

/** Mark a batch as in flight. Ids are bound and chunked, never interpolated. */
export function markItemsUploading(jobId: string, itemIds: readonly string[]): void {
  if (!isDatabaseInitialized() || itemIds.length === 0) return;

  for (const chunk of chunkIds(itemIds)) {
    execute(
      `UPDATE import_items SET status = 'uploading'
        WHERE job_id = ? AND id IN (${placeholders(chunk.length)})`,
      [jobId, ...chunk],
    );
  }
}

/** One row of the server's batch response, already mapped to a local item id. */
export interface ImportBatchResult {
  /** The LOCAL item id. #926 maps the echoed base64 `import_key` back to it. */
  itemId: string;
  status: 'created' | 'duplicate' | 'rejected';
  /** Server thread id for `created`/`duplicate`. */
  threadId?: string | null;
  /** Server reason code for `rejected`. */
  code?: string | null;
}

/**
 * Apply a batch response, keyed by ITEM ID — never by position.
 *
 * `created`/`duplicate` set `thread_id` and NULL the body: the thread exists
 * server-side by then, so the plaintext has no further use and should not sit
 * in the DB waiting for the next wipe. `rejected` becomes `failed` plus its
 * `error_code`. One transaction, so a batch is applied whole or not at all.
 */
export function applyBatchResults(jobId: string, results: readonly ImportBatchResult[]): void {
  if (!isDatabaseInitialized() || results.length === 0) return;

  const db = getDatabase();
  db.executeSync('BEGIN IMMEDIATE');
  try {
    for (const result of results) {
      if (result.status === 'rejected') {
        execute(
          `UPDATE import_items SET status = 'failed', error_code = ?
            WHERE id = ? AND job_id = ?`,
          [result.code ?? null, result.itemId, jobId],
        );
      } else {
        execute(
          `UPDATE import_items SET status = ?, thread_id = ?, body = NULL
            WHERE id = ? AND job_id = ?`,
          [result.status, result.threadId ?? null, result.itemId, jobId],
        );
      }
    }
    db.executeSync('COMMIT');
  } catch (error) {
    db.executeSync('ROLLBACK');
    throw error;
  }
}

/** Per-status counts for the job, exhaustive (zeros included). */
export function countImportItemsByStatus(jobId: string): Record<ImportItemStatus, number> {
  const counts: Record<ImportItemStatus, number> = {
    pending: 0,
    uploading: 0,
    created: 0,
    duplicate: 0,
    failed: 0,
    skipped: 0,
  };
  if (!isDatabaseInitialized()) return counts;

  const rows = queryMany<{ status: ImportItemStatus; n: number }>(
    'SELECT status, COUNT(*) AS n FROM import_items WHERE job_id = ? GROUP BY status',
    [jobId],
  );
  for (const row of rows) {
    if (row.status in counts) counts[row.status] = row.n;
  }
  return counts;
}

/** The skip-reason key set, exhaustive by construction (`SKIP_REASON_CLASS`). */
type SkipReasonKey = keyof typeof SKIP_REASON_CLASS;

/**
 * Per-reason skip counts for the job, exhaustive (zeros included).
 *
 * `duplicate_in_archive` is NOT a stored `skip_reason`: the dedup happens in
 * `insertImportItems`, where the losing row is never written at all, and the
 * count lives on `import_jobs.dropped_duplicates`. Folding it in here is what
 * makes this one exhaustive `Record<SkipReason, number>` for every caller —
 * #928 never has to know the counter exists.
 */
export function countImportSkipsByReason(jobId: string): Record<SkipReasonKey, number> {
  const counts = {} as Record<SkipReasonKey, number>;
  for (const reason of Object.keys(SKIP_REASON_CLASS) as SkipReasonKey[]) {
    counts[reason] = 0;
  }
  if (!isDatabaseInitialized()) return counts;

  const rows = queryMany<{ skip_reason: SkipReasonKey; n: number }>(
    `SELECT skip_reason, COUNT(*) AS n FROM import_items
      WHERE job_id = ? AND skip_reason IS NOT NULL
      GROUP BY skip_reason`,
    [jobId],
  );
  for (const row of rows) {
    if (row.skip_reason in counts) counts[row.skip_reason] = row.n;
  }

  const job = queryOne<{ dropped_duplicates: number }>(
    'SELECT dropped_duplicates FROM import_jobs WHERE id = ?',
    [jobId],
  );
  counts.duplicate_in_archive += job?.dropped_duplicates ?? 0;

  return counts;
}

/** What #928's "what did not migrate" list shows per skipped item. */
export interface SkippedImportItem {
  id: string;
  skip_reason: ImportItemRow['skip_reason'];
  /** Epoch ms UTC. */
  original_date: number | null;
  /** LOCAL UI ONLY (F18). */
  source_file: string | null;
  source_index: number | null;
}

/**
 * The skipped items for a job, optionally one reason only (held video, say).
 *
 * Served by `idx_import_items_job_reason`. Deliberately selects named columns:
 * the body is not part of this list and must not be read into a UI model.
 */
export function getSkippedItems(jobId: string, reason?: SkipReasonKey): SkippedImportItem[] {
  if (!isDatabaseInitialized()) return [];

  if (reason !== undefined) {
    return queryMany<SkippedImportItem>(
      `SELECT id, skip_reason, original_date, source_file, source_index
         FROM import_items
        WHERE job_id = ? AND skip_reason = ?
        ORDER BY ordinal ASC`,
      [jobId, reason],
    );
  }
  return queryMany<SkippedImportItem>(
    `SELECT id, skip_reason, original_date, source_file, source_index
       FROM import_items
      WHERE job_id = ? AND skip_reason IS NOT NULL
      ORDER BY ordinal ASC`,
    [jobId],
  );
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * Record that one media item's bytes are on the server.
 *
 * `upload_state` is a REQUEST-SAVING CACHE, not a source of truth: the
 * attachment key and metadata travel in the per-media encrypted envelope the
 * server stores on chunk 0, so a resume under the same `media_id` costs two
 * requests and charges nothing twice. No key material is persisted here.
 */
export function markMediaUploaded(itemId: string, ordinal: number): void {
  if (!isDatabaseInitialized()) return;

  execute(
    `UPDATE import_item_media SET upload_state = 'uploaded'
      WHERE item_id = ? AND ordinal = ?`,
    [itemId, ordinal],
  );
}

/**
 * Mint a fresh `media_id` for ONE (item, ordinal).
 *
 * The only legitimate reason is a server refusal that binds the old id — the
 * B#316 403 binding, or a 409 `CONFLICT` — after which the staged bytes under
 * the old id are the server's to GC. The new id has nothing uploaded, so the
 * cache flag goes back to `pending`.
 */
export function replaceMediaId(itemId: string, ordinal: number, newMediaId: string): void {
  if (!isDatabaseInitialized()) return;

  execute(
    `UPDATE import_item_media SET media_id = ?, upload_state = 'pending'
      WHERE item_id = ? AND ordinal = ?`,
    [newMediaId, itemId, ordinal],
  );
}
