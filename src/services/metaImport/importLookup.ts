/**
 * The import pre-check: which of this archive's posts are ALREADY threads in
 * this orbit (#930).
 *
 * ## Why it exists
 *
 * The server's `import_key` dedup only runs at batch submit, and `runCycle`
 * uploads a page's media BEFORE it submits that page. So re-picking an archive
 * that was already imported into the same orbit re-uploaded every file: the
 * bytes were charged to `bytes_used`, the media was never attached, and it was
 * held for a year. `startImport` would also refuse the whole re-import for
 * posts, because the client declares the archive and not the delta.
 *
 * ## The contract the runner relies on
 *
 * Two steps, in this order, once per page:
 *
 *   1. {@link nextLookupPage} — read a page of pending keys and encode them.
 *   2. the runner POSTs (`lookupImportKeys`); **this module never calls the
 *      API**, the same division `importBatch` and `importMedia` keep.
 *   3. {@link applyLookupResponse} — move the matches to `present`.
 *
 * Nothing here classifies, retries, waits or decides whether to look up at
 * all. The skip conditions, rule 0 and the "any throw means no further
 * matches" policy are the runner's, because they are decisions about the run.
 *
 * ## Advisory by construction
 *
 * A match means "there is a thread with this key in this orbit right now". It
 * is not authoritative and does not have to be: the server's batch dedup stays
 * the backstop, a thread deleted after import reads as absent and is imported
 * again, and a post another device creates after this job parsed is still
 * re-uploaded. Every one of those is today's behaviour.
 *
 * ## Handling classes
 *
 * `import_key` is derived from the v1 identity frame, which embeds the
 * member's own post text: it is never logged, thrown or captured. This module
 * makes no log call at all (the `meta-import-no-content-logging` invariant
 * covers this whole directory), and it holds no plaintext — the keys it reads
 * are the 16 opaque bytes, and `markImportItemsPresent` NULLs the body of
 * every row it moves.
 */

import {
  getPendingImportKeyPage,
  markImportItemsPresent,
} from '../../database/repositories/importRepository';
import { importKeyToWire } from '../crypto/importCrypto';

import type { ImportLookupResponse } from '../../types/api';

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/**
 * The page ceiling, independent of what the server advertises.
 *
 * Mirrors Orbital-Backend `IMPORT_LOOKUP_MAX` (`src/config/imports.js`), which
 * is served as `limits.lookup_max`. The advertised value is READ rather than
 * hardcoded — it is also the capability flag — but it is clamped by this, for
 * the same reason `IMPORT_BATCH_HARD_MAX` clamps `limits.batchMax`: a server
 * that advertised 100,000 would otherwise have us build a request body no
 * amount of retrying recovers from. This is the cross-repo pin's local anchor
 * (DEBT-518).
 */
export const LOOKUP_PAGE_MAX = 1000;

/**
 * Canonical wire form of an `import_key`: padded base64 of exactly 16 bytes,
 * standard alphabet, two `=`.
 *
 * The same shape the backend's `IMPORT_KEY_B64_RE` accepts. It is re-checked
 * here rather than trusted from `importKeyToWire` because the SERVER FAILS THE
 * WHOLE REQUEST on any entry that does not parse: one 15-byte row written by
 * some future bug would otherwise void every page it landed in, and with it
 * the whole pre-check. Dropping it locally costs that one post a re-upload.
 */
const CANONICAL_IMPORT_KEY_WIRE = /^[A-Za-z0-9+/]{22}==$/;

// ---------------------------------------------------------------------------
// Step 1: page the pending keys
// ---------------------------------------------------------------------------

/** One row of a lookup page, after encoding. */
export interface LookupPageRow {
  readonly itemId: string;
  /** Parse order. The runner's key into its per-item byte map. */
  readonly ordinal: number;
  /** Canonical padded base64 of the 16-byte key. */
  readonly importKeyWire: string;
}

