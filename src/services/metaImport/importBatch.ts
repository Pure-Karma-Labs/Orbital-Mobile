/**
 * Batch assembly for the Meta import (#926 §4.6 + §4.11).
 *
 * ## The contract the runner (#926 B3) relies on
 *
 * Every function here is one STEP, callable on its own, in this order:
 *
 *   1. {@link isItemBatchEligible} — does this pending row still need media?
 *   2. {@link preflightImportItem} — local narrowing, BEFORE any crypto call.
 *   3. {@link buildImportItem} — seals title, body and meta through the key
 *      session and measures the wire bytes.
 *   4. {@link batchSizeLimit} + {@link assembleBatch} — the count cap and the
 *      4 MiB body cap.
 *   5. {@link claimBatch} — `markItemsUploading` before the POST.
 *   6. the runner POSTs (`submitImportBatch`); this module never calls the API.
 *   7. {@link mapBatchResults} then {@link applyBatchOutcome}.
 *
 * Failures on the way are either an item code ({@link failImportItems}) or a
 * thrown error the runner hands to `classifyImportFailure`. Nothing here
 * classifies, retries, waits, logs or captures.
 *
 * ## No raw group key, ever
 *
 * Title, body and the import-meta envelope are sealed ONLY through
 * `ImportKeySession.sealContent` / `sealImportMeta`, which verify the session
 * pin and re-read the live key with no await before the encrypt. `metaImport/`
 * never calls `getOrFetchGroupKey` or `encryptContent`, and ESLint
 * (`.eslintrc.js`, `CONTENT_CRYPTO_BAN`) makes that a build failure rather
 * than a convention. A crypto error is NOT caught here: it propagates so the
 * taxonomy can pause (pending wrap) or stop the run (changed key).
 *
 * ## Rule 0 before every write
 *
 * The three functions that touch `importRepository` ({@link claimBatch},
 * {@link applyBatchOutcome}, {@link failImportItems}) re-check
 * {@link isRunStale} immediately before the write and answer `cancelled`
 * instead — a reset between the await and the write must leave no `failed`
 * row and no job state behind.
 *
 * ## Dates are never substituted
 *
 * A row with a null or unusable `original_date` fails as an item. Fabricating
 * a date would seal a false provenance into an append-only envelope and into
 * `original_created_at`, which #927 renders as the post's real date.
 */

import {
  applyBatchResults,
  markItemsUploading,
  requeueImportItems,
  IMPORT_RESULT_UNKNOWN,
} from '../../database/repositories/importRepository';
import { isValidUUIDv4 } from '../../utils/uuid';
import { importKeyToWire } from '../crypto/importCrypto';
import { isRunStale } from './importErrors';

import type {
  ImportBatchResult,
  PendingImportItem,
} from '../../database/repositories/importRepository';
import type { ImportBatchItem, ImportBatchResultWire, ImportLimits } from '../../types/api';
import type { ImportKeySession } from '../crypto/importCrypto';
import type { ImportItemFailureCode, RunGuard } from './importErrors';

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** `import_key` is exactly 16 bytes (#924); a row that is not is not sendable. */
const IMPORT_KEY_BYTES = 16;

/**
 * The batch ceiling, independent of what the server advertises.
 *
 * `limits.batchMax` is 50 today and is READ rather than hardcoded, but it is
 * also clamped: a server that advertised 5,000 would otherwise have us build a
 * body no amount of halving recovers from inside one request timeout.
 */
export const IMPORT_BATCH_HARD_MAX = 50;

/**
 * Serialized-body cap, well under the app-wide `express.json({limit:'10mb'})`.
 *
 * 50 worst-case items are ~2.7 MB, so this never binds today — it guards a
 * future `BODY_MAX_CHARS` change, and it is why the bare-413 halve arm is
 * defence rather than dead code.
 */
export const IMPORT_BATCH_MAX_BYTES = 4 * 1024 * 1024;

/** `{"items":[]}` — the fixed part of the request body. */
const BATCH_ENVELOPE_BYTES = 12;

/**
 * Bytes added per item by the client's camelCase → snake_case body transform.
 *
 * The plan's byte argument ("every field is ASCII, so `JSON.stringify(item)
 * .length` IS the byte length") is true of the VALUES but not of the KEYS:
 * `client.ts` rewrites `encryptedImportMeta` to `encrypted_import_meta` before
 * serializing, which is +2. Summed over the nine item keys the expansion is
 * 12 bytes, counted here as a constant so the measurement stays exact without
 * importing the transform (and with it `client.ts`'s whole module graph) into
 * this layer. Over-counting by a few bytes per item is the safe direction for
 * a cap.
 */
const WIRE_KEY_EXPANSION_BYTES = 12;

// ---------------------------------------------------------------------------
// The server's per-item rejected codes
// ---------------------------------------------------------------------------

/**
 * The ONLY `rejected` codes a batch result may carry into
 * `import_items.error_code` (B#315, `config/imports.js`).
 *
 * Frozen allowlist because `applyBatchResults` allowlists the STATUS but
 * passes `code` straight through: without this, a widened server vocabulary
 * would be persisted locally and later rendered by #927's per-code copy table.
 * Anything else becomes the local {@link IMPORT_RESULT_UNKNOWN} sentinel.
 */
export const IMPORT_ITEM_CODES = Object.freeze({
  IMPORT_ITEM_INVALID: 1,
  IMPORT_DATE_INVALID: 1,
  IMPORT_MEDIA_NOT_OWNED: 1,
});

export type ImportItemCode = keyof typeof IMPORT_ITEM_CODES;

/**
 * Allowlist membership test — `hasOwnProperty.call`, not `in`: `in` walks the
 * prototype chain, so a server code of `constructor` or `toString` would pass
 * and be written to the column.
 */
export function isImportItemCode(code: unknown): code is ImportItemCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(IMPORT_ITEM_CODES, code);
}

