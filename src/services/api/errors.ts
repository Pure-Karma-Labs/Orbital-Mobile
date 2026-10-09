/**
 * Typed error hierarchy for the Orbital API client.
 *
 * ApiError.message is always user-friendly — it is safe to display.
 * ApiError.serverMessage holds the raw server response string, only populated
 * in __DEV__ mode to prevent leaking server internals to production.
 *
 * Where a 4xx carries a machine-readable reason, this layer turns that reason
 * into curated client copy rather than echoing the server's text: see
 * `VALIDATION_REASON_MESSAGES` below (Mobile #783). The rule is the same for
 * every subclass — server *codes* may select a message, server *strings* never
 * become one, so un-gating `serverMessage` is never the fix for "the UI shows
 * the wrong error".
 */

import type { QuotaUsage } from '../../types/api';
import { formatMB } from '../../utils/formatBytes';
import { INVALID_EMAIL_MESSAGE } from '../../utils/validateEmail';

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly isRetryable: boolean;
  /** Raw server response body — only set in __DEV__, undefined in production. */
  readonly serverMessage: string | undefined;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    isRetryable: boolean,
    serverMessage?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.isRetryable = isRetryable;
    this.serverMessage = __DEV__ ? serverMessage : undefined;
    // Maintain proper prototype chain in transpiled ES5
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Wraps fetch-level failures (no response received) and request timeouts. Retryable. */
export class NetworkError extends ApiError {
  /**
   * True only when the request PROVABLY never left the device, so it cannot
   * have committed anything server-side.
   *
   * Set exclusively by the rate-limit backoff abort in `client.ts`: there, the
   * previous attempt was rejected with a 429 (so it wrote nothing) and the
   * retry was abandoned before it was issued. Every other NetworkError is
   * ambiguous by construction — a fetch that throws on abort or timeout may
   * have been fully processed with only its response lost — so this stays
   * false there.
   *
   * A flag, not a subclass, deliberately: `instanceof NetworkError`, `.name`
   * and `.code` are load-bearing for retry logic and Sentry tags, and none of
   * them should shift for this distinction.
   *
   * Consumer: `media/uploadCacheDisposition.classifyCreateFailure` — a
   * never-sent failure must not flag uploaded media as "may be attached".
   */
  readonly neverSent: boolean;

