/**
 * Thread-list cursor walk — the state machine behind "load more" (#923).
 *
 * Imported Facebook/Instagram posts are served with their ORIGINAL date, so
 * they sort to the tail of an orbit's list. The client used to fetch one
 * `activity_desc` page of 50 and stop, which made every import unreachable in
 * an orbit with more than 50 threads. This module owns the walk that reaches
 * them: one entry per conversation, holding the server's opaque cursor and the
 * ids this device has paged in.
 *
 * ## It is the single writer of `threadListPaging`
 *
 * Every transition here mirrors itself into the store slot the footer renders
 * from. A second writer would let the footer and the walk disagree — offering
 * a page that cannot be requested, or hiding one that can.
 *
 * ## The cursor never leaves this module
 *
 * `ListThreadsResponse.nextCursor` encodes the group and thread UUIDs of a
 * real row. It is held in the in-memory map below, handed straight back to the
 * API layer, and put NOWHERE else: not the store, not persisted state, not
 * Sentry, not a log line. {@link peekWalk} deliberately reports only whether a
 * cursor exists.
 *
 * ## The invariant: a kept tail always has somewhere to go
 *
 * A conversation may hold a walked tail only while the walk can still continue
 * (`cursor !== null`) or has provably stopped (`exhausted` / `unsupported`).
 * Nulling the cursor while keeping the tail would leave the footer offering a
 * page that can add nothing — the member taps "Load more" and the list does
 * not change. So the pair is only ever cleared TOGETHER, by {@link reopenWalk},
 * and {@link commit} refuses any other combination in development.
 *
 * ## A page in flight belongs to ONE walk, and says so
 *
 * A request cannot be cancelled, so a page can land after the list was
 * reopened (a `tail: 'drop'` refresh, an `INVALID_CURSOR`) or left. Applying it
 * then re-adds rows the reopen just dropped and adopts a cursor from a walk
 * that no longer exists — a hole in the list until the next leave — or, after a
 * leave, re-lists up to a page of rows that nothing will ever trim. So every
 * entry carries an EPOCH: {@link beginWalkPage} hands it out, every reset
 * ({@link openWalk}, {@link reopenWalk}, and a {@link leaveWalk} followed by a
 * fresh open) takes a new one, and a page whose epoch has moved is dropped
 * without touching the store or the walk. The counter is module-level and only
 * ever increases, so an epoch handed out before a `leaveWalk` cannot match the
 * entry a later open creates.
 *
 * The first walk page is deliberately CURSORLESS: the head page is
 * `activity_desc` and its cursor is bound to that sort, while the walk runs on
 * `created_desc` (an `activity_desc` walk costs O(group size) per page
 * server-side and its sort keys move when a reply lands). The head cursor's
 * only use is as a capability probe — a server that returns `hasMore` without
 * one is pre-#313 and cannot be walked at all.
 */

import * as Sentry from '@sentry/react-native';
import { useAppStore } from '../stores/useAppStore';
import type { ThreadListPagingState } from '../types/store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Where one conversation's walk stands.
 *
 * - `idle` — another page can be requested.
 * - `loading` — a page is in flight.
 * - `exhausted` — the server answered `hasMore: false`. The only end signal.
 * - `unsupported` — no page can be requested for the rest of this viewing:
 *   a pre-cursor server, a walk page that claimed `hasMore` without a cursor,
 *   or a second `INVALID_CURSOR`. The list behaves exactly as it did before
 *   this feature.
 * - `rate-limited` — a 429; the cursor is intact and a retry is offered.
 */
export type ThreadWalkStatus =
  | 'idle'
  | 'loading'
  | 'exhausted'
  | 'unsupported'
  | 'rate-limited';

/** The outcome of one `loadMoreThreadsForGroup` call. */
export interface LoadMoreResult {
  /**
   * - `loaded` — a page was applied (`newIdCount` may still be 0).
   * - `exhausted` / `unsupported` — no further page will be requested.
   * - `reopened` — the cursor was rejected; the list is back at its head.
   * - `rate-limited` — a 429; retryable, nothing applied.
   * - `skipped` — nothing to do: no walk, a page was discarded as stale, or
   *   the walk it was claimed from was superseded while it was in flight.
   */
  status:
    | 'loaded'
    | 'exhausted'
    | 'unsupported'
    | 'reopened'
    | 'rate-limited'
    | 'skipped';
  /** Ids this page added to the conversation's list. */
  newIdCount: number;
  /** Whether another page can be requested after this one. */
  hasMore: boolean;
}

/** What one applied page tells the walk. */
export interface WalkPageOutcome {
  /** RAW server ids on the page, in server order. */
  ids: readonly string[];
  hasMore: boolean;
  /** The next cursor, when the server sent one. */
  nextCursor?: string;
  totalCount: number;
}

