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

import type { ImportAllowance, QuotaUsage } from '../../types/api';
import { formatMB } from '../../utils/formatBytes';
import { INVALID_EMAIL_MESSAGE } from '../../utils/validateEmail';
// The refusal vocabulary is defined in crypto/groupKeyErrors.ts — an
// import-free, side-effect-free module — because the wire parser here and the
// telemetry tag there must share one list, and that module is the only one
// both the crypto boundary and this layer may import. See its JSDoc.
import { REWRAP_REFUSAL_CODES, type RewrapRefusalCode } from '../crypto/groupKeyErrors';

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
  // Raised only when a composer attaches a media row that belongs to an import
  // (Backend `src/routes/threads.js`). Import media writes no local row, so
  // the picker cannot offer one — this is a fence, not a user path, and the
  // copy stays neutral rather than explaining imports to someone who was not
  // doing one.
  MEDIA_IMPORT_RESERVED: "Those photos can't be attached — select them again",
});

/**
 * Reasons the client carries but deliberately shows NO copy for (#926).
 *
 * These are service-layer outcomes of the Meta-import runner: it routes on
 * them (halve the batch, fail the file, stop the run as a client bug) and the
 * member never sees them as words. Keeping them out of
 * {@link VALIDATION_REASON_MESSAGES} is what stops every screen that routes
 * validation reasons from having to invent copy for a code it can never
 * receive — such a reason falls back to the generic 'Invalid request', which
 * is honest, rather than to fake copy.
 *
 * `IMPORT_ITEM_INVALID` / `IMPORT_DATE_INVALID` / `IMPORT_MEDIA_NOT_OWNED`
 * are in NEITHER registry on purpose: they are per-item codes inside a 200,
 * so they never reach a ValidationError at all.
 */
const SILENT_VALIDATION_REASONS = Object.freeze({
  IMPORT_BATCH_TOO_LARGE: 1,
  IMPORT_DECLARED_INVALID: 1,
  IMPORT_MEDIA_TYPE_UNSUPPORTED: 1,
});

/**
 * A reason with curated copy. Screens route an exhaustive `Record` over THIS
 * type, so adding a silent reason does not tax every form in the app.
 */
export type CopiedValidationReason = keyof typeof VALIDATION_REASON_MESSAGES;

/** Every reason this client is willing to retain on a ValidationError. */
export type ValidationReason = CopiedValidationReason | keyof typeof SILENT_VALIDATION_REASONS;

/**
 * Allowlist membership test for a parsed `details.code`, across BOTH
 * registries.
 *
 * `hasOwnProperty.call` rather than `in` or a truthy lookup: the latter two
 * would accept `__proto__`, `constructor` and `toString` and then index the
 * map with them. The `typeof` guard keeps numbers, arrays and objects out
 * before the lookup.
 */
function isValidationReason(c: unknown): c is ValidationReason {
  return (
    typeof c === 'string' &&
    (Object.prototype.hasOwnProperty.call(VALIDATION_REASON_MESSAGES, c) ||
      Object.prototype.hasOwnProperty.call(SILENT_VALIDATION_REASONS, c))
  );
}

/**
 * Does this allowlisted reason have copy, or is it a silent one?
 *
 * Exported because screens route an exhaustive `Record<CopiedValidationReason,
 * …>` and `ValidationError.reason` is the WIDE type: without this they each
 * grow their own copy of the same `hasOwnProperty.call` predicate, and a
 * screen-local copy can drift from the registry it is narrowing against.
 */
