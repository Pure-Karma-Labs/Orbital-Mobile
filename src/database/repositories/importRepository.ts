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
 *  - **Every status transition re-asserts the status it is coming from**, in
 *    the UPDATE's own WHERE clause, and reports whether the row moved
 *    (`boolean` for the job writers, a row count for the item writers). The
 *    runner holds a job in memory across awaits and the UI can cancel under
 *    it, so an unguarded write would resurrect a terminal job or demote an
 *    item the server has already taken. A `false`/short count is never a
 *    failure to handle — it means "your copy of this row is stale, re-read
 *    it".
 *
 * ## Handling classes (see migration 009's header)
 *
 *  - `import_items.body` is PLAINTEXT-CLASS: never logged, never in a thrown
 *    message, a breadcrumb or telemetry. It is NULLed as soon as the item
 *    reaches `created`/`duplicate`, and `finishImportJob` drops whatever is
 *    left on every other item of that job.
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
  ImportJobStatus,
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
 * `idx_import_jobs_active` serves the STATUS lookup (`SEARCH … USING INDEX
 * idx_import_jobs_active (status=?)`); the `ORDER BY created_at DESC` still
 * costs a temp B-tree, because a three-value `IN` is three index ranges and
 * no one of them is in the required order. That is measured, not assumed —
 * see the EXPLAIN QUERY PLAN case in `migrations.ddl.test.ts`, which also
 * pins that this index must NOT be partial.
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

/**
 * Parse finished: record the declared totals (held items excluded) and move to
 * `ready`.
 *
 * **Guarded by `AND status = 'parsing'`**, and returns whether the row moved.
 * A miss means the job is no longer the one this caller thinks it is holding —
 * cancelled from the UI, finished, or already parsed — and writing anyway
 * would resurrect a terminal job with a `ready` status and no session. #926
 * treats `false` as "stop working on this job and re-read it", never as a
 * silent success: see the predicate note on `startImportJob`.
 */
export function setImportJobParsed(
  id: string,
  { declaredPosts, declaredBytes }: { declaredPosts: number; declaredBytes: number },
): boolean {
  if (!isDatabaseInitialized()) return false;

  const result = execute(
    `UPDATE import_jobs
        SET status = 'ready', declared_posts = ?, declared_bytes = ?, updated_at = ?
      WHERE id = ? AND status = 'parsing'`,
    [Math.floor(declaredPosts), Math.floor(declaredBytes), Date.now(), id],
  );
  return result.rowsAffected > 0;
}

/**
 * The server session exists: store its `import_id` and move to `in_progress`.
 *
 * Deliberately does NOT touch `key_fingerprint` — the stamp belongs to the key
 * generation the items were derived under, which is fixed at creation.
 *
 * **Guarded by `AND status = 'ready'`**, and returns whether the row moved.
 *
 * A predicate miss is a SILENT NO-OP AT THE SQL LEVEL that this return value
 * makes visible: the repository has no way to tell "the job is gone" from "the
 * job moved on", and throwing would make every writer a failure path for a
 * state the runner can simply re-read. The rule for #926 is therefore: a
 * `false` from any of these writers means re-read the job with
 * `getImportJob()` and decide there — it must never be ignored, because the
 * caller's in-memory job is stale by definition once one of them misses.
 */
export function startImportJob(id: string, { sessionId }: { sessionId: string }): boolean {
  if (!isDatabaseInitialized()) return false;

  const result = execute(
    `UPDATE import_jobs
        SET status = 'in_progress', session_id = ?, updated_at = ?
      WHERE id = ? AND status = 'ready'`,
    [sessionId, Date.now(), id],
  );
  return result.rowsAffected > 0;
}

export type TerminalImportJobStatus = Extract<
  ImportJobStatus,
  'completed' | 'cancelled' | 'failed'
>;