// ---------------------------------------------------------------------------
// Local per-item preflight
// ---------------------------------------------------------------------------

/** A pending row narrowed to the facts a payload needs. No nullable left. */
export interface PreflightedItem {
  readonly itemId: string;
  /** Standard padded base64 of the 16-byte key (`importKeyToWire`). */
  readonly importKeyWire: string;
  /** Epoch ms UTC, as stored. */
  readonly originalDateMs: number;
  /** UTC `YYYY-MM-DD` — derived, never defaulted. */
  readonly originalCreatedAt: string;
  readonly body: string;
  /** The item's `media_id`s in `ordinal` order, lowercase. */
  readonly mediaIds: readonly string[];
}

export type ItemPreflight =
  | { readonly ok: true; readonly item: PreflightedItem }
  | { readonly ok: false; readonly code: ImportItemFailureCode };

/**
 * Is every one of this item's media files already on the server?
 *
 * `upload_state` is a request-saving cache, so this is "do we still have work
 * to do", not a source of truth. An item is batch-eligible only when every
 * ordinal reads `uploaded` (§4.10.6).
 */
export function isItemBatchEligible(row: PendingImportItem): boolean {
  return row.media.every((m) => m.upload_state === 'uploaded');
}

/**
 * Narrow one pending row, or name the item code it fails with.
 *
 * Runs BEFORE any crypto call, and the null checks are the point (§4.6):
 * `ImportItemRow` types `import_key`, `original_date` and `body` as nullable.
 * A null date would otherwise reach `sealImportMeta`'s safe-integer guard and
 * throw `ImportCryptoInvariantError`, which classifies `terminal-for-run` —
 * one bad row would kill the whole archive. A null key would throw a bare
 * `TypeError` that the crypto classifier answers `null` for.
 */
export function preflightImportItem(row: PendingImportItem, limits: ImportLimits): ItemPreflight {
  const invalid = { ok: false, code: 'IMPORT_ITEM_INVALID' } as const;

  if (row.import_key === null || row.import_key.length !== IMPORT_KEY_BYTES) return invalid;
  if (row.body === null) return invalid;

  const dateMs = row.original_date;
  if (dateMs === null || !Number.isSafeInteger(dateMs)) return invalid;
  const date = new Date(dateMs);
  const iso = Number.isNaN(date.getTime()) ? null : date.toISOString();
  if (iso === null) return invalid;

  const mediaIds = [...row.media].sort((a, b) => a.ordinal - b.ordinal).map((m) => m.media_id);
  if (mediaIds.length > limits.mediaPerItemMax) return invalid;
  // The server refuses intra-item duplicates; a collision can only come from a
  // `replaceMediaId` landing on an id this item already holds, and catching it
  // here costs one Set instead of a round trip.
  if (new Set(mediaIds).size !== mediaIds.length) return invalid;

  return {
    ok: true,
    item: {
      itemId: row.id,
      importKeyWire: importKeyToWire(row.import_key),
      originalDateMs: dateMs,
      // `toISOString` is spec-fixed and allowed by the Intl/toLocale* ban.
      originalCreatedAt: iso.slice(0, 10),
      body: row.body,
      mediaIds,
    },
  };
}

