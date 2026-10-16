/**
 * Block/unblock → refetch sequencing (#897).
 *
 * Since Backend #301/#304/#306/#310 every list number the app renders is
 * PER-VIEWER and block-filtered server-side: thread `last_reply_at` and
 * `reply_count`, the `activity_desc` order, orbit and DM `unread_count` /
 * `last_message_at`, thread `media[]` and list `media_count`. Blocking or
 * unblocking therefore changes the server's answer for EVERY list, which makes
 * it a pull-to-refresh-class event rather than a local filter toggle — the
 * corrected values used to appear only on the next natural list load, so a
 * stale badge or a thread stuck at a blocked member's reply slot survived until
 * the user happened to reload.
 *
 * ## Why this is a service and not the slice
 *
 * `blockedUsersSlice` imports the API client and telemetry and nothing else.
 * `useAppStore` imports every slice, so a slice that imported
 * `threadService` / `conversationService` would close an import cycle. The
 * slice actions stay pure and awaitable; the sequencing lives here.
 *
 * The two services are loaded LAZILY (the `mediaPrefetchService` /
 * `authService` idiom) and `useAppStore` is the only static import, so
 * `useAuthorActions` — which `ReplyItem`, `ThreadHeader` and
 * `ChatMessageItem` all pull in — does not drag `conversationService`'s
 * crypto/DB graph into every rendered row.
 *
 * ## Why it waits for the API
 *
 * Until the block has actually landed, the server still answers with
 * pre-block values, so a refetch issued alongside the optimistic state change
 * would re-latch exactly the numbers it is meant to correct. `blockUser` /
 * `unblockUser` resolve when the request has SETTLED (success, swallowed
 * failure, or rollback) and never reject. On a failed block (offline) the
 * optimistic state is kept — the slice has no rollback for `blockUser` — so
 * the local media eviction stays consistent with it, the lists keep their
 * pre-block values until the next successful load, and the UI's `blockedSet`
 * filters plus the WebSocket guards still hide the content in the meantime.
 *
 * ## No logout teardown hook, deliberately
 *
 * Unlike `messageHandler` / `conversationService`, this module registers no
 * `clear*State` function in the logout path and needs none: `inflight` is
 * nulled in a `finally`, so it cannot survive the run that owns it, and a
 * coalesced re-run that starts after the wipe finds `captureSession() === null`
 * and returns without touching anything. The loaders carry their own
 * session-stale guards on top of that.
 *
 * NOTE: the `loadConversations()` + `loadDmConversations()` pair also appears
 * in `authService` and `keyRecoveryService`. A shared `reloadConversationLists`
 * was deliberately NOT extracted here: those two are smoke-verified bootstrap
 * paths that differ on Sentry capture, and widening the change was declined
 * for this PR.
 */

import { useAppStore } from '../stores/useAppStore';

/**
 * Single-flight. A block usually arrives with an unblock or a second block
 * close behind (the Block → "also report?" chain, a tap-happy Settings list),
 * and each run is four-plus network calls. A request that arrives while a run
 * is in flight is coalesced into ONE re-run afterwards, because the in-flight
 * run may have read the server before the newest block landed. Same shape as
 * `conversationService.ensureDmInflight`.
 */
let inflight: Promise<void> | null = null;
let rerunRequested = false;