/**
 * Move a job to a terminal status and clear its bookmark in the SAME UPDATE.
 *
 * Returns the bookmark JSON it cleared, or null. The contract is RELEASE the
 * archive parts FIRST, then finish — the return value is only a backstop for a
 * runner that has not released yet, so a terminal job never leaves a grant
 * behind with no record of which parts it held.
 *
 * It also drops the PLAINTEXT-CLASS bodies this job still holds. `created` and
 * `duplicate` items were already emptied by `applyBatchResults`; the rest —
 * `pending`, `uploading` and `failed` — are posts that will never be submitted
 * from this job, and their text would otherwise sit in the DB until the next
 * logout or wipe. A later retry re-parses rather than reading them back, so
 * nothing downstream needs them: the member re-picks the archive and the keys
 * re-derive identically. Skips already have a NULL body.
 *
 * The read and the two writes are three statements but cannot interleave: all
 * are synchronous `executeSync` calls with no await between them, and JS is
 * the only writer.
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
  execute(
    `UPDATE import_items SET body = NULL
      WHERE job_id = ? AND body IS NOT NULL AND status NOT IN (?, ?)`,
    [id, 'created', 'duplicate'],
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
 *
 * **Guarded by the active-status set**, and returns whether the row was
 * written. `finishImportJob` NULLs this column on purpose, so a bookmark write
 * that lands after it would put a capability handle back on a job nothing will
 * ever release — the predicate is what keeps "released, then finished"
 * terminal. As with the other writers, `false` means re-read the job.
 */
