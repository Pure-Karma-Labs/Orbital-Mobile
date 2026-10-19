/**
 * wrapDeliveryHook — one-way, import-free hook from the crypto layer into the
 * WebSocket handler's `wrapped_key_delivered` dedup.
 *
 * ## Why a registry and not an import
 *
 * After a successful demote (#912) the next `wrapped_key_delivered` for that
 * group is the signal that the heal has landed. But `handleWrappedKeyDelivered`
 * drops a second event for the same group inside a 30-second window, and the
 * failing fetch that triggered the recovery usually came from one of those
 * events — so the entry is already there and the re-wrap would be ignored for
 * up to 30 seconds.
 *
 * `contentCrypto` cannot just call into `messageHandler` to clear it:
 * - `messageHandler` already imports `contentCrypto`, so that is an import
 *   cycle; and
 * - `src/services/crypto/**` is a fenced layer (ESLint bans Sentry and every
 *   telemetry facade there), and reaching into `services/websocket/**` would
 *   pull that whole graph — stores, repositories, notifications — behind the
 *   fence and into a dozen crypto test suites' mock lists.
 *
 * So the dependency is inverted: this module holds a slot, `messageHandler`
 * fills it at module scope (subscriptions and registrations live in module
 * scope — the #677 rule), and the crypto layer calls the slot. When
 * `messageHandler` has never been loaded there is nothing to clear anyway: the
 * dedup map lives inside it.
 *
 * Import-free on purpose, like `groupKeyErrors.ts`, so both sides may import it
 * from either side of the fence.
 *
 * @module wrapDeliveryHook
 */

export type WrapDeliveryDedupClearer = (groupId: string) => void;

let clearer: WrapDeliveryDedupClearer | null = null;

/** Install (or with `null`, uninstall) the clearer. Called by `messageHandler`. */
export function setWrapDeliveryDedupClearer(fn: WrapDeliveryDedupClearer | null): void {
  clearer = fn;
}

/**
 * Forget that a `wrapped_key_delivered` was recently handled for this group, so
 * the next one is processed instead of deduped.
 *
 * No-op when nothing is installed, and never throws: the caller is on a
 * failure path and must not be derailed by a delivery-side detail.
 */
export function clearWrapDeliveryDedup(groupId: string): void {
  const fn = clearer;
  if (fn === null) return;
  try {
    fn(groupId);
  } catch {
    // Dedup hygiene is best-effort; the 30s TTL is the fallback.
  }
}
