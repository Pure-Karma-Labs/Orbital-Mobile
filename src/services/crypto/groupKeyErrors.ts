/**
 * groupKeyErrors — the closed vocabulary for "this device cannot open this
 * group key", plus the classifier that turns an `ecies_open` failure into it.
 *
 * ## Why this module has NO imports
 *
 * Three callers need it and none of them may drag a dependency graph behind it:
 * - `src/services/crypto/**` (contentCrypto, groupKeyRecovery, keyGenerationService),
 *   where ESLint bans Sentry and every telemetry facade;
 * - `src/services/groupKeyTelemetry.ts`, which registers its reporter here
 *   before the first await in `bootstrap()`;
 * - `src/services/api/errors.ts`, which allowlists `details.code` on a 409
 *   against {@link REWRAP_REFUSAL_CODES}.
 *
 * Keeping it import-free is what makes the telemetry hook legal from inside the
 * crypto boundary: key material never reaches this file, and this file cannot
 * reach Sentry — the registered reporter does, from outside.
 *
 * ## What is reportable
 *
 * Every value here is a client-defined enum. `GroupKeyUnwrapError.message` is
 * built from enum values only, so the whole error — message included — is safe
 * to send to Sentry. No groupId, no userId, no envelope, no reason string.
 *
 * @module groupKeyErrors
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Why `ecies_open` refused the group-key envelope.
 *
 * - `recipient_mismatch` — the envelope was sealed to a DIFFERENT recipient
 *   identity key than this device holds. The #912 case: a peer wrapped to the
 *   member's pre-reset key. Unrecoverable locally; needs a re-wrap.
 * - `sender_mismatch` — the embedded sender key is not the sender key we
 *   expected. Usually a stale cached identity key for the wrapper, which a
 *   refresh can fix locally.
 * - `corrupt` — signature failure or a degenerate DH point: the bytes are not
 *   a valid envelope from anyone.
 * - `unknown` — a SignalError this classifier does not recognise. Never
 *   self-healed (a demote must be justified by a known cause).
 */
export type GroupKeyFailureCode = 'recipient_mismatch' | 'sender_mismatch' | 'corrupt' | 'unknown';

/**
 * Every cause a {@link GroupKeyUnwrapError} can carry — the classifier's codes
 * plus the one cause that has no envelope to classify.
 *
 * - `no_envelope` — the server has no wrapped key for this device at all (a
 *   NULL row), so there is nothing to open. CLIENT-ORIGINATED: it is produced
 *   only by `contentCrypto`'s pending paths and is NEVER returned by
 *   {@link classifyEciesOpenError}.
 *
 * Deliberately a SEPARATE type from {@link GroupKeyFailureCode}, which stays
 * the narrow classifier vocabulary: `groupKeyRecovery` takes a
 * `GroupKeyFailureCode` in and out, so `no_envelope` cannot reach its demote
 * gate even as a widened value. A NULL row is already "demoted" — asking the
 * server to demote it again would be a fan-out for nothing.
 */
export type GroupKeyErrorCode = GroupKeyFailureCode | 'no_envelope';

/**
 * Compile-time proof of the sentence above: `no_envelope` is not in
 * {@link classifyEciesOpenError}'s range. Adding it to
 * {@link GroupKeyFailureCode} makes `Extract` non-empty, the conditional
 * resolve to `never`, and this declaration stop compiling — which is the
 * point, because the demote gate would then be able to see a code that means
 * "there is nothing to demote".
 *
 * The ANNOTATION is the assertion; the value exists because `noUnusedLocals`
 * deletes a proof nobody reads, and it is exported so this module's test can
 * read it.
 */
export const NO_ENVELOPE_IS_CLIENT_ONLY: Extract<
  ReturnType<typeof classifyEciesOpenError>,
  'no_envelope'
> extends never
  ? true
  : never = true;

/**
 * How long a group may stay in "a peer is re-wrapping your key" before the
 * client stops promising it (#937).
 *
 * The promise is only true while some member can actually re-wrap. Nothing
 * server-side can prove that — a holder row may itself be dead — so the bound
 * is the client's own honesty check: past it, the pending copy is replaced by
 * UNREADABLE. A delivery still heals the group at any point, before or after.
 */
export const PENDING_WRAP_BOUND_MS = 24 * 60 * 60 * 1000;