// ---------------------------------------------------------------------------
// Payload per item (§4.11)
// ---------------------------------------------------------------------------

/** One sealed item plus the bytes it will occupy on the wire. */
export interface BuiltImportItem {
  readonly itemId: string;
  readonly wire: ImportBatchItem;
  /** Exact serialized size of this item inside the request body. */
  readonly bytes: number;
}

export type ItemBuild =
  | { readonly ok: true; readonly built: BuiltImportItem }
  | { readonly ok: false; readonly code: ImportItemFailureCode };

/** Serialized wire size of one item, including the snake_case key expansion. */
export function wireItemBytes(wire: ImportBatchItem): number {
  // Every value is ASCII — base64 ciphertext and IVs, `YYYY-MM-DD`, UUIDs — so
  // the JSON string's length IS its UTF-8 byte length.
  return JSON.stringify(wire).length + WIRE_KEY_EXPANSION_BYTES;
}

/**
 * Serialized size of the whole request body for a batch.
 *
 * The ONE owner of this arithmetic: {@link assembleBatch} measures each
 * candidate batch through it rather than accumulating a running total of its
 * own, so the byte cap is enforced against the same number the tests assert
 * and a future change to the envelope or the separator has a single site.
 */
export function batchRequestBytes(batch: readonly BuiltImportItem[]): number {
  if (batch.length === 0) return BATCH_ENVELOPE_BYTES;
  const items = batch.reduce((sum, b) => sum + b.bytes, 0);
  return BATCH_ENVELOPE_BYTES + items + (batch.length - 1);
}

/**
 * Seal one preflighted item into its wire payload (§4.11).
 *
 * The EMPTY title is deliberate and decided here: the backend requires
 * `encrypted_title` length >= 1, GCM of the empty string is the 16-byte tag
 * alone (24 base64 chars), and the "no text appended" rule forbids inventing
 * one. There is no single-space fallback — `' '.length > 0` would pass
 * `ThreadHeader`'s guard and paint a blank line in #927.
 *
 * Crypto errors are NOT caught: `ImportKeyChangedError`, `PendingWrapError`
 * and friends must reach `classifyImportFailure`, which pauses or stops the
 * run. Only the server's own length limits are answered with an item code.
 */
export async function buildImportItem(
  item: PreflightedItem,
  session: ImportKeySession,
  limits: ImportLimits,
): Promise<ItemBuild> {
  const invalid = { ok: false, code: 'IMPORT_ITEM_INVALID' } as const;

  const title = await session.sealContent('');
  const body = await session.sealContent(item.body);
  const meta = await session.sealImportMeta(item.originalDateMs);

  if (title.ciphertext.length === 0 || title.ciphertext.length > limits.titleMax) return invalid;
  if (body.ciphertext.length > limits.bodyMax) return invalid;
  if (title.iv.length === 0 || title.iv.length > limits.ivMax) return invalid;
  if (body.iv.length === 0 || body.iv.length > limits.ivMax) return invalid;
  // Base64 is ASCII, so `.length` is the octet count the server measures.
  if (meta.encryptedImportMeta.length > limits.metaMaxBytes) return invalid;
  if (meta.importMetaIv.length === 0 || meta.importMetaIv.length > limits.ivMax) return invalid;

  const wire: ImportBatchItem = {
    importKey: item.importKeyWire,
    originalCreatedAt: item.originalCreatedAt,
    encryptedTitle: title.ciphertext,
    encryptedBody: body.ciphertext,
    titleIv: title.iv,
    bodyIv: body.iv,
    encryptedImportMeta: meta.encryptedImportMeta,
    importMetaIv: meta.importMetaIv,
    ...(item.mediaIds.length > 0 ? { mediaIds: [...item.mediaIds] } : {}),
  };

  return { ok: true, built: { itemId: item.itemId, wire, bytes: wireItemBytes(wire) } };
}

// ---------------------------------------------------------------------------
// Assembly and halving
// ---------------------------------------------------------------------------

/**
 * How many items one POST may carry: the server's own cap, clamped by
 * {@link IMPORT_BATCH_HARD_MAX}, and never below 1.
 *
 * `requested` is the runner's current size after any halving.
 */
