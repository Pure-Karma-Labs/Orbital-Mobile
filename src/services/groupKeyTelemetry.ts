/**
 * groupKeyTelemetry — the only emitter for group-key unwrap failures (#912).
 *
 * `src/services/crypto/**` cannot import Sentry or any telemetry facade
 * (ESLint `no-restricted-imports`, to keep key material out of error reports),
 * so the crypto layer reports through the import-free registry in
 * `crypto/groupKeyErrors.ts` and this module fills the slot from outside the
 * fence.
 *
 * Being the only emitter is what makes the budget meaningful: the composer
 * screens handle a group-key failure ABOVE `captureUploadFailure` and return
 * early (the `BlockedRecipientError` precedent), so one failure produces one
 * event rather than one per surface.
 *
 * ## What is sent
 *
 * `GroupKeyUnwrapError` and nothing else. Its message is built from closed enum
 * values, and `captureError` reports a rebuilt copy (class name, scrubbed
 * message, scrubbed frames). The `groupId` this module receives is used ONLY as
 * a budget key and is never attached to the event: a conversation id is a
 * content-adjacent identifier, and `scrubEvent` would not recognise it inside a
 * tag.
 *
 * @module groupKeyTelemetry
 */

import { captureError } from './telemetry';
import { setGroupKeyFailureReporter } from './crypto/groupKeyErrors';
import type { GroupKeyUnwrapError, SelfHealOutcome } from './crypto/groupKeyErrors';

/** Outcomes reported at `warning` rather than `error` — see the level below. */
const WARNING_OUTCOMES: ReadonlySet<string> = new Set<SelfHealOutcome>([
  'requested',
  'stale_pending',
]);

/**
 * Keys already spent, as `groupId:selfHeal`.
 *
 * Per (group, outcome) rather than per group: the useful signal is "this group
 * went from `requested` to `exhausted`", while a user reopening the same dead
 * conversation ten times is one fact, not ten.
 */
const spent = new Set<string>();

/**
 * Bounded like the WS dedup maps — an unbounded set would grow for the whole
 * session. Evicts oldest-first (Set iterates in insertion order), which at
 * worst re-reports a group the user stopped looking at long ago.
 */
const MAX_BUDGET_KEYS = 200;

function reportGroupKeyUnwrapFailure(groupId: string, error: GroupKeyUnwrapError): void {
  const budgetKey = `${groupId}:${error.selfHeal}`;
  if (spent.has(budgetKey)) return;
  spent.add(budgetKey);
  if (spent.size > MAX_BUDGET_KEYS) {
    const oldest = spent.values().next();
    if (!oldest.done) spent.delete(oldest.value);
  }

  captureError(error, {
    // `requested` is the SUCCESS path of the self-heal — the key is on its way,
    // and the user sees a transient notice. Worth counting, not worth paging.
    //
    // `stale_pending` (#937) is the expected END of that path when no member
    // ever re-wraps: an elapsed 24h, not a failure anyone on call can act on.
    // Same level for the same reason.
    level: WARNING_OUTCOMES.has(error.selfHeal) ? 'warning' : 'error',
    tags: { feature: 'group-key-self-heal' },
  });
}

/**
 * Drop the per-session budget. Registered in `localWipe` (account switch /
 * logout) and reachable from `fullCryptoWipe` through
 * `resetGroupKeyFailureBudget()`, which the crypto fence may call.
 *
 * Without this, the next account on the device would inherit this one's spent
 * keys and its first real failure could go unreported.
 */
export function clearGroupKeyTelemetryState(): void {
  spent.clear();
}

/**
 * Install the reporter. Idempotent — it only assigns the registry slot.
 *
 * Called as the first statement of `bootstrap()`, before its first `await`:
 * Sentry is initialized in `index.js` long before bootstrap runs, and every
 * bootstrap step from `clearKeychainIfFreshInstall` onwards can hit a group key
 * through a lazy drain. A reporter installed after the awaits would miss them.
 */
export function installGroupKeyFailureReporter(): void {
  setGroupKeyFailureReporter({
    report: reportGroupKeyUnwrapFailure,
    reset: clearGroupKeyTelemetryState,
  });
}