  constructor(serverMessage?: string, neverSent = false) {
    super(
      'Network error — please check your connection',
      0,
      'NETWORK_ERROR',
      true,
      serverMessage,
    );
    this.name = 'NetworkError';
    this.neverSent = neverSent;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** HTTP 401 or 403 — credentials invalid or insufficient. Not retryable; triggers re-auth. */
export class AuthError extends ApiError {
  constructor(statusCode: 401 | 403, serverMessage?: string) {
    super(
      'Authentication required',
      statusCode,
      'AUTH_ERROR',
      false,
      serverMessage,
    );
    this.name = 'AuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// 400/422 VALIDATION_ERROR — curated copy for allowlisted backend reasons
// ---------------------------------------------------------------------------

/**
 * The single list of validation reasons this client is willing to show a user,
 * and the exact copy it shows for each.
 *
 * The keys mirror `VALIDATION_CODES` in `Orbital-Backend/src/middleware/errorHandler.js`,
 * which is append-only and never renamed — that object, delivered as
 * `details.code`, is the contract. The backend's `message` text is NOT a
 * contract and is never displayed: it stays in the `__DEV__`-only
 * `serverMessage`. A code that is missing, unknown, non-string or a prototype
 * key falls back to the generic 'Invalid request', so an older backend, a
 * newer backend and a malformed body are all safe.
 *
 * Module-private on purpose: screens route on `ValidationError.reason` and
 * render `e.message`. Nothing outside this file indexes the map, so the copy
 * for a reason cannot be forked per screen.
 */
const VALIDATION_REASON_MESSAGES = Object.freeze({
  INVITE_INVALID: 'This invite code is not valid — check it and try again',
  INVITE_USED: 'This invite code has already been used — ask for a new invite',
  INVITE_CANCELLED: 'This invite code has been cancelled — ask for a new invite',
  INVITE_EXPIRED: 'This invite code has expired — ask for a new invite',
  INVITE_EMAIL_MISMATCH:
    'This invite code was sent to a different email address — sign up with that address',
  EMAIL_FORMAT: INVALID_EMAIL_MESSAGE,
  // Named by the orbit-join route (Backend #271). No member count in the copy:
  // `max_members` is per-group, so any number here would be a guess.
  GROUP_FULL: 'This orbit is full — ask the orbit admin to make room',
});

/** Derived from the map, so adding a reason cannot forget the copy. */
export type ValidationReason = keyof typeof VALIDATION_REASON_MESSAGES;

/**
 * Allowlist membership test for a parsed `details.code`.
 *
 * `hasOwnProperty.call` rather than `in` or a truthy lookup: the latter two
 * would accept `__proto__`, `constructor` and `toString` and then index the
 * map with them. The `typeof` guard keeps numbers, arrays and objects out
 * before the lookup.
 */
function isValidationReason(c: unknown): c is ValidationReason {
  return (
    typeof c === 'string' &&
    Object.prototype.hasOwnProperty.call(VALIDATION_REASON_MESSAGES, c)
  );
}

/**
 * Extract an allowlisted reason from a 400/422 body, or undefined.
 *
 * Top-level rather than a method so the parse is testable and so the
 * `ValidationError` constructor itself holds no body parsing — the invariant
 * check forbids `JSON.parse(` inside the class for exactly that reason.
 */
function parseValidationReason(rawBody?: string): ValidationReason | undefined {
  if (!rawBody) return undefined;
  try {
    const parsed = JSON.parse(rawBody);
    const code: unknown = parsed?.details?.code;
    if (isValidationReason(code)) return code;
  } catch {
    // Malformed body — fall through to the generic message
  }
  return undefined;
}

/** HTTP 400 or 422 — malformed request or failed validation. Not retryable. */
export class ValidationError extends ApiError {
  /**
   * The allowlisted backend reason, or undefined when the body carried none.
   *
   * Retained in release builds (unlike `serverMessage`) because it is one of a
   * fixed set of client-defined enum values, not server text. Screens branch on
   * this to pick a channel — a field error vs the banner — and render
   * `e.message` for the words.
   */
  readonly reason: ValidationReason | undefined;

  constructor(statusCode: 400 | 422, rawBody?: string) {
    const reason = parseValidationReason(rawBody);
    super(
      reason === undefined ? 'Invalid request' : VALIDATION_REASON_MESSAGES[reason],
      statusCode,
      'VALIDATION_ERROR',
      false,
      rawBody,
    );
    this.name = 'ValidationError';
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** HTTP 5xx — server-side error. Retryable. */
export class ServerError extends ApiError {
  constructor(statusCode: number, serverMessage?: string) {
    super(
      'Server error — please try again',
      statusCode,
      'SERVER_ERROR',
      true,
      serverMessage,
    );
    this.name = 'ServerError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** HTTP 404 — resource does not exist. Not retryable. */
export class NotFoundError extends ApiError {
  constructor(serverMessage?: string) {
    super('Not found', 404, 'NOT_FOUND', false, serverMessage);
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Client-side account-switch refusal.
 *
 * Thrown when a login or signup attempt targets a different user than the one
 * whose encrypted data resides on this device. This is NOT an HTTP error — it
 * is raised before any tokens or state are persisted, so rolling back is a
 * no-op. The user must either log in with the original account or delete that
 * account (which triggers fullCryptoWipe) to reclaim the device.
 */
export class AccountSwitchError extends Error {
  constructor() {
    super(
      'This device holds encrypted data for another account. ' +
      'Log in with that account, or delete the account to reset this device.',
    );
    this.name = 'AccountSwitchError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * HTTP 409 — conflict. The request cannot be completed due to a conflict
 * with the current state of the resource.
 *
 * For account deletion, the backend returns blocking_orbits in the response body
 * that prevent deletion. This field is prod-retained (not __DEV__-gated) because
 * it contains only the user's own orbit ids + encrypted names, not server internals.
 */
export interface BlockingOrbit {
  id: string;
  encryptedName: string;
}

export class ConflictError extends ApiError {
  /** Orbits blocking account deletion — always available (prod-retained). */
  readonly blockingOrbits: BlockingOrbit[];

  constructor(rawBody?: string) {
    super('Conflict — action cannot be completed', 409, 'CONFLICT', false, rawBody);
    this.name = 'ConflictError';

    // Parse blocking_orbits from the raw 409 response body (snake_case from server)
    let orbits: BlockingOrbit[] = [];
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody);
        const raw = parsed?.details?.blocking_orbits;
        if (Array.isArray(raw)) {
          orbits = raw.map((o: Record<string, unknown>) => ({
            id: typeof o.id === 'string' ? o.id : '',
            encryptedName: typeof o.encrypted_name === 'string' ? o.encrypted_name : '',
          }));
        }
      } catch {
        // Parse failure — default to empty array
      }
    }
    this.blockingOrbits = orbits;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// 413 QUOTA_EXCEEDED — orbit storage quota denial
// ---------------------------------------------------------------------------

/** Parse the quota object from a 413 response body (snake_case from server). */
function parseQuota(rawBody?: string): QuotaUsage | undefined {
  if (!rawBody) return undefined;
  try {
    const parsed = JSON.parse(rawBody);
    const q = parsed?.details?.quota;
    if (
      q &&
      typeof q.storage_bytes === 'number' &&
      typeof q.max_bytes === 'number' &&
      typeof q.file_count === 'number' &&
      typeof q.max_files === 'number' &&
      typeof q.storage_percent === 'number' &&
      typeof q.files_percent === 'number' &&
      typeof q.evictable_bytes === 'number'
    ) {
      return {
        storageBytes: q.storage_bytes,
        maxBytes: q.max_bytes,
        fileCount: q.file_count,
        maxFiles: q.max_files,
        storagePercent: q.storage_percent,
        filesPercent: q.files_percent,
        evictableBytes: q.evictable_bytes,
      };
    }
  } catch {
    // Parse failure — fall through to undefined
  }
  return undefined;
}

/** Build a user-facing quota message from parsed quota data. */
function quotaMessage(quota: QuotaUsage | undefined): string {
  if (quota && quota.evictableBytes > 0) {
    return `Orbit storage is full. About ${formatMB(quota.evictableBytes)} will free up automatically as members archive older threads — try again later.`;
  }
  if (quota) {
    // <= 0: nothing evictable (negative would be a server bug — treat as zero)
    return 'Orbit storage is full. Delete old photos or videos to make room.';
  }
  return 'Upload too large or storage is full.';
}

/**
 * HTTP 413 — quota exceeded on upload routes.
 *
 * The quota field is prod-retained (not __DEV__-gated) because it contains
 * only the user's own usage numbers, not server internals.
 */
export class QuotaExceededError extends ApiError {
  /** Parsed quota usage from the 413 response — always available (prod-retained). */
  readonly quota: QuotaUsage | undefined;

  constructor(rawBody?: string) {
    const quota = parseQuota(rawBody);
    super(quotaMessage(quota), 413, 'QUOTA_EXCEEDED', false, rawBody);
    this.name = 'QuotaExceededError';
    this.quota = quota;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