export function batchSizeLimit(limits: ImportLimits, requested?: number): number {
  const advertised = Number.isSafeInteger(limits.batchMax)
    ? limits.batchMax
    : IMPORT_BATCH_HARD_MAX;
  const ceiling = Math.min(advertised, IMPORT_BATCH_HARD_MAX);
  const wanted = requested === undefined ? ceiling : Math.min(requested, ceiling);
  return Math.max(1, Math.floor(wanted));
}

/**
 * Split built items into the slice that fits one POST and the rest.
 *
 * Both caps apply: the item count and {@link IMPORT_BATCH_MAX_BYTES}. The
 * first item is ALWAYS taken even when it alone exceeds the byte cap — a
 * single over-size item is what the halving floor exists for ({@link
 * halveBatchSize} reaching 1, then `IMPORT_ITEM_TOO_LARGE`), and deferring it
 * forever would stall the run on one post.
 */
export function assembleBatch(
  built: readonly BuiltImportItem[],
  options: { readonly maxItems: number; readonly maxBytes?: number },
): { readonly batch: BuiltImportItem[]; readonly deferred: BuiltImportItem[] } {
  const maxItems = Math.max(1, Math.floor(options.maxItems));
  const maxBytes = options.maxBytes ?? IMPORT_BATCH_MAX_BYTES;

  const batch: BuiltImportItem[] = [];

  for (const item of built) {
    if (batch.length >= maxItems) break;
    // Measured through `batchRequestBytes` rather than a running total, so
    // one expression owns the envelope-plus-separators arithmetic. The batch
    // is at most `IMPORT_BATCH_HARD_MAX` items, so re-summing per candidate
    // costs nothing worth a second copy of the formula.
    if (batch.length > 0 && batchRequestBytes([...batch, item]) > maxBytes) break;
    batch.push(item);
  }

  return { batch, deferred: built.slice(batch.length) };
}

/**
 * The halving step for `IMPORT_BATCH_TOO_LARGE` and a bare 413.
 *
 * Returns the next size to try, never below 1. At 1 the runner stops halving
 * and fails that one item locally with `IMPORT_ITEM_TOO_LARGE`:
 * {@link isBatchHalvingExhausted} is that test, named so the floor is not an
 * inline `=== 1` three call sites apart.
 */
export function halveBatchSize(size: number): number {
  return Math.max(1, Math.floor(size / 2));
}

/** True when a too-large batch cannot be split any further. */
export function isBatchHalvingExhausted(size: number): boolean {
  return size <= 1;
}

// ---------------------------------------------------------------------------
// Result mapping (§4.6)
// ---------------------------------------------------------------------------

export interface MappedBatchResults {
  /** Ready for `applyBatchResults`, keyed by LOCAL item id. */
  readonly applied: ImportBatchResult[];
  readonly created: number;
  readonly duplicate: number;
  readonly failed: number;
  /** Results that matched no submitted item. A server bug if ever non-zero. */
  readonly unmatched: number;
  /** Submitted items the response said nothing about. Left `uploading`. */
  readonly unanswered: string[];
}

/**
 * Join a batch response back to local item ids.
 *
 * Primary join is the echoed `import_key`, falling back to INDEX when the echo
 * is null (`results` is dense and index-aligned with `items`, so the position
 * is a real fact and not a guess). An id already consumed by an earlier result
 * is never reused, so a server that echoed the same key twice cannot overwrite
 * one item with another's outcome.
 *
 * `rejected` codes are allowlisted ({@link isImportItemCode}); a status this
 * build does not know becomes a `rejected` with {@link IMPORT_RESULT_UNKNOWN},
 * which the repository writes as `failed` — the item is parked, never trusted.
 * The echoed `threadId` is shape-gated the same way: UUID v4 or null.
 */
