/**
 * Shared vocabulary for releasing the composer's upload reuse cache (#724b).
 *
 * Both composers (ComposeThreadScreen and ThreadDetailScreen) have to make the
 * same call after the same failures, so the type AND the classifier live here
 * rather than being re-derived per screen.
 */

import { ApiError, ConflictError, NetworkError, ServerError } from '../api/errors';

/**
 * What should happen to the ids the reuse cache is holding.
 *
 * | disposition | cache | hasUnsentUpload | rollback |
 * |---|---|---|---|
 * | `attached` | dropped | false | none |
 * | `discard` | dropped | false | yes, unless the entry is flagged |
 * | `committed` | KEPT + flagged | false | none |
 * | `maybe-committed` | KEPT + flagged | left as it was (stays true) | none |
 *
 * - `attached` — they are on a post now. Drop the cache, roll back nothing.
 * - `discard` — nothing will ever attach them. Drop the cache AND roll the ids
 *   back, so they do not become FileLibrary ghosts.
 * - `committed` — a 409: the post almost certainly exists and carries this
 *   media. Keep the cache (a re-press must draw another 409 rather than upload
 *   duplicates), flag it so a later discard does not delete attached media, and
 *   clear `hasUnsentUpload` — there is nothing left to warn the user about.
 * - `maybe-committed` — a network or 5xx failure: the create MIGHT have
 *   committed. Same cache treatment as `committed`, but `hasUnsentUpload` is
 *   left alone, so leaving the screen still prompts "Discard unsent …?". The
 *   user genuinely may be holding media that nothing has attached (Alex's
 *   decision, PR #840 review).
 */
export type UploadCacheDisposition =
  | 'attached'
  | 'discard'
  | 'committed'
  | 'maybe-committed';

/**
 * How likely is it that this create-stage failure committed server-side?
 *
 * - `committed` — near-certain (409).
 * - `maybe` — genuinely unknown (network failure/timeout, 5xx).
 * - `no` — the write provably never happened.
 *
 * Only meaningful for the CREATE stage (thread-create / reply-create): a
 * media-upload-stage failure never reached the create call at all, so its ids
 * are unambiguously unattached.
 *
 * instanceof order is load-bearing: ConflictError, NetworkError and ServerError
 * all extend ApiError, so the subclasses must be tested first.
 */
export type CreateFailureVerdict = 'committed' | 'maybe' | 'no';

export function classifyCreateFailure(e: unknown): CreateFailureVerdict {
  // 409: the backend maps every unique-key violation to this, and a create
  // carrying already-attached media ids is near-proof the previous call landed.
  if (e instanceof ConflictError) return 'committed';
  if (e instanceof NetworkError) {
    // The rate-limit backoff abort is the one NetworkError that cannot have
    // written anything: the 429 before it was a rejection, and the retry was
    // never issued. Everything else — a fetch that threw on abort, a timeout —
    // may have been processed with only its response lost.
    return e.neverSent ? 'no' : 'maybe';
  }
  // 5xx: the write can have committed before the handler failed.
  if (e instanceof ServerError) return 'maybe';
  // Every other API error was rejected BEFORE any write — ValidationError
  // (400/422), AuthError (401/403), NotFoundError (404), QuotaExceededError.
  if (e instanceof ApiError) return 'no';
  // Not an API failure at all (local crypto, DB, cancellation): never reached
  // the server.
  return 'no';
}

/**
 * The cache disposition a create-stage verdict implies, or null when the
 * failure needs no release call at all (the cache stays untouched and
 * rollback-eligible).
 */
export function dispositionForCreateFailure(
  verdict: CreateFailureVerdict,
): UploadCacheDisposition | null {
  if (verdict === 'committed') return 'committed';
  if (verdict === 'maybe') return 'maybe-committed';
  return null;
}
