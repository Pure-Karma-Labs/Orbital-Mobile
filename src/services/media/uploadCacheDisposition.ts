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
 * - `attached`  — they are on a post now. Drop the cache, roll back nothing.
 * - `discard`   — nothing will ever attach them. Drop the cache AND roll the
 *                 ids back, so they do not become FileLibrary ghosts.
 * - `may-be-attached` — a create failed in a way that may still have committed
 *                 server-side. KEEP the cache (a re-press must reuse the ids,
 *                 not upload duplicates) and mark it, so a later `discard`
 *                 does not delete media that is actually on a post.
 */
export type UploadCacheDisposition = 'attached' | 'discard' | 'may-be-attached';

/**
 * Could this create-stage failure have committed server-side?
 *
 * Only meaningful for the CREATE stage (thread-create / reply-create) — a
 * media-upload-stage failure never reached the create call at all, so its ids
 * are unambiguously unattached.
 *
 * instanceof order is load-bearing: ConflictError, NetworkError and ServerError
 * all extend ApiError, so the subclasses must be tested first.
 */
export function mayHaveCommitted(e: unknown): boolean {
  // 409: the backend maps every unique-key violation to this, and a create
  // carrying already-attached media ids is near-proof the previous call landed.
  if (e instanceof ConflictError) return true;
  // Fetch-level failure or timeout: the request may have been fully processed
  // and only its response lost.
  if (e instanceof NetworkError) return true;
  // 5xx: the write can have committed before the handler failed.
  if (e instanceof ServerError) return true;
  // Every other API error was rejected BEFORE any write — ValidationError
  // (400/422), AuthError (401/403), NotFoundError (404), QuotaExceededError.
  if (e instanceof ApiError) return false;
  // Not an API failure at all (local crypto, DB, cancellation): never reached
  // the server.
  return false;
}