export function mapBatchResults(
  batch: readonly BuiltImportItem[],
  results: readonly ImportBatchResultWire[],
): MappedBatchResults {
  const byKey = new Map<string, string>();
  for (const item of batch) {
    if (!byKey.has(item.wire.importKey)) byKey.set(item.wire.importKey, item.itemId);
  }

  const used = new Set<string>();
  const applied: ImportBatchResult[] = [];
  let created = 0;
  let duplicate = 0;
  let failed = 0;
  let unmatched = 0;

  results.forEach((result, index) => {
    const echoed = typeof result.importKey === 'string' ? byKey.get(result.importKey) : undefined;
    const byIndex = batch[index]?.itemId;
    const itemId =
      echoed !== undefined && !used.has(echoed)
        ? echoed
        : byIndex !== undefined && !used.has(byIndex)
          ? byIndex
          : undefined;

    if (itemId === undefined) {
      unmatched += 1;
      return;
    }
    used.add(itemId);

    if (result.status === 'created' || result.status === 'duplicate') {
      // The echoed `thread_id` is the one server-supplied value here that is
      // not a closed enum, and #927 will NAVIGATE by it — so it is accepted
      // only in the shape our own ids have, exactly as the `rejected` code is
      // accepted only from the allowlist below. Anything else is stored as
      // null: the status still counts as created/duplicate, because the post
      // does exist server-side and a thread re-fetch can supply the id, while
      // a `failed` row here would strand a created post forever.
      const threadId =
        typeof result.threadId === 'string' && isValidUUIDv4(result.threadId)
          ? result.threadId
          : null;
      applied.push({ itemId, status: result.status, threadId });
      if (result.status === 'created') created += 1;
      else duplicate += 1;
      return;
    }

    failed += 1;
    applied.push({
      itemId,
      status: 'rejected',
      code:
        result.status === 'rejected' && isImportItemCode(result.code)
          ? result.code
          : IMPORT_RESULT_UNKNOWN,
    });
  });

  return {
    applied,
    created,
    duplicate,
    failed,
    unmatched,
    unanswered: batch.filter((b) => !used.has(b.itemId)).map((b) => b.itemId),
  };
}

// ---------------------------------------------------------------------------
// Repository writes — each one rule-0 guarded
// ---------------------------------------------------------------------------

/**
 * `ok` with the write's own answer, `cancelled` when the run moved on (rule 0),
 * `stale` when the rows were not in the status this caller assumed — which
 * means the caller's copy of the job is stale and must be re-read, never
 * ignored (`importRepository`'s status-guarded-writer contract).
 */
export type BatchWrite<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'stale' };

/**
 * Mark a batch in flight before the POST.
 *
 * `markItemsUploading` is guarded by `status = 'pending'`, so a short count
 * means some of these items are no longer ours to send: `stale`.
 */
export function claimBatch(
  jobId: string,
  batch: readonly BuiltImportItem[],
  guard: RunGuard,
): BatchWrite<number> {
  if (isRunStale(guard)) return { kind: 'cancelled' };
  if (batch.length === 0) return { kind: 'ok', value: 0 };

  const itemIds = batch.map((b) => b.itemId);
  const moved = markItemsUploading(jobId, itemIds);
  if (moved < itemIds.length) return { kind: 'stale' };
  return { kind: 'ok', value: moved };
}

/**
 * Put claimed-but-unsent items back in the queue — the halving remainder, and
 * the tail of a batch the run stopped before sending.
 */
export function releaseBatchClaim(
  jobId: string,
  itemIds: readonly string[],
  guard: RunGuard,
): BatchWrite<number> {
  if (isRunStale(guard)) return { kind: 'cancelled' };
  if (itemIds.length === 0) return { kind: 'ok', value: 0 };
  return { kind: 'ok', value: requeueImportItems(jobId, { from: 'uploading', itemIds }) };
}

/** Apply a mapped batch response. One transaction, whole or not at all. */
export function applyBatchOutcome(
  jobId: string,
  applied: readonly ImportBatchResult[],
  guard: RunGuard,
): BatchWrite<number> {
  if (isRunStale(guard)) return { kind: 'cancelled' };
  if (applied.length === 0) return { kind: 'ok', value: 0 };

  applyBatchResults(jobId, applied);
  return { kind: 'ok', value: applied.length };
}

/**
 * Fail items with OUR OWN codes, through the same writer the server's results
 * go through (§4.7): no second repository function, and for this path the code
 * string is client-defined.
 */
export function failImportItems(
  jobId: string,
  failures: readonly { readonly itemId: string; readonly code: ImportItemFailureCode }[],
  guard: RunGuard,
): BatchWrite<number> {
  if (isRunStale(guard)) return { kind: 'cancelled' };
  if (failures.length === 0) return { kind: 'ok', value: 0 };

  applyBatchResults(
    jobId,
    failures.map((f) => ({ itemId: f.itemId, status: 'rejected' as const, code: f.code })),
  );
  return { kind: 'ok', value: failures.length };
}