async function runRefreshOnce(): Promise<void> {
  const [
    { loadConversations, loadDmConversations, captureSession, isSessionStale },
    { loadThreadsForGroup, loadThread },
  ] = await Promise.all([import('./conversationService'), import('./threadService')]);

  const session = captureSession();
  if (!session) return;

  const { activeConversationId, viewingConversationId, activeThreadId, threads } =
    useAppStore.getState();

  // The refresh set: the orbit selector's active orbit, the conversation a
  // Chats screen is currently showing (a DM the user blocked from), and the
  // owning conversation of an open thread — which can be none of the other
  // two, because `ChatDetailScreen` nulls `viewingConversationId` when it
  // pushes ThreadDetail. De-duplicated, so the common case is one call.
  const conversationIds = new Set<string>();
  for (const id of [
    activeConversationId,
    viewingConversationId,
    activeThreadId ? threads[activeThreadId]?.conversationId : null,
  ]) {
    if (id) conversationIds.add(id);
  }

  const tasks: Promise<unknown>[] = [
    loadConversations(),
    loadDmConversations(),
    ...[...conversationIds].map((id) => loadThreadsForGroup(id)),
  ];
  // The open thread's own detail row: its `reply_count` / `last_reply_at` are
  // per-viewer too, and the list call does not cover a thread opened from a
  // push notification.
  if (activeThreadId) tasks.push(loadThread(activeThreadId));

  // allSettled, never all: one failing loader (offline, a 403 on an orbit the
  // user just left) must not cancel the others, and this function must never
  // reject — its callers are fire-and-forget from an Alert handler.
  const results = await Promise.allSettled(tasks);

  // Logging only: a session that changed while the loaders ran is not worth
  // reporting — every loader has its own session guard and already dropped
  // its writes. Nothing else hangs off this check.
  if (__DEV__ && !isSessionStale(session)) {
    for (const result of results) {
      if (result.status === 'rejected') {
        const reason = result.reason;
        console.warn(
          '[BlockedContentRefresh] refresh step failed:',
          reason instanceof Error ? reason.message : reason,
        );
      }
    }
  }
}

/**
 * Re-pull every list whose numbers the server filters per viewer. Never
 * rejects; resolves when this run (plus a coalesced re-run, if one was asked
 * for while it was in flight) has settled.
 */
export function refreshBlockedContent(): Promise<void> {
  if (inflight) {
    rerunRequested = true;
    return inflight;
  }

  inflight = (async () => {
    try {
      await runRefreshOnce();
      while (rerunRequested) {
        rerunRequested = false;
        await runRefreshOnce();
      }
    } catch (e) {
      // Nothing inside is EXPECTED to throw — `Promise.allSettled` absorbs the
      // loaders — but the two dynamic imports can reject (a module-eval error,
      // a bundler miss), and every caller is fire-and-forget from an Alert
      // handler. So the contract "never rejects" is enforced here rather than
      // assumed (#906 review).
      if (__DEV__) {
        console.warn(
          '[BlockedContentRefresh] refresh failed:',
          e instanceof Error ? e.message : e,
        );
      }
    } finally {
      inflight = null;
      rerunRequested = false;
    }
  })();

  return inflight;
}

/**
 * Wait for the optimistic action's API call to settle, then refresh — and
 * NEVER reject (#906 review).
 *
 * The lazy `conversationService` import is itself awaited here, so it can
 * reject (module-eval error, bundler miss) where no `allSettled` would catch
 * it; both callers are fire-and-forget from an Alert handler, so the local
 * half of the operation must stand regardless. The session is captured after
 * that import — one microtask later than the state change, which is the price
 * of keeping the store writes synchronous — and only gates the refetch.
 */
async function settleThenRefresh(settled: Promise<void>, op: string): Promise<void> {
  try {
    const { captureSession, isSessionStale } = await import('./conversationService');
    const session = captureSession();
    await settled;
    if (!session || isSessionStale(session)) return;
    await refreshBlockedContent();
  } catch (e) {
    if (__DEV__) {
      console.warn(
        `[BlockedContentRefresh] ${op} refresh failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}

/**
 * Block, evict the author's cached media, then refetch once the API settles.
 *
 * The two store calls are SYNCHRONOUS on purpose: the open `ThreadHeader`
 * gallery and every `blockedSet`-filtered list must update on the tap, not
 * after a network round-trip. The session is captured after the lazy import
 * (the module keeps `conversationService` out of its static graph) and only
 * gates the refetch, so a logout during the block still blocks locally and
 * simply skips the refresh.
 */
export function blockUserAndRefresh(userId: string, username: string): Promise<void> {
  const store = useAppStore.getState();
  const settled = store.blockUser(userId, username);
  store.removeMediaForAuthor(userId);

  return settleThenRefresh(settled, 'block');
}

/**
 * Unblock, then refetch once the API settles.
 *
 * No eviction counterpart: the rows were never deleted from SQLite, so they
 * come back on the next hydrate / page load, and the server starts sending the
 * author's media again on the next request.
 */
export function unblockUserAndRefresh(userId: string): Promise<void> {
  const settled = useAppStore.getState().unblockUser(userId);

  return settleThenRefresh(settled, 'unblock');
}
