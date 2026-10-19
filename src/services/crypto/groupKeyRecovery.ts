/**
 * groupKeyRecovery — self-heal for a group key this device can never open.
 *
 * ## The failure it fixes (#912)
 *
 * A peer can wrap a group key to a member's **pre-reset** identity key: the
 * documented race at `conversationService.ts:912-918`. The server stores that
 * envelope, every retry refetches it, and `ecies_open` rejects it forever.
 * Before this module the member saw an empty conversation and a generic
 * "try again"; Sentry saw `SignalError.InvalidMessage` and nothing else.
 *
 * The fix asks the server to NULL **this device's own** wrapped key, which
 * makes every remaining key holder re-wrap through the existing
 * `wrap_key_request` path. The device never touches another member's row, and
 * the server compares the envelope and the identity key before it demotes
 * anything (compare-and-swap + freshness).
 *
 * ## Where it is allowed to run
 *
 * ONLY from the inner `processReceivedGroupKey` catch in
 * `contentCrypto.getOrFetchGroupKey` — i.e. after tiers 1 (memory) and 2
 * (SQLCipher) have both missed and the API has returned an envelope that does
 * not open. A persisted key always wins; this path cannot discard one.
 *
 * ## Amplification control
 *
 * A demote makes every key holder do ECIES work and emits a WS fan-out, so the
 * budget is deliberately small and layered:
 * - single-flight per group, so concurrent callers share one attempt;
 * - a 15-minute per-group cooldown that EVERY attempt stamps, including failed
 *   ones (a delay, not a lockout);
 * - a per-group cap of {@link PER_GROUP_DEMOTE_CAP} that counts COMMITTED
 *   demotes only — a network failure or a 429 costs nothing;
 * - a per-session cap of {@link SESSION_DEMOTE_CAP}, which stays under the
 *   backend limiter (5 per 15 minutes per user);
 * - two latches: `localKeyInvalid`, set only on a DEFINITE probe mismatch, and
 *   `endpointUnsupported`, set on a 404 (backend not deployed yet).
 *
 * ## No telemetry here
 *
 * ESLint bans Sentry and every telemetry facade from `src/services/crypto/**`.
 * This module returns an outcome; the caller reports it through the
 * `groupKeyErrors` reporter registry, which is installed from outside.
 *
 * @module groupKeyRecovery
 */

import { requestGroupKeyRewrap } from '../api/groups';
import { getIdentityKeyPair, refreshAndCompareIdentityKey } from './identityKeyAccess';
import { probeIdentityKeyPair } from './identityKeyProbe';
import { classifyEciesOpenError } from './groupKeyErrors';
import type { GroupKeyFailureCode, RewrapRefusalCode, SelfHealOutcome } from './groupKeyErrors';
import { arrayBufferToBase64 } from './utils';
import { useAppStore } from '../../stores/useAppStore';
import { VerifiedStatus } from '../../types/database';

// ---------------------------------------------------------------------------
// Budget constants
// ---------------------------------------------------------------------------

/** Every attempt stamps this, so a hot loop backs off even when it fails. */
export const RECOVERY_COOLDOWN_MS = 15 * 60_000;

/** Committed demotes allowed per group per session. */
export const PER_GROUP_DEMOTE_CAP = 2;

/**
 * Committed demotes allowed per session across all groups. Must stay BELOW the
 * backend's `keyRewrapLimiter` (5 per 15 minutes per user) so a legitimate
 * client never trips a rate limit.
 */
export const SESSION_DEMOTE_CAP = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * `'healed'` is deliberately NOT part of {@link SelfHealOutcome}: a healed
 * attempt throws nothing, so it never becomes a Sentry tag or user copy.
 */
export type RecoveryOutcome = SelfHealOutcome | 'healed';

export interface RecoveryResult {
  outcome: RecoveryOutcome;
  /**
   * The failure code to report. Equal to the input code except after gate 3,
   * where a successful sender-key refresh can reveal a different cause.
   */
  code: GroupKeyFailureCode;
  /** Set only for a coded 409 refusal. */
  refusalCode?: RewrapRefusalCode;
}