export function setArchiveBookmark(id: string, json: string): boolean {
  if (!isDatabaseInitialized()) return false;

  const result = execute(
    `UPDATE import_jobs SET archive_bookmark = ?, updated_at = ?
      WHERE id = ? AND status IN (${placeholders(ACTIVE_STATUSES.length)})`,
    [json, Date.now(), id, ...ACTIVE_STATUSES],
  );
  return result.rowsAffected > 0;
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
 * media row. The item query is served end to end by
 * `idx_import_items_job_status` (`job_id=? AND status=?`, with `ordinal`
 * supplying the ORDER BY), and the media query by the composite PK.
 *
 * It matches `status = 'pending'` ONLY. Items parked in `uploading` or
 * `failed` are invisible here by design and come back through
 * {@link requeueImportItems}, which a resume runs first.
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

/**
 * Mark a batch as in flight. Ids are bound and chunked, never interpolated.
 *
 * **Guarded by `AND status = 'pending'`**, and returns how many rows actually
 * moved. The guard makes the call idempotent: a runner that re-sends a batch
 * after a timed-out POST (the response may have been applied before the
 * timeout fired) would otherwise demote its own `created` rows back to
 * `uploading`, and a kill inside that window would strand a post that exists
 * server-side. An item can therefore only ever move forward from the state
 * `getPendingImportItems` handed out.
 *
 * A return value below `itemIds.length` means some ids were no longer pending;
 * the batch the caller is about to send is stale, so re-read it.
 */
export function markItemsUploading(jobId: string, itemIds: readonly string[]): number {
  if (!isDatabaseInitialized() || itemIds.length === 0) return 0;

  let moved = 0;
  for (const chunk of chunkIds(itemIds)) {
    const result = execute(
      `UPDATE import_items SET status = 'uploading'
        WHERE job_id = ? AND status = 'pending' AND id IN (${placeholders(chunk.length)})`,
      [jobId, ...chunk],
    );
    moved += result.rowsAffected;
  }
  return moved;
}

/**
 * Put items back in the queue: `uploading` or `failed` → `pending`.
 *
 * This is the only way out of those two states, and without it the resume
 * story has a hole at each end:
 *
 *  - **`uploading`.** A process kill between `markItemsUploading` and
 *    `applyBatchResults` leaves rows that `getPendingImportItems` (which
 *    matches `status = 'pending'`) can never see again. The job would look
 *    drained with posts missing. #926 requeues `uploading` at launch, BEFORE
 *    the first `getPendingImportItems`: a resubmitted post the server already
 *    took comes back `duplicate`, which is exactly what the `import_key`
 *    dedup is for, so requeuing an item that was in fact delivered costs one
 *    batch slot and nothing else.
 *  - **`failed`.** The B#315 `IMPORT_MEDIA_NOT_OWNED` recovery is
 *    `replaceMediaId` (which resets `upload_state` to `pending`) and then a
 *    retry — which needs the ITEM back in the queue too. `error_code` is
 *    cleared so the next attempt is not read through the last one's refusal.
 *
 * `body` is deliberately KEPT: it is the submit payload the retry needs, and
 * the `rejected` arm of `applyBatchResults` never cleared it. The corollary is
 * that this must not be called on a job `finishImportJob` has already emptied
 * — a terminal job is re-run by re-parsing, not by requeuing.
 *
 * Pass `itemIds` to requeue a specific set (bound and chunked); omit it for
 * every item of the job in that status. An explicitly EMPTY array requeues
 * nothing, so a caller that computed an empty set cannot accidentally mean
 * "all". Returns the number of rows moved.
 */
export function requeueImportItems(
  jobId: string,
  { from, itemIds }: { from: 'uploading' | 'failed'; itemIds?: readonly string[] },
): number {
  if (!isDatabaseInitialized()) return 0;

  if (itemIds === undefined) {
    const result = execute(
      `UPDATE import_items SET status = 'pending', error_code = NULL
        WHERE job_id = ? AND status = ?`,
      [jobId, from],
    );
    return result.rowsAffected;
  }
  if (itemIds.length === 0) return 0;

  let moved = 0;
  for (const chunk of chunkIds(itemIds)) {
    const result = execute(
      `UPDATE import_items SET status = 'pending', error_code = NULL
        WHERE job_id = ? AND status = ? AND id IN (${placeholders(chunk.length)})`,
      [jobId, from, ...chunk],
    );
    moved += result.rowsAffected;
  }
  return moved;
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
 * The `error_code` written when a batch result carries a status this client
 * does not know.
 *
 * LOCAL SENTINEL, never a server code: the B#315 per-item set is
 * `IMPORT_ITEM_INVALID` / `IMPORT_DATE_INVALID` / `IMPORT_MEDIA_NOT_OWNED`,
 * and a fourth value means the server moved ahead of this build. The item is
 * parked as `failed` rather than trusted, so a widened server vocabulary can
 * never steer `import_items.status` (the one column the resume loop reads)
 * into a value outside `ImportItemStatus`.
 */
export const IMPORT_RESULT_UNKNOWN = 'IMPORT_RESULT_UNKNOWN';

/**
 * Apply a batch response, keyed by ITEM ID — never by position.
 *
 * `created`/`duplicate` set `thread_id` and NULL the body: the thread exists
 * server-side by then, so the plaintext has no further use and should not sit
 * in the DB waiting for the next wipe. Everything else becomes `failed`:
 * `rejected` with the server's own `error_code`, any other status with
 * {@link IMPORT_RESULT_UNKNOWN}. One transaction, so a batch is applied whole
 * or not at all.
 *
 * The status written is chosen from a local allowlist and is never the
 * server's string pasted through — results arrive over the wire, and the
 * TypeScript union on `ImportBatchResult` is erased at runtime.
 */
export function applyBatchResults(jobId: string, results: readonly ImportBatchResult[]): void {
  if (!isDatabaseInitialized() || results.length === 0) return;

  const db = getDatabase();
  db.executeSync('BEGIN IMMEDIATE');
  try {
    for (const result of results) {
      const accepted = result.status === 'created' || result.status === 'duplicate';
      if (accepted) {
        execute(
          `UPDATE import_items SET status = ?, thread_id = ?, body = NULL
            WHERE id = ? AND job_id = ?`,
          [result.status, result.threadId ?? null, result.itemId, jobId],
        );
      } else {
        execute(
          `UPDATE import_items SET status = 'failed', error_code = ?
            WHERE id = ? AND job_id = ?`,
          [
            result.status === 'rejected' ? (result.code ?? null) : IMPORT_RESULT_UNKNOWN,
            result.itemId,
            jobId,
          ],
        );
      }
    }
    db.executeSync('COMMIT');
  } catch (error) {
    db.executeSync('ROLLBACK');
    throw error;
  }
}

/**
 * Per-status counts for the job, exhaustive (zeros included).
 *
 * `skipped` here counts STORED skips only. The `duplicate_in_archive` rows are
 * never inserted — their home is `import_jobs.dropped_duplicates` — so this
 * total is smaller than the sum of {@link countImportSkipsByReason}, which
 * folds that counter back in. A screen that shows "N skipped" beside a
 * per-reason breakdown must take both from `countImportSkipsByReason`, or its
 * list will out-total its own header.
 */
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
    // `hasOwnProperty.call`, not `in`: `in` walks the prototype chain, so a
    // stored status of `toString` or `constructor` would pass the guard and
    // write a count onto a key no caller declares.
    if (Object.prototype.hasOwnProperty.call(counts, row.status)) counts[row.status] = row.n;
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
    // See the note in `countImportItemsByStatus`: own keys only.
    if (Object.prototype.hasOwnProperty.call(counts, row.skip_reason)) {
      counts[row.skip_reason] = row.n;
    }
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
 * `idx_import_items_job_reason` serves the filter (both the bare
 * `skip_reason IS NOT NULL` form and the `skip_reason = ?` one, which SQLite
 * proves implies it); the `ORDER BY ordinal` costs a temp B-tree, which is
 * fine for a list the member reads once. Deliberately selects named columns:
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