/** A read-only view for tests and callers. NEVER carries the cursor itself. */
export interface ThreadWalkSnapshot {
  status: ThreadWalkStatus;
  hasCursor: boolean;
  headIds: readonly string[];
  tailSize: number;
  failed: boolean;
  invalidCursorCount: number;
  totalCount: number;
  /** The generation a page must match to be applied. See the module docstring. */
  epoch: number;
}

interface WalkEntry {
  status: ThreadWalkStatus;
  /** SECRET: opaque row identity. See the module docstring. */
  cursor: string | null;
  /** Ids of the most recent HEAD page — the keep-set for a trim. */
  headIds: readonly string[];
  /** Ids this walk appended beyond the head. Non-empty ⇒ a tail is kept. */
  tailIds: Set<string>;
  /** Single-flight guard. */
  inflight: Promise<LoadMoreResult> | null;
  /** The last attempt failed (error or 429): the footer offers a retry. */
  failed: boolean;
  /** `INVALID_CURSOR` responses in this viewing; the second one stops paging. */
  invalidCursorCount: number;
  totalCount: number;
  /**
   * The generation of THIS walk. Drawn from the module-level counter, so it is
   * unique across the lifetime of the process and a deleted entry's epoch can
   * never be re-issued.
   */
  epoch: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const walks = new Map<string, WalkEntry>();

/**
 * Source of walk epochs. MODULE-level, never per entry: `leaveWalk` deletes the
 * entry, and a per-entry counter would start a re-opened conversation back at a
 * number a page still in flight is carrying. Monotonic for the life of the
 * process, so an epoch issued before a leave matches nothing afterwards.
 *
 * NOT reset by {@link clearThreadListPaging}, deliberately — a wipe is exactly
 * the moment a page in flight must not match anything that comes after it.
 */
let nextWalkEpoch = 1;

/**
 * Statuses that will request another page, and therefore need a cursor once a
 * tail has been walked.
 */
const CURSOR_BEARING: ReadonlySet<ThreadWalkStatus> = new Set<ThreadWalkStatus>([
  'idle',
  'loading',
  'rate-limited',
]);

/** `INVALID_CURSOR` responses tolerated in one viewing before paging stops. */
const MAX_INVALID_CURSORS = 2;

function makeEntry(): WalkEntry {
  return {
    status: 'idle',
    cursor: null,
    headIds: [],
    tailIds: new Set(),
    inflight: null,
    failed: false,
    invalidCursorCount: 0,
    totalCount: 0,
    epoch: nextWalkEpoch++,
  };
}

function toPagingState(entry: WalkEntry): ThreadListPagingState {
  return {
    hasMore: CURSOR_BEARING.has(entry.status),
    loadingMore: entry.status === 'loading',
    loadMoreFailed: entry.failed,
    totalCount: entry.totalCount,
  };
}

/**
 * The ONE mutation boundary: check the invariant, then mirror the entry into
 * the store slot the footer reads.
 *
 * The check throws in development only. A thrown invariant in a member's hands
 * would turn a paging bug into a blank orbit; in a test or a debug build it is
 * the point of the exercise, and every transition below goes through here.
 */
function commit(conversationId: string, entry: WalkEntry): void {
  if (__DEV__ && entry.tailIds.size > 0 && entry.cursor === null && CURSOR_BEARING.has(entry.status)) {
    throw new Error(
      `[threadListWalk] invariant: a walked tail was kept with no cursor (status ${entry.status})`,
    );
  }
  walks.set(conversationId, entry);
  useAppStore.getState().setThreadListPaging(conversationId, toPagingState(entry));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Does this conversation hold rows that only a walk put there? */
export function hasWalkedTail(conversationId: string): boolean {
  const entry = walks.get(conversationId);
  return entry !== undefined && entry.tailIds.size > 0;
}

/**
 * Can another page be requested for this conversation?
 *
 * The same answer the footer renders from — derived from the status, never
 * from a raw response field, so an error leaves it true and only `exhausted`
 * or `unsupported` makes it false.
 */
export function walkHasMore(conversationId: string): boolean {
  const entry = walks.get(conversationId);
  return entry !== undefined && CURSOR_BEARING.has(entry.status);
}

/** A cursor-free view of one walk, for tests and assertions. */
export function peekWalk(conversationId: string): ThreadWalkSnapshot | null {
  const entry = walks.get(conversationId);
  if (entry === undefined) return null;
  return {
    status: entry.status,
    hasCursor: entry.cursor !== null,
    headIds: [...entry.headIds],
    tailSize: entry.tailIds.size,
    failed: entry.failed,
    invalidCursorCount: entry.invalidCursorCount,
    totalCount: entry.totalCount,
    epoch: entry.epoch,
  };
}

/**
 * Is the walk a page was claimed from still the walk this conversation has?
 *
 * The question every caller holding an in-flight page must ask before it
 * applies ANYTHING — the store merge included, which is why the check lives
 * here rather than inside {@link applyWalkPage} alone.
 */
export function isWalkCurrent(conversationId: string, epoch: number): boolean {
  const entry = walks.get(conversationId);
  return entry !== undefined && entry.epoch === epoch;
}

export function getWalkInflight(conversationId: string): Promise<LoadMoreResult> | null {
  return walks.get(conversationId)?.inflight ?? null;
}

/** Record the in-flight page. Never creates an entry. */
export function setWalkInflight(
  conversationId: string,
  inflight: Promise<LoadMoreResult> | null,
): void {
  const entry = walks.get(conversationId);
  if (entry === undefined) return;
  entry.inflight = inflight;
}

/**
 * Clear the in-flight page, but only if it is still THIS one.
 *
 * A settled page runs its cleanup after the walk may already have been left
 * and re-opened; clearing unconditionally would drop the NEW walk's single
 * flight guard and let a second request go out against the same cursor.
 */
export function clearWalkInflight(
  conversationId: string,
  inflight: Promise<LoadMoreResult>,
): void {
  const entry = walks.get(conversationId);
  if (entry === undefined || entry.inflight !== inflight) return;
  entry.inflight = null;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * A head page REPLACED the list: start (or restart) the walk from scratch.
 *
 * `hasCursor` is the capability probe described in the module docstring, not a
 * position: the walk's own first page is cursorless.
 */
export function openWalk(
  conversationId: string,
  page: { ids: readonly string[]; hasMore: boolean; hasCursor: boolean; totalCount: number },
): void {
  const entry = makeEntry();
  entry.headIds = [...page.ids];
  entry.totalCount = page.totalCount;
  entry.status = !page.hasMore ? 'exhausted' : page.hasCursor ? 'idle' : 'unsupported';
  commit(conversationId, entry);
}

/**
 * A head page was MERGED into a conversation that already has a walk: only the
 * keep-set and the total move.
 *
 * The head response's own `hasMore` / `next_cursor` are deliberately ignored.
 * They describe the `activity_desc` head, not the `created_desc` walk: a
 * refresh must not re-enable an exhausted footer, and the head cursor cannot
 * be used to continue the walk at all.
 */
export function refreshWalk(
  conversationId: string,
  page: { ids: readonly string[]; totalCount: number },
): void {
  const entry = walks.get(conversationId);
  if (entry === undefined) return;
  entry.headIds = [...page.ids];
  entry.totalCount = page.totalCount;
  commit(conversationId, entry);
}

/**
 * Claim the right to request the next page.
 *
 * Returns the cursor to send (`null` on the walk's first page) together with
 * the EPOCH the page must still match when it lands, or `null` wrapped in a
 * refusal when the walk cannot page: see {@link ThreadWalkStatus}.
 */
export function beginWalkPage(
  conversationId: string,
):
  | { ok: true; cursor: string | null; epoch: number }
  | { ok: false; status: LoadMoreResult['status'] } {
  const entry = walks.get(conversationId);
  if (entry === undefined) return { ok: false, status: 'skipped' };
  if (entry.status === 'exhausted') return { ok: false, status: 'exhausted' };
  if (entry.status === 'unsupported') return { ok: false, status: 'unsupported' };
  if (entry.status === 'loading') return { ok: false, status: 'skipped' };

  const cursor = entry.cursor;
  entry.status = 'loading';
  entry.failed = false;
  commit(conversationId, entry);
  return { ok: true, cursor, epoch: entry.epoch };
}

/**
 * A walk page was applied to the store: advance the cursor and grow the tail.
 *
 * `epoch` is the one {@link beginWalkPage} handed out. A page from a superseded
 * walk is dropped here as well as at the caller's store write — the two checks
 * are deliberate belt and braces, because this is the function that would adopt
 * the stale cursor.
 */
export function applyWalkPage(
  conversationId: string,
  epoch: number,
  page: WalkPageOutcome,
): void {
  const entry = walks.get(conversationId);
  if (entry === undefined) return;
  if (entry.epoch !== epoch) return;

  const head = new Set(entry.headIds);
  for (const id of page.ids) {
    if (!head.has(id)) entry.tailIds.add(id);
  }
  entry.totalCount = page.totalCount;
  entry.failed = false;

  if (!page.hasMore) {
    // End of list. The cursor goes with it — `exhausted` requests nothing, so
    // the invariant is satisfied without dropping the tail the member is
    // looking at.
    entry.cursor = null;
    entry.status = 'exhausted';
  } else if (typeof page.nextCursor === 'string' && page.nextCursor.length > 0) {
    entry.cursor = page.nextCursor;
    entry.status = 'idle';
  } else {
    // `hasMore` with no cursor: a pre-#313 server, or one that stopped sending
    // them mid-walk. There is no way to ask for the next page, so this is the
    // same dead end as never having had cursors.
    entry.cursor = null;
    entry.status = 'unsupported';
  }

  commit(conversationId, entry);
}

/**
 * The page came back but must not be used (#906: the blocked set moved while
 * it was in flight, so its per-viewer values are stale).
 *
 * The cursor is UNCHANGED — the same page is re-requested next time — and the
 * tail does not grow, because nothing was applied.
 */
export function discardWalkPage(conversationId: string): void {
  const entry = walks.get(conversationId);
  if (entry === undefined || entry.status !== 'loading') return;
  entry.status = 'idle';
  entry.failed = false;
  commit(conversationId, entry);
}

/**
 * The page failed. The cursor is left exactly as it was, so a retry asks for
 * the same page; only the footer's state changes.
 *
 * A 429 is kept distinct: it means "come back shortly", and nothing on this
 * path may chain another request (walk pages are sent with
 * `retryOn429: false`, so the client did not retry either).
 */
export function failWalkPage(conversationId: string, kind: 'error' | 'rate-limited'): void {
  const entry = walks.get(conversationId);
  if (entry === undefined) return;
  entry.status = kind === 'rate-limited' ? 'rate-limited' : 'idle';
  entry.failed = true;
  commit(conversationId, entry);
}

/**
 * The server rejected our cursor.
 *
 * One occurrence is expected and recoverable (a cursor issued under a sort or
 * group this walk no longer matches): drop the tail, drop the cursor, and let
 * the list return to its head. A SECOND one in the same viewing means the
 * device and the server disagree about something this code cannot fix by
 * retrying, so paging stops for the rest of the viewing rather than looping.
 *
 * The breadcrumb carries NO cursor and NO ids — a cursor is row identity and
 * this is the one place that is holding one.
 */
export function noteInvalidCursor(conversationId: string): 'reopen' | 'stop' {
  const entry = walks.get(conversationId);
  if (entry === undefined) return 'stop';

  entry.invalidCursorCount += 1;
  const stop = entry.invalidCursorCount >= MAX_INVALID_CURSORS;

  Sentry.addBreadcrumb({
    category: 'thread-list',
    message: stop
      ? 'thread list cursor rejected twice; paging stopped'
      : 'thread list cursor rejected; reopening at the head',
    level: 'warning',
  });

  if (stop) {
    entry.tailIds.clear();
    entry.cursor = null;
    entry.status = 'unsupported';
    entry.failed = false;
    commit(conversationId, entry);
    return 'stop';
  }

  return 'reopen';
}

/**
 * The ONE reset: drop the walked tail and the cursor TOGETHER.
 *
 * Returns the head ids the caller should keep (so it can trim the store to
 * match), or `null` when there is no walk to reset.
 *
 * A page in flight is SUPERSEDED, not awaited: the epoch moves, so the page
 * lands on nothing, and the single-flight slot is released so the member can
 * walk the reopened list without waiting for a response that will be dropped.
 */
export function reopenWalk(conversationId: string): readonly string[] | null {
  const entry = walks.get(conversationId);
  if (entry === undefined) return null;

  entry.tailIds.clear();
  entry.cursor = null;
  entry.failed = false;
  entry.epoch = nextWalkEpoch++;
  entry.inflight = null;
  // `exhausted` / `unsupported` survive a reopen only as far as the next head
  // page, which calls `openWalk` and decides afresh. Anything else can page.
  if (entry.status === 'loading' || entry.status === 'rate-limited') entry.status = 'idle';
  commit(conversationId, entry);
  return entry.headIds;
}

/**
 * The screen left this conversation: forget the walk entirely.
 *
 * Returns the head ids so the caller can trim the store's tail, or `null` when
 * there was no walk. The in-flight page (if any) is abandoned — it cannot be
 * cancelled, and its epoch dies with the entry: because epochs come from a
 * module-level counter, a conversation opened again later takes a NEW one, so
 * the abandoned page cannot be applied to it either.
 */
export function leaveWalk(conversationId: string): readonly string[] | null {
  const entry = walks.get(conversationId);
  if (entry === undefined) return null;
  walks.delete(conversationId);
  useAppStore.getState().setThreadListPaging(conversationId, null);
  return entry.headIds;
}

/**
 * Drop BOTH halves of the paging state — this module's map and every store
 * slot (#923).
 *
 * Called from `localWipe` (so it runs on logout AND on account deletion) and
 * from `keyRecoveryService`, beside the other module clears. A walk holds
 * server cursors that encode row identity for the account being wiped; the
 * next account on this device must not inherit them.
 */
export function clearThreadListPaging(): void {
  walks.clear();
  useAppStore.getState().clearThreadListPaging();
}