export interface RecoverDeadEnvelopeInput {
  groupId: string;
  /**
   * The exact envelope string `getGroupKey` returned, passed UNMODIFIED: the
   * server compares it byte-for-byte against the stored row, so a re-encode
   * would read as `ENVELOPE_CHANGED`.
   */
  envelope: string;
  /** The member who wrapped it, per the API response. */
  wrappedBy: string | null;
  /** Classification of the `ecies_open` failure. */
  code: GroupKeyFailureCode;
  /**
   * Retry the unwrap after a sender-key refresh.
   *
   * MUST close over `processReceivedGroupKey(groupId, envelope, wrappedBy)`
   * plus a `groupKeyCache` read — never `getOrFetchGroupKey`, which would
   * self-await the in-flight promise this recovery is running inside and hang
   * forever.
   *
   * Resolves with the key on success. Rejects with the underlying error on
   * failure, so the cause can be re-classified.
   */
  retryUnwrap: () => Promise<Uint8Array | null>;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

const cooldownUntil = new Map<string, number>();
const committedDemotes = new Map<string, number>();
const inflight = new Map<string, Promise<RecoveryResult>>();
let sessionDemotes = 0;

/**
 * Session kill switch: this device's identity key pair failed its own ECIES
 * probe, so NO envelope can be opened and no demote is justified (the server
 * would compare against a key we cannot prove we hold). Set only on a definite
 * `'mismatch'` — never on a throw, which may be a cold cache or a native
 * failure.
 */
let localKeyInvalid = false;

/** Session latch: the backend predates this endpoint (404). */
let endpointUnsupported = false;

/** Drop all recovery state. Called from `clearContentCryptoInflight()`. */
export function resetGroupKeyRecoveryState(): void {
  cooldownUntil.clear();
  committedDemotes.clear();
  inflight.clear();
  sessionDemotes = 0;
  localKeyInvalid = false;
  endpointUnsupported = false;
}

// ---------------------------------------------------------------------------
// Error routing
// ---------------------------------------------------------------------------

/**
 * Refusals that mean "server and device disagree about THIS device's identity
 * key" (or the server holds none). They point the user at identity restore,
 * not at a peer, so they get their own outcome and their own copy.
 */
const IDENTITY_REFUSALS: ReadonlyArray<RewrapRefusalCode> = [
  'IDENTITY_MISMATCH',
  'NO_IDENTITY_KEY',
  'SERVER_KEY_UNREADABLE',
];

/**
 * Route an error from `requestGroupKeyRewrap` to an outcome.
 *
 * Reads `name`, `statusCode` and `code` off the error rather than using
 * `instanceof`: suites replace `api/errors` with factory mocks, and a class
 * from another module registry fails `instanceof` while still carrying the
 * right fields. The same rule screens follow for `BlockedRecipientError`.
 */
function routeDemoteError(e: unknown): {
  outcome: SelfHealOutcome;
  refusalCode?: RewrapRefusalCode;
} {
  const err =
    e != null && typeof e === 'object'
      ? (e as {
          name?: unknown;
          statusCode?: unknown;
          code?: unknown;
          refusalCode?: unknown;
        })
      : {};
  const status = typeof err.statusCode === 'number' ? err.statusCode : 0;
  const apiCode = typeof err.code === 'string' ? err.code : '';

  if (status === 409) {
    const refusalCode =
      typeof err.refusalCode === 'string' ? (err.refusalCode as RewrapRefusalCode) : undefined;
    if (refusalCode !== undefined && IDENTITY_REFUSALS.includes(refusalCode)) {
      return { outcome: 'identity_mismatch', refusalCode };
    }
    return { outcome: 'refused', refusalCode };
  }
  if (status === 404) {
    // The endpoint is not deployed. Latch, so the rest of the session skips
    // straight to the honest copy instead of probing on every group.
    endpointUnsupported = true;
    return { outcome: 'unsupported' };
  }
  if (status === 400 || status === 422) {
    // Terminal: the server rejected the shape of OUR request. Retrying with
    // the same envelope and key can only fail the same way.
    return { outcome: 'not_eligible' };
  }
  if (status === 403) {
    // Not a member any more (or never was). Nothing to heal.
    return { outcome: 'refused' };
  }
  if (status === 401) {
    // Session expired mid-attempt — transient, and distinct from 403 so the
    // telemetry label does not read as a refusal.
    return { outcome: 'failed' };
  }
  if (status === 429 || apiCode === 'RATE_LIMITED') {
    return { outcome: 'rate_limited' };
  }
  return { outcome: 'failed' };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Try to make a dead group-key envelope openable, and report what happened.
 *
 * Never throws: every failure is an outcome. Concurrent calls for one group
 * share a single attempt.
 */
export function recoverDeadEnvelope(input: RecoverDeadEnvelopeInput): Promise<RecoveryResult> {
  const existing = inflight.get(input.groupId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      return await runRecovery(input);
    } finally {
      inflight.delete(input.groupId);
    }
  })();

