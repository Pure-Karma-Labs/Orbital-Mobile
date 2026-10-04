/**
 * Epoch-unit helpers for SQLite timestamp columns (#821, #844).
 *
 * There is NO global timestamp unit in this schema. Per table:
 *   orbital_threads   epoch ms (#844; pre-#844 rows hold seconds — read via toMillis)
 *   orbital_replies   epoch ms (#821; pre-#821 rows hold seconds — read via toMillis)
 *   orbital_media     epoch ms (every writer stamps Date.now(); the orphan-thumbnail
 *                     reaper compares created_at against a Date.now() offset)
 *   conversations     epoch ms (sole writer conversationRepository stamps Date.now())
 *   signal_* / items  epoch seconds (Math.floor(Date.now() / 1000)) — do NOT
 *                     apply toMillis or the Math.floor(ms) write idiom to the
 *                     Signal key stores (signal_signed_pre_keys, signal_pre_keys,
 *                     signal_kyber_pre_keys, signal_identity_keys.first_use);
 *                     their created_at is the only record of key age.
 * The owning repository module is authoritative for its table.
 *
 * Legacy seconds rows in orbital_threads/orbital_replies were never migrated
 * and persist indefinitely (only the threads the server returns in its default
 * page are rewritten). The toMillis guard is therefore permanent and cheap —
 * it is not tech debt to be removed later.
 *
 * Only the READ side is normalised. Writers bind Math.floor(ms) directly and
 * do not guard non-finite input (a malformed server date yields NaN into a
 * NOT NULL column) — pre-existing behaviour, unchanged by #844.
 */

/**
 * Epoch seconds and epoch milliseconds are distinguishable for any date this
 * app will ever see: 1e11 seconds is the year 5138, and 1e11 ms is 1973.
 * Any value below the ceiling is a legacy second-precision row.
 */
export const SECONDS_CEILING = 1e11;

/** Normalise a stored epoch value (seconds or ms) to epoch ms. Non-finite → 0. */
export function toMillis(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value < SECONDS_CEILING ? value * 1000 : value;
}
