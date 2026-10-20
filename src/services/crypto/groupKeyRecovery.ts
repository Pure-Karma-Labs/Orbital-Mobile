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
 *   ones (a delay, not a lockout) — but a terminal verdict reached inside that
 *   window is repeated rather than downgraded to "try again later";
 * - a per-group cap of {@link PER_GROUP_DEMOTE_CAP} that counts COMMITTED
 *   demotes only — a network failure, a 429 or an `already_pending` 200 (which
 *   demotes nothing, though peers are still asked) costs nothing;
 * - a per-session cap of {@link SESSION_DEMOTE_CAP}, which sits under the
 *   backend limiter (5 per 15 minutes per user) without replacing it;
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
import { clearWrapDeliveryDedup } from './wrapDeliveryHook';
import { arrayBufferToBase64 } from './utils';
import { useAppStore } from '../../stores/useAppStore';
import { VerifiedStatus } from '../../types/database';

// ---------------------------------------------------------------------------
// Budget constants
// ---------------------------------------------------------------------------

/** Every attempt stamps this, so a hot loop backs off even when it fails. */
export const RECOVERY_COOLDOWN_MS = 15 * 60_000;

/**
 * Demotes allowed per group per session. Only a request that actually NULLed
 * the row counts: an `already_pending` 200 found it NULL already, so this
 * device changed nothing (#937).
 *
 * Note that the server fans out `sendWrapKeyRequests` post-commit on BOTH
 * branches, so an `already_pending` 200 DOES ask the peers again. Not spending
 * this cap for it is a deliberate choice, not a claim that nothing happened:
 * the row was already NULL, which recovery can only reach through a GET/POST
 * race, and that repeat fan-out stays bounded by the 15-minute per-group
 * cooldown, {@link SESSION_DEMOTE_CAP} and the server's own limiter.
 */
export const PER_GROUP_DEMOTE_CAP = 2;

/**
 * Committed demotes allowed per session across all groups, set below the
 * backend's `keyRewrapLimiter` (5 per 15 minutes per user) so one session's
 * COMMITTED demotes alone cannot fill the server's window.
 *
 * It is not a guarantee that the limiter is never tripped, and must not be
 * read as one:
 * - a refused or rejected request still consumes a limiter slot server-side
 *   while costing nothing here (only an accepted request spends this cap), so
 *   a run of 409s can reach the limiter with this cap untouched;
 * - these caps are per-session module state, so an app relaunch resets them
 *   while the server's 15-minute window keeps counting.
 *
 * Unlike {@link PER_GROUP_DEMOTE_CAP} this one is charged for an
 * `already_pending` 200 too (#937): nothing was demoted, but the request spent
 * a limiter slot AND the server still fanned out to the key holders, so this
 * cap and the cooldown are what bound the repeat.
 *
 * The server limiter is the hard gate. This cap is amplification control for
 * one session — a bound on how much ECIES work and WS fan-out one device can
 * ask its peers to do — and `rate_limited` is a first-class outcome precisely
 * because the limiter can still be reached.
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
 * The last TERMINAL verdict per group, remembered so the cooldown cannot
 * downgrade it.
 *
 * Every attempt stamps a 15-minute cooldown, and the cooldown short-circuit
 * used to return `'cooldown'` — which the copy selector maps to "try again in
 * a few minutes". So a group that had just been told "this device's keys need
 * restoring" or "another member must open Orbital" asked the user to retry on
 * every later view, for the one quarter-hour where the verdict was freshest.
 *
 * Only outcomes that say WHY nothing will change are recorded: a transient one
 * (`failed`, `rate_limited`) still falls through to `'cooldown'`, because
 * retrying later is genuinely the right advice for it. `session_exhausted` is
 * deliberately NOT recorded either — it already means "try again later", which
 * is what `'cooldown'` says.
 */
const lastTerminal = new Map<
  string,
  { outcome: SelfHealOutcome; refusalCode?: RewrapRefusalCode }
>();

/**
 * Outcomes that are terminal for the cooldown window: nothing this device does
 * before it expires can change them.
 */
const TERMINAL_OUTCOMES: ReadonlySet<string> = new Set<SelfHealOutcome>([
  'refused',
  'identity_mismatch',
  'exhausted',
  'not_eligible',
  'blocked_local_key',
  'unsupported',
]);

/** Record a terminal verdict for the cooldown window. Ignores everything else. */
function rememberTerminalOutcome(groupId: string, result: RecoveryResult): void {
  const outcome = result.outcome;
  // `healed` is excluded by the narrowing, not by the set — a healed attempt
  // is not a verdict to repeat.
  if (outcome === 'healed' || !TERMINAL_OUTCOMES.has(outcome)) return;
  lastTerminal.set(
    groupId,
    result.refusalCode === undefined
      ? { outcome }
      : { outcome, refusalCode: result.refusalCode },
  );
}

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
  lastTerminal.clear();
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
 *
 * Takes `groupId` because two branches have session side effects keyed to it
 * (the `endpointUnsupported` latch is global; the `ENVELOPE_CHANGED` delivery
 * dedup clear is per group).
 */