/**
 * What the self-heal attempt did about it. These are the only values that ever
 * become a Sentry tag or select user copy, so the list is closed and the copy
 * selector (`src/utils/groupKeyErrorCopy.ts`) maps every one of them.
 *
 * - `requested` — the server accepted the demote; peers are re-wrapping.
 * - `cooldown` — this group was attempted within the cooldown window, and no
 *   terminal verdict was reached for it earlier in the session.
 * - `exhausted` — this GROUP's demote cap is spent (or the session cap is spent
 *   and this group already had a demote committed). A peer has been asked and
 *   has not delivered, so the copy may point at a peer.
 * - `session_exhausted` — the SESSION cap is spent and this group never had a
 *   demote requested at all. Nobody has been asked about this group, so the
 *   copy must NOT point at a peer: the caps are per-session module state, so a
 *   relaunch makes this group eligible again.
 * - `refused` — the server declined (see `refusalCode`), or 403.
 * - `identity_mismatch` — server and device disagree about this device's
 *   identity key, or the server has none. Points at identity restore, not at
 *   a peer.
 * - `unsupported` — the endpoint is not deployed (404).
 * - `rate_limited` — 429 from the rewrap limiter.
 * - `blocked_local_key` — the local identity key pair failed its own probe, so
 *   no envelope can be opened and no demote may be requested.
 * - `not_eligible` — self-heal does not apply (no sender, self-wrapped,
 *   unknown cause, or a terminal 400).
 * - `failed` — a transient failure of the attempt itself. Retryable later.
 * - `stale_pending` — this group has been waiting for a wrap for longer than
 *   {@link PENDING_WRAP_BOUND_MS} (#937). Produced ONLY by `contentCrypto`,
 *   never by `groupKeyRecovery`: it is a verdict about elapsed time, not about
 *   an attempt, so it is not a terminal recovery outcome either.
 */
export type SelfHealOutcome =
  | 'requested'
  | 'cooldown'
  | 'exhausted'
  | 'session_exhausted'
  | 'refused'
  | 'identity_mismatch'
  | 'unsupported'
  | 'rate_limited'
  | 'blocked_local_key'
  | 'not_eligible'
  | 'failed'
  | 'stale_pending';

/**
 * Client copy of the backend's `REWRAP_REFUSAL_CODES`
 * (`Orbital-Backend/src/middleware/errorHandler.js`), delivered as
 * `details.code` on a 409 `REWRAP_REFUSED`.
 *
 * APPEND-ONLY, like `VALIDATION_CODES`: the backend never renames or reuses a
 * code, and neither does this copy. `'unrecognized'` is the client's own
 * sentinel for a code this build has never heard of — a newer backend must not
 * be able to put an arbitrary server string into a tag or an error message.
 *
 * Canonical here rather than in `api/errors.ts` because both the wire parser
 * (which allowlists it) and the telemetry tag (which reports it) need the same
 * list, and this is the only module both of them are allowed to import.
 */
export const REWRAP_REFUSAL_CODES = Object.freeze({
  ENVELOPE_CHANGED: true,
  UNATTRIBUTED: true,
  SELF_WRAPPED: true,
  NO_IDENTITY_KEY: true,
  IDENTITY_MISMATCH: true,
  SERVER_KEY_UNREADABLE: true,
  NO_KEY_HOLDER: true,
  DEMO_ACCOUNT: true,
  /** Client sentinel: the 409 carried a code this build does not know. */
  unrecognized: true,
});

export type RewrapRefusalCode = keyof typeof REWRAP_REFUSAL_CODES;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * A group key this device cannot open, with the self-heal verdict attached.
 *
 * Screens MUST match on `err.name === 'GroupKeyUnwrapError'` (or use
 * {@link isGroupKeyUnwrapError}), never on `instanceof`: suites that replace
 * service modules with factory mocks leave this class undefined.
 */
export class GroupKeyUnwrapError extends Error {
  readonly code: GroupKeyErrorCode;
  readonly selfHeal: SelfHealOutcome;
  /** Present only when the server refused a demote with a coded 409. */
  readonly refusalCode: RewrapRefusalCode | undefined;