  inflight.set(input.groupId, promise);
  return promise;
}

async function runRecovery(input: RecoverDeadEnvelopeInput): Promise<RecoveryResult> {
  const { groupId, envelope, wrappedBy } = input;
  let code = input.code;

  // --- Step 1: eligibility ------------------------------------------------
  const userId = useAppStore.getState().userId;
  if (
    !userId ||
    wrappedBy === null ||
    wrappedBy === userId ||
    // An unrecognised SignalError is not evidence of a dead envelope, and a
    // demote must be justified by a known cause.
    code === 'unknown'
  ) {
    return { outcome: 'not_eligible', code };
  }
  if (localKeyInvalid) return { outcome: 'blocked_local_key', code };
  if (endpointUnsupported) return { outcome: 'unsupported', code };

  // --- Step 2: cooldown and caps -----------------------------------------
  const now = Date.now();
  const until = cooldownUntil.get(groupId);
  if (until !== undefined && now < until) {
    return { outcome: 'cooldown', code };
  }
  if (
    (committedDemotes.get(groupId) ?? 0) >= PER_GROUP_DEMOTE_CAP ||
    sessionDemotes >= SESSION_DEMOTE_CAP
  ) {
    return { outcome: 'exhausted', code };
  }
  // Stamped before any network call or trust write, so a crash, a hang or a
  // transient failure still backs this group off.
  cooldownUntil.set(groupId, now + RECOVERY_COOLDOWN_MS);

  // --- Step 3: gate 1, the local probe -----------------------------------
  // Runs BEFORE the sender refresh (which writes trust state) and before any
  // demote: if our own key pair is broken, nothing downstream is meaningful.
  // The probed public key is the one sent to the server in step 5 — reused
  // rather than re-read, so the demote can only ever be witnessed by the key
  // this attempt actually proved.
  let localPublicKey: string;
  try {
    const { privateKey, publicKey } = getIdentityKeyPair();
    if (probeIdentityKeyPair(privateKey, publicKey) === 'mismatch') {
      localKeyInvalid = true;
      return { outcome: 'blocked_local_key', code };
    }
    localPublicKey = arrayBufferToBase64(publicKey);
  } catch {
    // Includes 'Identity key pair not available' (cold cache, wiped DB) and
    // any native failure. Ambiguous — no latch, retry allowed after cooldown.
    return { outcome: 'failed', code };
  }

  // --- Step 4: gate 3, stale sender key ----------------------------------
  if (code === 'sender_mismatch') {
    try {
      const { identityChanged } = await refreshAndCompareIdentityKey(wrappedBy, userId);
      if (identityChanged) {
        // The wrapper reset their identity: surface it the same way the WS
        // wrap path does (#633 convention).
        useAppStore.getState().setContactVerifiedStatus(wrappedBy, VerifiedStatus.Unverified);
      }
    } catch {
      return { outcome: 'failed', code };
    }

    try {
      const key = await input.retryUnwrap();
      if (key) return { outcome: 'healed', code };
      // Resolved without a key: nothing to classify, nothing proven.
      return { outcome: 'failed', code };
    } catch (e) {
      const reclassified = classifyEciesOpenError(e);
      if (reclassified === null || reclassified === 'unknown') {
        return { outcome: 'not_eligible', code };
      }
      code = reclassified;
    }
  }

  // --- Step 5: demote ----------------------------------------------------
  try {
    await requestGroupKeyRewrap(groupId, envelope, localPublicKey);
  } catch (e) {
    const { outcome, refusalCode } = routeDemoteError(e);
    return refusalCode === undefined ? { outcome, code } : { outcome, code, refusalCode };
  }

  // Committed: either the row was demoted or it was already NULL, and in both
  // cases the server has sent wrap requests to every key holder. Only this
  // branch spends the caps.
  committedDemotes.set(groupId, (committedDemotes.get(groupId) ?? 0) + 1);
  sessionDemotes += 1;
  return { outcome: 'requested', code };
}