function routeDemoteError(
  e: unknown,
  groupId: string,
): {
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
    if (refusalCode === 'ENVELOPE_CHANGED') {
      // NOT a refusal to heal — the opposite. The server's row no longer holds
      // the envelope we fetched, so a peer has ALREADY re-wrapped and a fresh,
      // openable envelope exists server-side. "Another member needs to open
      // Orbital" would be plainly false, so this routes to the transient
      // `failed` (RETRY_LATER) copy instead.
      //
      // Nothing is cached and no pending TTL is stamped for `failed`, so the
      // next `getOrFetchGroupKey` refetches and picks the new envelope up. The
      // dedup clear is what lets that happen sooner: the delivery event that
      // announced the re-wrap was almost certainly the one that triggered this
      // attempt, and it has already claimed the 30-second dedup slot, so
      // without this the re-wrap is ignored for up to 30 seconds.
      clearWrapDeliveryDedup(groupId);
      return { outcome: 'failed', refusalCode };
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
      const result = await runRecovery(input);
      rememberTerminalOutcome(input.groupId, result);
      return result;
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
    code === 'unknown' ||
    // `no_envelope` is client-originated and NOT a `GroupKeyFailureCode`, so
    // the type already keeps it out of this function. Checked at runtime too
    // because the consequence of being wrong is a demote of a row that is
    // already NULL: a WS fan-out asking peers to re-wrap what they were
    // already asked to re-wrap (#937).
    (code as string) === 'no_envelope'
  ) {
    return { outcome: 'not_eligible', code };
  }
  if (localKeyInvalid) return { outcome: 'blocked_local_key', code };
  if (endpointUnsupported) return { outcome: 'unsupported', code };

  // --- Step 2: cooldown and caps -----------------------------------------
  const now = Date.now();
  const until = cooldownUntil.get(groupId);
  if (until !== undefined && now < until) {
    // A terminal verdict from earlier in this window survives it: the user is
    // told the same thing as the first time, not "try again in a few minutes".
    // `code` stays the CURRENT classification — it describes the envelope this
    // attempt just failed to open, while the outcome describes what the last
    // real attempt concluded.
    const remembered = lastTerminal.get(groupId);
    if (remembered !== undefined) {
      return remembered.refusalCode === undefined
        ? { outcome: remembered.outcome, code }
        : { outcome: remembered.outcome, code, refusalCode: remembered.refusalCode };
    }
    return { outcome: 'cooldown', code };
  }
  const perGroupDemotes = committedDemotes.get(groupId) ?? 0;
  if (perGroupDemotes >= PER_GROUP_DEMOTE_CAP) {
    return { outcome: 'exhausted', code };
  }
  if (sessionDemotes >= SESSION_DEMOTE_CAP) {
    // Two different facts wear the same shape here, and only one of them means
    // "a peer has been asked". A session-cap block with ZERO demotes committed
    // for this group means nobody has been asked about it — the budget went to
    // other groups (login-time name/avatar decryption fans out across every
    // orbit) — so it must not render as "another member needs to open Orbital".
    return { outcome: perGroupDemotes === 0 ? 'session_exhausted' : 'exhausted', code };
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
  let alreadyPending = false;
  try {
    const response = await requestGroupKeyRewrap(groupId, envelope, localPublicKey);
    alreadyPending = response.alreadyPending === true;
  } catch (e) {
    const { outcome, refusalCode } = routeDemoteError(e, groupId);
    return refusalCode === undefined ? { outcome, code } : { outcome, code, refusalCode };
  }

  // Accepted: the server has sent wrap requests to every key holder — on BOTH
  // branches, `already_pending` included (`sendWrapKeyRequests` runs
  // post-commit either way). What differs is whether THIS device changed the
  // row, and the two caps brake different things (#937):
  //
  // - the PER-GROUP cap counts demotes this device caused. An
  //   `already_pending` 200 found the row NULL before we asked, so it is not
  //   charged — deliberately, since recovery can only reach a NULL row through
  //   a GET/POST race, and the repeat fan-out it triggers is still bounded by
  //   the 15-minute cooldown, the session cap and the server limiter. If the
  //   server ever stopped fanning out unconditionally, or the race stopped
  //   being rare, this is the choice to revisit;
  // - the SESSION cap sits under the backend's `keyRewrapLimiter`, and the
  //   request consumed a limiter slot either way. It is charged always, or a
  //   run of races could walk the client straight into a 429.
  //
  // An older server omits the field, and the pre-#937 behaviour (charge both)
  // is what the `false` default gives.
  if (!alreadyPending) {
    committedDemotes.set(groupId, (committedDemotes.get(groupId) ?? 0) + 1);
  }
  sessionDemotes += 1;
  return { outcome: 'requested', code };
}