  constructor(code: GroupKeyErrorCode, selfHeal: SelfHealOutcome, refusalCode?: RewrapRefusalCode) {
    // Enum values only — this message is reportable verbatim.
    super(
      refusalCode === undefined
        ? `Group key unwrap failed: ${code} / ${selfHeal}`
        : `Group key unwrap failed: ${code} / ${selfHeal} / ${refusalCode}`,
    );
    this.name = 'GroupKeyUnwrapError';
    this.code = code;
    this.selfHeal = selfHeal;
    this.refusalCode = refusalCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Name-based test — survives factory mocks that shadow the class. */
export function isGroupKeyUnwrapError(e: unknown): e is GroupKeyUnwrapError {
  return (
    e != null && typeof e === 'object' && (e as { name?: unknown }).name === 'GroupKeyUnwrapError'
  );
}

/**
 * Is this the "waiting for a wrap for longer than the bound" end state (#937)?
 *
 * Name-based for the same reason as {@link isGroupKeyUnwrapError}: suites
 * replace the crypto modules with factory mocks, which leaves the class
 * undefined and `instanceof` false for an error that is otherwise identical.
 *
 * Callers that treat the pending state as recoverable (the pending-name
 * registry) must accept this alongside `PendingWrapError`: the key can still
 * arrive, the client has only stopped promising that it will.
 */
export function isStalePendingError(e: unknown): boolean {
  return isGroupKeyUnwrapError(e) && e.selfHeal === 'stale_pending';
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Reason substrings copied from
 * `packages/orbital-signal/rust/orbital_signal/src/ecies.rs`.
 *
 * The tags come from the Rust `SignalError` enum and the reasons from its
 * `format!`/`into()` literals. Both are pinned by
 * `__tests__/eciesReasonContract.test.ts`, and a rename degrades every branch
 * below to `'unknown'` — which is never self-healed. Fail-safe by construction:
 * a classifier that stops recognising a cause stops asking for demotes.
 */
const REASON_DECRYPTION_FAILED = 'decryption failed';
const REASON_DH_IDENTITY_POINT = 'DH produced identity point';
const REASON_SENDER_MISMATCH = 'does not match expected sender';

/**
 * Classify an error thrown by `ecies_open` (via `unwrapGroupKey`).
 *
 * @returns the failure code, or `null` when the error is not a SignalError at
 *          all — a database failure, a `No authenticated user` throw, a bug.
 *          `null` means "rethrow unchanged, this is not a key problem".
 *
 * Discrimination is POSITIVE: a uniffi-lifted `SignalError` always has
 * `message === 'SignalError.<Variant>'`. Duck-typing on `tag` alone would
 * accept any object with a `tag` property, and `InvalidSignature` carries no
 * `inner` at all — hence the optional chaining throughout.
 */
export function classifyEciesOpenError(e: unknown): GroupKeyFailureCode | null {
  if (e == null || typeof e !== 'object') return null;
  const err = e as {
    message?: unknown;
    tag?: unknown;
    inner?: { reason?: unknown };
  };
  if (typeof err.message !== 'string' || !err.message.startsWith('SignalError.')) {
    return null;
  }

  const tag = typeof err.tag === 'string' ? err.tag : '';
  const reason = typeof err.inner?.reason === 'string' ? err.inner.reason : '';

  if (tag === 'InvalidMessage') {
    if (reason.includes(REASON_DECRYPTION_FAILED)) return 'recipient_mismatch';
    if (reason.includes(REASON_DH_IDENTITY_POINT)) return 'corrupt';
    return 'unknown';
  }
  if (tag === 'InvalidKey') {
    if (reason.includes(REASON_SENDER_MISMATCH)) return 'sender_mismatch';
    return 'unknown';
  }
  if (tag === 'InvalidSignature') return 'corrupt';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Reporter registry
// ---------------------------------------------------------------------------

/**
 * Installed by `src/services/groupKeyTelemetry.ts`. Two methods, not one
 * function, because the crypto wipes also have to clear the reporter's
 * per-session budget and they cannot import a telemetry module.
 */
export interface GroupKeyFailureReporter {
  /** Report one failure. Must never throw. */
  report: (groupId: string, error: GroupKeyUnwrapError) => void;
  /** Drop the per-session budget (account switch, key wipe). Must never throw. */
  reset: () => void;
}

let reporter: GroupKeyFailureReporter | null = null;

/** Install (or with `null`, uninstall) the reporter. */
export function setGroupKeyFailureReporter(r: GroupKeyFailureReporter | null): void {
  reporter = r;
}

/**
 * Report a group-key failure, if a reporter is installed.
 *
 * `groupId` is handed over as a BUDGET KEY only — the reporter must not put it
 * in the event. Reporting never throws and never changes control flow: the
 * caller is on a failure path already.
 */
export function reportGroupKeyFailure(groupId: string, error: GroupKeyUnwrapError): void {
  const r = reporter;
  if (r === null) return;
  try {
    r.report(groupId, error);
  } catch {
    // Telemetry must never break a crypto path.
  }
}

/**
 * Clear the installed reporter's budget. Callable from the crypto boundary
 * (`fullCryptoWipe`), which may not import the telemetry module itself.
 */
export function resetGroupKeyFailureBudget(): void {
  const r = reporter;
  if (r === null) return;
  try {
    r.reset();
  } catch {
    // Telemetry must never break a crypto path.
  }
}
