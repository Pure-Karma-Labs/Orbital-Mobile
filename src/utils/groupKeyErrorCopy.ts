/**
 * User copy for a group key this device cannot open (#912), selected by the
 * self-heal OUTCOME rather than by the crypto cause.
 *
 * One pure function, shared by every surface that can hit the failure — the two
 * composers (Alert / banner) and the three read screens — so the same outcome
 * cannot be worded or routed differently depending on where the user was
 * standing when it happened. The `inviteCreateErrors` selector is the precedent
 * for the shape.
 *
 * ## Why the errors are matched by NAME
 *
 * `PendingWrapError` lives in `services/crypto/contentCrypto`, whose module
 * graph (orbital-signal, the conversation repository, `useAppStore` → MMKV via
 * nitro) no screen may import for one `instanceof`; and several suites replace
 * those service modules with factory mocks, which leaves the class undefined.
 * The names are assigned in the constructors and pinned from the consuming side
 * by this module's test.
 *
 * `isGroupKeyUnwrapError` is imported rather than re-implemented because
 * `services/crypto/groupKeyErrors.ts` is deliberately import-free (it is the one
 * module the crypto boundary, the telemetry reporter and the wire parser all
 * share), so importing it costs nothing and keeps one definition of the name.
 * The CLASS is still never imported.
 *
 * @module groupKeyErrorCopy
 */

import {
  isGroupKeyUnwrapError,
  isPendingWrapLike,
  type SelfHealOutcome,
} from '../services/crypto/groupKeyErrors';
import {
  GROUP_KEY_DEVICE_KEY_MESSAGE,
  GROUP_KEY_RESENDING_MESSAGE,
  GROUP_KEY_RETRY_LATER_MESSAGE,
  GROUP_KEY_UNREADABLE_MESSAGE,
} from './errorMessages';

/**
 * Alert title + message. The title is carried here so the composers cannot
 * drift apart on it; surfaces with no title slot (ComposeThreadScreen's
 * `ErrorBanner`) use the message alone.
 */
export interface GroupKeyFailureCopy {
  title: string;
  message: string;
}

/**
 * "The key is on its way." The only outcome that is not a failure, so its title
 * says the send has not happened YET rather than that it failed.
 */
const PENDING_TITLE = 'Not Sent Yet';
/**
 * Every outcome where the send did not happen and this device cannot change
 * that. One title for both the retry-later and the unreadable messages: the
 * distinction the user can act on lives in the message, and a second
 * near-synonym title ("Reply Failed" vs "Not Sent") would only differ by
 * surface, which is exactly the drift this module exists to prevent.
 */
const NOT_SENT_TITLE = 'Not Sent';
/** Points at Settings → identity restore, not at a peer or a retry. */
const DEVICE_KEY_TITLE = 'Device Key Problem';

/**
 * Is this the transient "a peer is re-wrapping" state?
 *
 * Exported because the read screens need the distinction the copy alone cannot
 * carry: pending renders a transient banner and keeps the screen otherwise
 * quiet, while every other outcome replaces the empty state with an
 * explanation.
 */
export function isGroupKeyPending(e: unknown): boolean {
  return isPendingWrapLike(e);
}

/**
 * Copy for a group-key failure, or `null` when the error is not one — in which
 * case the caller must fall through to its existing handling (telemetry
 * included; this function returning non-null is what suppresses the capture).
 *
 * The outcome is read off the error defensively. A `GroupKeyUnwrapError` built
 * by a newer build (or a mock) can carry an outcome this build has never heard
 * of, and `'healed'` is not supposed to reach a screen at all; both land on the
 * UNREADABLE default, which is the only message that is never WRONG — it
 * promises nothing and invites no retry.
 */
export function groupKeyFailureCopy(e: unknown): GroupKeyFailureCopy | null {
  if (isGroupKeyPending(e)) {
    return { title: PENDING_TITLE, message: GROUP_KEY_RESENDING_MESSAGE };
  }
  if (!isGroupKeyUnwrapError(e)) return null;

  // Widened on purpose: the value is wire-adjacent in the sense that it comes
  // from another module's enum, and the switch must not assume exhaustiveness.
  const outcome: SelfHealOutcome | string = e.selfHeal;
  switch (outcome) {
    // `session_exhausted`: the SESSION demote budget is spent and this group
    // never had a demote requested, so no peer has been asked about it and the
    // UNREADABLE copy ("another member needs to open Orbital") would be false.
    // The budget is per-session state, so "in a few minutes" is literally true
    // too: a relaunch frees it. Per-group `exhausted` is the opposite case and
    // keeps UNREADABLE.
    case 'session_exhausted':
    case 'rate_limited':
    case 'failed':
    case 'cooldown':
      return { title: NOT_SENT_TITLE, message: GROUP_KEY_RETRY_LATER_MESSAGE };
    case 'identity_mismatch':
    case 'blocked_local_key':
      return { title: DEVICE_KEY_TITLE, message: GROUP_KEY_DEVICE_KEY_MESSAGE };
    // `stale_pending` (#937): the key has been pending for longer than the
    // 24h bound, so "another member is re-sending it" has stopped being a
    // promise anyone can keep. It is still not a retry the user can win, so it
    // reads as UNREADABLE — and `isGroupKeyPending` is false for it, which is
    // what takes the transient banner down.
    case 'stale_pending':
    case 'refused':
    case 'unsupported':
    case 'exhausted':
    case 'not_eligible':
      return { title: NOT_SENT_TITLE, message: GROUP_KEY_UNREADABLE_MESSAGE };
    default:
      return { title: NOT_SENT_TITLE, message: GROUP_KEY_UNREADABLE_MESSAGE };
  }
}
