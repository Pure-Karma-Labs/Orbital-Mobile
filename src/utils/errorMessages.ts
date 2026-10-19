/**
 * Shared user-facing copy for error outcomes that more than one screen has to
 * render, so the wording cannot drift between forms.
 */

/**
 * Shown when the server answers 429 (`ApiError` with `code === 'RATE_LIMITED'`).
 * Deliberately vague about the window: the backend's bucket size is not a
 * contract the client can see, and stating it would both drift and disclose the
 * limiter configuration.
 */
export const RATE_LIMIT_MESSAGE =
  'Too many attempts — please wait a few minutes and try again';

/**
 * Shown for a 429 on the key-recovery paths (key conflict resolution, Settings
 * recovery), which sit behind the backend's `keyResetLimiter` — 3 attempts per
 * 15 minutes, keyed per user, not the shared IP-keyed auth limiter
 * (`Orbital-Backend/src/middleware/rateLimiters.js:139-147`).
 *
 * The window is stated here on purpose: the caller is an authenticated owner
 * mid-recovery on the app's most fragile flow, "a few minutes" would invite
 * attempts that burn the tiny budget, and a per-user limiter's size discloses
 * nothing about other accounts. Keep this in sync with `keyResetLimiter`.
 */
export const RECOVERY_RATE_LIMIT_MESSAGE =
  'Too many attempts — please wait 15 minutes and try again';

// ---------------------------------------------------------------------------
// Group-key failures (#912)
//
// One message per self-heal OUTCOME, selected by `utils/groupKeyErrorCopy.ts`.
// They live here, not in that selector, because the invite flow renders the
// pending wording too (`inviteCreateErrors.ts`) and the two must not drift.
//
// None of them names the group, the peer, or the crypto cause: the user cannot
// act on any of that, and a conversation name in an error banner is the kind of
// detail that ends up in a screenshot.
// ---------------------------------------------------------------------------

/**
 * The self-heal was accepted: this device asked the server to drop its own dead
 * key row, and the remaining key holders have been asked to re-wrap.
 *
 * Says "by another member" because the wait depends on SOMEONE ELSE opening the
 * app — "please wait" alone would read as a local spinner the user can outlast.
 * "in a moment" rather than a duration: the real wait is however long it takes a
 * peer to come online, which the client cannot know (plan risk 6).
 */
export const GROUP_KEY_RESENDING_MESSAGE =
  "This conversation's encryption key is being re-sent by another member. Please try again in a moment.";

/**
 * A transient failure of the heal attempt itself — a cooldown, a 429, or a
 * network/unknown error. Retrying later genuinely can work, so this is the one
 * group-key message that invites a retry.
 *
 * "in a few minutes" matches the client's 15-minute per-group cooldown closely
 * enough to be honest without quoting a limiter's configuration (the same
 * reasoning as {@link RATE_LIMIT_MESSAGE}).
 */
export const GROUP_KEY_RETRY_LATER_MESSAGE =
  "Couldn't recover this conversation's encryption key right now. Please try again in a few minutes.";

/**
 * The server refused the demote, the endpoint is not deployed, or the per-group
 * budget is spent. Nothing this device does next will help.
 *
 * Deliberately NOT a "try again": the only thing that can fix it is a peer
 * sending a fresh wrap, so the message names the one action that resolves it
 * ("another member needs to open Orbital") instead of inviting a retry loop
 * that will keep failing identically.
 */
export const GROUP_KEY_UNREADABLE_MESSAGE =
  "This device can't open this conversation's encryption key. Another member needs to open Orbital to re-send it.";

/**
 * The server and this device disagree about this device's identity key, or the
 * local key pair failed its own probe.
 *
 * Points at the identity-restore Retry in Settings, NOT at a peer: a re-wrap to
 * the key the server holds would be just as unopenable, so telling the user to
 * wait for another member would be a lie that never resolves.
 */
export const GROUP_KEY_DEVICE_KEY_MESSAGE =
  "This device's encryption keys need to be restored before this conversation can be opened.";