export function isCopiedValidationReason(c: ValidationReason): c is CopiedValidationReason {
  return Object.prototype.hasOwnProperty.call(VALIDATION_REASON_MESSAGES, c);
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
   *
   * A SILENT reason (see {@link SILENT_VALIDATION_REASONS}) is retained here
   * just the same, but `message` stays the generic 'Invalid request': the
   * service layer routes on the code and nobody renders it.
   */
  readonly reason: ValidationReason | undefined;

  constructor(statusCode: 400 | 422, rawBody?: string) {
    const reason = parseValidationReason(rawBody);
    super(
      reason !== undefined && isCopiedValidationReason(reason)
        ? VALIDATION_REASON_MESSAGES[reason]
        : 'Invalid request',
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
 * Client-side blocked-recipient refusal (#908).
 *
 * Thrown before any encryption or HTTP call when the user tries to send into a
 * DM whose peer they have blocked. Like {@link AccountSwitchError} this is NOT
 * an HTTP error — it is raised ahead of every side effect (no group key is
 * wrapped, no optimistic row is added, nothing is uploaded), so there is
 * nothing to roll back.
 *
 * The message is a constant, user-safe string: `recipientId` is carried as a
 * field so screens can key off it without an id ever reaching an error string,
 * a log line or Sentry (the blocked catch branches deliberately skip capture).
 *
 * SCREENS MUST MATCH ON `err.name === 'BlockedRecipientError'`, never on
 * `instanceof`: about a dozen suites replace service modules with a factory
 * mock, where this class can be undefined.
 */
export class BlockedRecipientError extends Error {
  /** The blocked peer. Never interpolated into the message or logged. */
  readonly recipientId: string;

  constructor(recipientId: string) {
    super('You blocked this person.');
    this.name = 'BlockedRecipientError';
    this.recipientId = recipientId;
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

/**
 * Allowlist membership test for a 409 `details.code`.
 *
 * `hasOwnProperty.call` rather than `in` or a truthy lookup, for the same
 * reason as {@link isValidationReason}: the latter two accept `__proto__`,
 * `constructor` and `toString`.
 */
function isRewrapRefusalCode(c: unknown): c is RewrapRefusalCode {
  return typeof c === 'string' && Object.prototype.hasOwnProperty.call(REWRAP_REFUSAL_CODES, c);
}

// ---------------------------------------------------------------------------
// 409 IMPORT_REFUSED — the Meta-import refusal vocabulary (#926)
// ---------------------------------------------------------------------------

/**
 * The four refusal codes the import routes emit, and the session statuses
 * `IMPORT_CLOSED` can report.
 *
 * Here rather than in an import-free module (as `REWRAP_REFUSAL_CODES` is,
 * because the crypto boundary needs that list too): the import runner switches
 * on the two code LITERALS it acts on, which the exported type union gives it,
 * and nothing outside this file needs the maps.
 */
const IMPORT_REFUSAL_CODES = Object.freeze({
  IMPORT_IN_PROGRESS: 1,
  IMPORT_ALLOWANCE_EXCEEDED: 1,
  IMPORT_QUOTA_EXCEEDED: 1,
  IMPORT_CLOSED: 1,
});

/**
 * Every value `IMPORT_CLOSED`'s `details.status` can carry — i.e. the whole
 * `import_sessions.status` column, not just the three terminal ones. `open`
 * is here because the column allows it: if the backend ever reports a session
 * it considers closed while the row still reads `open`, that is a server bug
 * the client should surface as itself rather than flatten into
 * `'unrecognized'`, which the runner reads as "a status this build does not
 * know".
 */
const IMPORT_CLOSED_STATUSES = Object.freeze({
  open: 1,
  closed: 1,
  abandoned: 1,
  completed: 1,
});

/** A known refusal code, or the client's own sentinel for a newer backend. */
export type ImportRefusalCode = keyof typeof IMPORT_REFUSAL_CODES | 'unrecognized';

/**
 * The parsed `details` of an `IMPORT_REFUSED` 409.
 *
 * Every field is prod-retained, like `blockingOrbits` and `refusalCode`:
 * client-defined enums plus the member's own numbers. No server string is
 * carried, and `importId` is accepted only on a canonical lowercase UUIDv4
 * shape and never logged.
 *
 * Which extras arrive depends on the code and the route:
 *  - `IMPORT_IN_PROGRESS` → `importId` (absent on the 23505 insert race)
 *  - `IMPORT_ALLOWANCE_EXCEEDED` → `allowance`, plus `stagedBytes` /
 *    `projectedBytes` on the media CHUNK route only
 *  - `IMPORT_QUOTA_EXCEEDED` → `availableBytes` + `declaredBytes` at start,
 *    `availableBytes` + `sizeBytes` at media complete
 *  - `IMPORT_CLOSED` → `closedStatus`
 */
export interface ImportRefusal {
  readonly code: ImportRefusalCode;
  readonly closedStatus?: keyof typeof IMPORT_CLOSED_STATUSES | 'unrecognized';
  readonly importId?: string;
  readonly allowance?: ImportAllowance;
  readonly stagedBytes?: number;
  readonly projectedBytes?: number;
  readonly availableBytes?: number;
  readonly declaredBytes?: number;
  readonly sizeBytes?: number;
}

/**
 * Allowlist membership test for an import refusal code — `hasOwnProperty.call`
 * for the same reason as {@link isValidationReason}.
 */
function isImportRefusalCode(c: unknown): c is keyof typeof IMPORT_REFUSAL_CODES {
  return typeof c === 'string' && Object.prototype.hasOwnProperty.call(IMPORT_REFUSAL_CODES, c);
}

/** Allowlist membership test for the `IMPORT_CLOSED` session status. */
function isImportClosedStatus(s: unknown): s is keyof typeof IMPORT_CLOSED_STATUSES {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(IMPORT_CLOSED_STATUSES, s);
}

/** The canonical lowercase UUIDv4 the server issues for an import id. */
const IMPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A JSON number we are willing to carry: finite, never NaN or ±Infinity. */
function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * The allowance object, or undefined unless ALL FOUR keys are numbers.
 *
 * All-or-nothing deliberately: the runner computes "remaining" from the pair
 * of a used and a limit value, and a half-populated allowance would make a
 * missing limit read as 0 remaining.
 */
function parseImportAllowance(a: unknown): ImportAllowance | undefined {
  if (a === null || typeof a !== 'object') return undefined;
  const r = a as Record<string, unknown>;
  const postsUsed = finiteNumber(r.posts_used);
  const bytesUsed = finiteNumber(r.bytes_used);
  const postsLimit = finiteNumber(r.posts_limit);
  const bytesLimit = finiteNumber(r.bytes_limit);
  if (
    postsUsed === undefined ||
    bytesUsed === undefined ||
    postsLimit === undefined ||
    bytesLimit === undefined
  ) {
    return undefined;
  }
  return { postsUsed, bytesUsed, postsLimit, bytesLimit };
}

/**
 * Extract the refusal from an `IMPORT_REFUSED` 409 body, or undefined.
 *
 * A second parser beside {@link parseRefusalCode} rather than one widened
 * parser: each early-returns on the wrong top-level `error`, so the two are
 * mutually exclusive, independently testable, and neither can start carrying
 * the other's fields by accident.
 *
 * - A known code → that code plus whatever `details` it legitimately carries.
 * - A present but unknown code (or closed status) → `'unrecognized'`, so a
 *   newer backend is visible as "refused for a reason this build doesn't
 *   know". The server's own strings never escape this function.
 * - No code at all → `undefined`, matching `parseRefusalCode`.
 */
function parseImportRefusal(rawBody?: string): ImportRefusal | undefined {
  if (!rawBody) return undefined;
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed?.error !== 'IMPORT_REFUSED') return undefined;
    const details: Record<string, unknown> | undefined =
      parsed?.details !== null && typeof parsed?.details === 'object' ? parsed.details : undefined;
    const rawCode: unknown = details?.code;
    if (rawCode === undefined || rawCode === null) return undefined;

    const code: ImportRefusalCode = isImportRefusalCode(rawCode) ? rawCode : 'unrecognized';
    const refusal: {
      -readonly [K in keyof ImportRefusal]: ImportRefusal[K];
    } = { code };

    if (code === 'IMPORT_CLOSED' && details?.status !== undefined) {
      refusal.closedStatus = isImportClosedStatus(details.status) ? details.status : 'unrecognized';
    }

    const importId = details?.import_id;
    if (typeof importId === 'string' && IMPORT_ID_RE.test(importId)) {
      refusal.importId = importId;
    }

    const allowance = parseImportAllowance(details?.allowance);
    if (allowance !== undefined) refusal.allowance = allowance;

    const stagedBytes = finiteNumber(details?.staged_bytes);
    if (stagedBytes !== undefined) refusal.stagedBytes = stagedBytes;
    const projectedBytes = finiteNumber(details?.projected_bytes);
    if (projectedBytes !== undefined) refusal.projectedBytes = projectedBytes;
    const availableBytes = finiteNumber(details?.available_bytes);
    if (availableBytes !== undefined) refusal.availableBytes = availableBytes;
    const declaredBytes = finiteNumber(details?.declared_bytes);
    if (declaredBytes !== undefined) refusal.declaredBytes = declaredBytes;
    const sizeBytes = finiteNumber(details?.size_bytes);
    if (sizeBytes !== undefined) refusal.sizeBytes = sizeBytes;

    return refusal;
  } catch {
    // Malformed body — indistinguishable from a 409 with no details.
    return undefined;
  }
}

/**
 * Extract the refusal code from a 409 body.
 *
 * - A known code → that code.
 * - A present but unknown code → `'unrecognized'`, so a newer backend is
 *   visible as "refused for a reason this build doesn't know" instead of
 *   silently looking like a generic conflict. The server's own string never
 *   escapes this function.
 * - No code at all (every other 409 route: account deletion, duplicate DM) →
 *   `undefined`.
 *
 * Top-level rather than a method, matching `parseValidationReason`: the parse
 * stays testable and the class body stays free of routing logic.
 */
function parseRefusalCode(rawBody?: string): RewrapRefusalCode | undefined {
  if (!rawBody) return undefined;
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed?.error !== 'REWRAP_REFUSED') return undefined;
    const code: unknown = parsed?.details?.code;
    if (code === undefined || code === null) return undefined;
    return isRewrapRefusalCode(code) ? code : 'unrecognized';
  } catch {
    // Malformed body — indistinguishable from a 409 with no details.
    return undefined;
  }
}

export class ConflictError extends ApiError {
  /** Orbits blocking account deletion — always available (prod-retained). */
  readonly blockingOrbits: BlockingOrbit[];

  /**
   * The allowlisted `details.code` of a `REWRAP_REFUSED` 409, or undefined on
   * any other 409 (#912).
   *
   * Prod-retained, like `ValidationError.reason` and `blockingOrbits`: it is
   * one of a fixed set of client-known enum values, not server text. Without
   * it the refusal vocabulary would be invisible in release builds — the
   * self-heal state machine routes on it (`IDENTITY_MISMATCH` and friends mean
   * "this device's key", everything else means "ask a peer") and it is the
   * `group_key_refusal` Sentry tag.
   */
  readonly refusalCode: RewrapRefusalCode | undefined;

  /**
   * The parsed `details` of an `IMPORT_REFUSED` 409, or undefined on any other
   * 409 (#926).
   *
   * Prod-retained for the same reason as {@link ConflictError.refusalCode}:
   * the import runner's whole disposition table routes on it (resume that
   * session / refuse the archive / park and retry / restart the session), and
   * the member's own allowance numbers are what #928 puts on screen.
   */
  readonly importRefusal: ImportRefusal | undefined;

  constructor(rawBody?: string) {
    super('Conflict — action cannot be completed', 409, 'CONFLICT', false, rawBody);
    this.name = 'ConflictError';
    this.refusalCode = parseRefusalCode(rawBody);
    this.importRefusal = parseImportRefusal(rawBody);

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

// ---------------------------------------------------------------------------
// 429 RATE_LIMITED — the server's own Retry-After (#926)
// ---------------------------------------------------------------------------

/**
 * The one thing this layer needs from a response's headers.
 *
 * Structural on purpose: `Headers` satisfies it, a test satisfies it with
 * `{ get: () => '5' }`, and no DOM lib type enters this module. The RNFS
 * download transport has no headers to pass and passes none — a 429 there
 * simply carries no `retryAfterMs`, which is the honest answer rather than an
 * invented default.
 */
export interface HeaderReader {
  get(name: string): string | null;
}

/** Never wait longer than 15 minutes on a server's say-so. */
const MAX_RETRY_AFTER_MS = 900_000;

/**
 * Milliseconds to wait before retrying, from `Retry-After`, or undefined.
 *
 * Delta-seconds only. RFC 9110 also allows an HTTP-date, which we deliberately
 * do NOT interpret: parsing it correctly needs a trustworthy local clock and a
 * `Date` parse of a server-controlled string, and every Orbital limiter sends
 * `standardHeaders: true`, i.e. delta-seconds. An unparsable value yields
 * undefined and the caller falls back to its own schedule.
 *
 * `RateLimit-Reset` is the documented fallback — the same limiter emits it,
 * also in seconds. Nothing from the header reaches a message or
 * `serverMessage`: the result is a clamped number or nothing.
 */
function parseRetryAfterMs(headers?: HeaderReader): number | undefined {
  if (headers === undefined) return undefined;

  let raw: string | null;
  try {
    raw = headers.get('Retry-After') ?? headers.get('RateLimit-Reset');
  } catch {
    // A header bag that throws is a transport bug, not a rate-limit fact.
    return undefined;
  }
  if (typeof raw !== 'string') return undefined;

  const trimmed = raw.trim();
  // Digits only: this rejects the HTTP-date form, '1e3', '5s' and '-5'
  // before any Number() coercion can make something plausible of them.
  if (!/^\d+$/.test(trimmed)) return undefined;

  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;

  return Math.min(Math.max(0, seconds * 1000), MAX_RETRY_AFTER_MS);
}

/**
 * HTTP 429 — rate limited.
 *
 * A subclass rather than a `retryAfterMs` field on {@link ApiError}: the value
 * is meaningful on exactly one status, and a base-class field would be
 * readable (and read) on all of them.
 *
 * `statusCode`, `code` and `isRetryable` are unchanged from the plain
 * `ApiError` this replaces, so every existing
 * `e instanceof ApiError && e.code === 'RATE_LIMITED'` site keeps working.
 *
 * `retryAfterMs` is prod-retained: it is a number the server told us to wait,
 * not server text. It is undefined when the header was absent, unparsable, or
 * when the transport had no headers to offer.
 */
export class RateLimitError extends ApiError {
  readonly retryAfterMs: number | undefined;

  constructor(headers?: HeaderReader, serverMessage?: string) {
    super('Rate limited — try again shortly', 429, 'RATE_LIMITED', true, serverMessage);
    this.name = 'RateLimitError';
    this.retryAfterMs = parseRetryAfterMs(headers);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