export interface LookupPage {
  /** The rows that may be SENT: encoded, canonical, in parse order. */
  readonly rows: readonly LookupPageRow[];
  /**
   * The highest `ordinal` READ — kept or dropped — and so the cursor for the
   * next call. Taken from the rows read rather than from the rows kept: a
   * dropped key must not be read again on the next page, or a single bad row
   * would page forever.
   */
  readonly lastOrdinal: number;
  /**
   * How many rows the query returned, before the canonical check.
   *
   * The runner's TERMINATION signal, and it has to be this rather than
   * `rows.length`: a page whose every key was dropped still has more pages
   * behind it. Zero means the pending queue is drained.
   */
  readonly scanned: number;
}

/**
 * Read and encode the next page of pending keys, strictly after
 * `afterOrdinal`.
 *
 * Start at `-1`, then pass the previous page's {@link LookupPage.lastOrdinal}.
 * `pageSize` is the caller's `min(limits.lookupMax, LOOKUP_PAGE_MAX)`.
 *
 * A key that does not encode — `importKeyToWire` throws on anything that is
 * not 16 bytes — or that fails {@link CANONICAL_IMPORT_KEY_WIRE} is dropped
 * from the page and nothing else: see the note on that regex.
 */
export function nextLookupPage(jobId: string, afterOrdinal: number, pageSize: number): LookupPage {
  const read = getPendingImportKeyPage(jobId, afterOrdinal, Math.min(pageSize, LOOKUP_PAGE_MAX));
  const rows: LookupPageRow[] = [];
  let lastOrdinal = afterOrdinal;

  for (const row of read) {
    if (row.ordinal > lastOrdinal) lastOrdinal = row.ordinal;
    let wire: string;
    try {
      wire = importKeyToWire(row.import_key);
    } catch {
      // A key this client cannot encode is a key the server would refuse the
      // whole request over. No message is built from it: the bytes are
      // content-derived.
      continue;
    }
    if (!CANONICAL_IMPORT_KEY_WIRE.test(wire)) continue;
    rows.push({ itemId: row.id, ordinal: row.ordinal, importKeyWire: wire });
  }

  return { rows, lastOrdinal, scanned: read.length };
}

// ---------------------------------------------------------------------------
// Step 2: apply the answer
// ---------------------------------------------------------------------------

/**
 * Move this page's matches to `present`, and report the rows that moved.
 *
 * Every part of the response is treated as untrusted shape:
 *
 *  - a non-array `existing` (an old server, a proxy's error page parsed as
 *    JSON) applies nothing — `Array.isArray`, because the TypeScript type is
 *    erased at runtime and `response.existing.filter` on a string would throw
 *    a `TypeError` into the parse;
 *  - non-string entries are ignored;
 *  - an entry that is not in THIS page is ignored. That is the real control:
 *    the server is not trusted to name which local rows to mutate, so a key
 *    the page never sent — from another page, another job, or invented — can
 *    never move a row.
 *
 * The returned rows carry their `ordinal`, which is what lets the caller
 * subtract each moved post's exact byte contribution from the estimate. They
 * come back in PAGE order, not response order: the response's order is
 * unspecified by the route, and the rows this writes must not depend on it.
 */
export function applyLookupResponse(
  jobId: string,
  page: LookupPage,
  response: ImportLookupResponse,
): readonly LookupPageRow[] {
  const existing: unknown = response?.existing;
  if (!Array.isArray(existing)) return [];

  const matchedKeys = new Set<string>();
  for (const entry of existing) {
    if (typeof entry === 'string') matchedKeys.add(entry);
  }

  // Driven from the PAGE, not from the response, which is what makes the two
  // filters structural rather than remembered: a key the page never sent is
  // simply not here to match, and a key echoed twice is one row.
  const matched = page.rows.filter((row) => matchedKeys.has(row.importKeyWire));
  if (matched.length === 0) return [];

  const movedIds = new Set(
    markImportItemsPresent(
      jobId,
      matched.map((row) => row.itemId),
    ),
  );
  // Only the rows SQL actually moved: a row requeued or wiped between the page
  // read and here stays in the queue, and crediting its bytes back would
  // under-declare the import.
  return matched.filter((row) => movedIds.has(row.itemId));
}
