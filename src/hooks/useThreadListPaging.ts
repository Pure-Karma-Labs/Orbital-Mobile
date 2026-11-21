/**
 * "Load more" for a thread LIST — the UI half of the cursor walk (#923).
 *
 * Modelled on `ThreadDetailScreen.handleEndReached` (the replies pagination,
 * `ThreadDetailScreen.tsx:848`): the same ref guard, the same
 * `MAX_FOLLOW_UP_PAGES` cap, and the same rule that a page which adds no
 * RENDERED rows must keep the loop going, because content length is what makes
 * `onEndReached` fire again and an unchanged length stalls pagination forever.
 *
 * Four deliberate differences from that precedent, each because a thread list
 * is not a reply list:
 *
 * 1. **A dead end is tappable.** ThreadDetail sets `hasMoreRef = false` on a
 *    failure and the list simply stops. Here the end of the list is where
 *    imported posts live, so "we gave up" and "there is nothing older" would
 *    look identical — the exact failure #923 exists to fix. A failed page, a
 *    429, or the no-growth cap turns the footer into a tappable "Load more"
 *    row instead (a real ≥44pt frame; `hitSlop` escaping a short parent is
 *    clipped in this repo, see #888).
 * 2. **An error never ends the walk.** `hasMore` is owned by `threadListWalk`
 *    and only `exhausted` / `unsupported` clear it, so a network blip cannot
 *    permanently hide the rest of an orbit.
 * 3. **A 429 stops chaining immediately.** Walk requests are sent with
 *    `retryOn429: false` precisely so the limiter surfaces here; chaining four
 *    more pages into a shared 500-per-15-min IP budget is what the member's
 *    whole household would pay for.
 * 4. **An optional first-scroll gate.** `onEndReached` also fires on a
 *    content-size change, so a SHORT list auto-walks on open. That is wanted
 *    in an orbit and wrong in a DM (#886), hence `requireFirstScroll`.
 *
 * The hook also owns the leave: changing conversation or unmounting calls
 * `leaveThreadList` for the conversation being LEFT, which drops that walk and
 * trims its walked tail out of the store (at most one orbit's and one DM's
 * tail is ever resident).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { ThreadListFooter, type ThreadListFooterProps } from '../components/ThreadListFooter';
import { useThreadListPagingState } from '../stores';
import { leaveThreadList, loadMoreThreadsForGroup } from '../services/threadService';
import type { LoadMoreResult } from '../services/threadListWalk';

/**
 * Follow-up page cap for the zero-new-rows case — the same number, and the
 * same reason, as `ThreadDetailScreen.MAX_FOLLOW_UP_PAGES`: a page that adds
 * no rendered rows leaves content length unchanged, so `onEndReached` will not
 * fire again and the walk would stall; the loop keeps going, but never
 * unbounded. At 100 rows a page this is five requests per gesture, the ceiling
 * the rate-limit budget was sized against.
 */
export const MAX_FOLLOW_UP_PAGES = 5;

/**
 * Anchor the viewport on the first row so a page landing above it does not
 * shift what the member is reading.
 *
 * A module constant, not an inline object: a fresh `{…}` on every render is a
 * changed prop on the FlatList every render.
 *
 * Usable on these two lists specifically because NEITHER has a
 * `ListHeaderComponent`. RN 0.82.1's VirtualizedList adds +1 to
 * `minIndexForVisible` whenever a header exists, which is why ThreadDetail
 * cannot have this (see the comment on its FlatList, #821).
 *
 * `autoscrollToTopThreshold` is what keeps a member who is AT the top there.
 * Without it the native side shifts the offset by the anchor's movement
 * unconditionally, so the first activity of a new day (a new day heading plus
 * the row, inserted above the old first heading) would land off-screen above
 * a member sitting at offset 0. With it, a list within 16pt of the top
 * scrolls to the top after the adjustment; a member scrolled further down is
 * still anchored.
 */
export const THREAD_LIST_MVCP = Object.freeze({
  minIndexForVisible: 0,
  autoscrollToTopThreshold: 16,
});

/**
 * `removeClippedSubviews`, decided per platform because of the prop above.
 *
 * On Android, clipping DETACHES cells from the native view hierarchy, and
 * `maintainVisibleContentPosition` corrects the content offset by measuring
 * against that same hierarchy — the classic blank-cell / jumping combination,
 * called out as a risk in the #923 plan. Windowing (`windowSize={5}`) already
 * unmounts everything outside roughly two screens, so clipping inside the
 * window buys little on rows this cheap; correctness wins.
 *
 * iOS keeps it: clipping there is a shadow-tree concern and the pair is not a
 * reported problem. The device smoke watches both platforms for blank cells —
 * if iOS shows them too, this becomes a flat `false`.
 */
export const THREAD_LIST_REMOVE_CLIPPED_SUBVIEWS = Platform.OS !== 'android';

export interface UseThreadListPagingOptions {
  /** The conversation whose list is on screen, or `null` (nothing to page). */
  conversationId: string | null;
  /**
   * How many THREAD rows the list is currently rendering, after every filter
   * the screen applies (blocked authors, search). Day and section separators
   * are not counted: they cannot be what a page added.
   */
  renderedCount: number;
  /**
   * A filter is hiding rows (a non-empty blocked set today). With one active,
   * `newIdCount > 0` no longer implies the content grew, so the loop demands
   * real rendered growth before it trusts it — the #843 review finding, in its
   * list-screen form.
   */
  filtersActive?: boolean;
  /** Paging is off entirely (the screen is showing search results). */
  disabled?: boolean;
  /**
   * Require a real scroll gesture before the first page. See difference 4
   * above: DMs set this, orbits do not.
   */
  requireFirstScroll?: boolean;
}

export interface ThreadListPaging {
  /** Pass to `FlatList.onEndReached`. */
  onEndReached: () => void;
  /** Pass to `FlatList.onScrollBeginDrag` — opens the first-scroll gate. */
  onScrollBeginDrag: () => void;
  /** Pass to `ListFooterComponent`; `null` when there is nothing to show. */
  footer: React.ReactElement<ThreadListFooterProps> | null;
  /** What the "Load more" row calls. Also usable by an empty-list branch. */
  retry: () => void;
  /** Another page can be requested (never cleared by a failure). */
  hasMore: boolean;
  /** A page is in flight, or the follow-up loop is still running. */
  loading: boolean;
  /** The walk stopped short and is waiting for a tap. */
  stalled: boolean;
}

/** What asked for a page — a tap is allowed through guards a scroll is not. */
type WalkTrigger = 'scroll' | 'tap' | 'auto';

export function useThreadListPaging(options: UseThreadListPagingOptions): ThreadListPaging {
  const {
    conversationId,
    renderedCount,
    filtersActive = false,
    disabled = false,
    requireFirstScroll = false,
  } = options;

  const paging = useThreadListPagingState(conversationId);
  const [loopActive, setLoopActive] = useState(false);
  const [capped, setCapped] = useState(false);

  // Render-synced mirrors: the loop below reads these BETWEEN awaits, where a
  // closed-over value would be whatever it was when the gesture started.
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;
  const renderedCountRef = useRef(renderedCount);
  renderedCountRef.current = renderedCount;
  const filtersActiveRef = useRef(filtersActive);
  filtersActiveRef.current = filtersActive;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const hasMoreRef = useRef(paging.hasMore);
  hasMoreRef.current = paging.hasMore;

  const loadingMoreRef = useRef(false);
  const cappedRef = useRef(false);
  /** Has the member actually dragged this list yet? See difference 4. */
  const scrolledRef = useRef(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A new conversation is a new walk: the previous one's gate, cap and
  // in-flight flag say nothing about this one.
  useEffect(() => {
    scrolledRef.current = false;
    cappedRef.current = false;
    loadingMoreRef.current = false;
    setCapped(false);
    setLoopActive(false);
  }, [conversationId]);

  /**
   * Leaving this conversation — a switch OR an unmount — drops its walk and
   * trims the walked tail out of the store. The cleanup closes over the id it
   * was mounted with, so a switch leaves the OLD conversation, not the new one.
   */
  useEffect(() => {
    if (conversationId === null) return;
    return () => {
      leaveThreadList(conversationId);
    };
  }, [conversationId]);

  const markCapped = useCallback(() => {
    cappedRef.current = true;
    if (mountedRef.current) setCapped(true);
  }, []);

  const runWalk = useCallback(
    async (trigger: WalkTrigger): Promise<void> => {
      const target = conversationRef.current;
      if (target === null) return;
      if (disabledRef.current) return;
      if (loadingMoreRef.current) return;
      if (!hasMoreRef.current) return;
      // A stalled walk waits for a deliberate tap. Without this, the very
      // gesture that revealed the "Load more" row would keep re-arming the
      // loop against a server that just failed or rate-limited us.
      if (trigger !== 'tap' && cappedRef.current) return;
      if (trigger !== 'tap' && requireFirstScroll && !scrolledRef.current) {
        // An AUTO trigger is the empty-list case: nothing renders, so there is
        // no list to drag and `onScrollBeginDrag` will never come. Bailing
        // silently there left a blank box with no way out of it, so the walk
        // is marked stalled and the footer becomes the "Load more" row — the
        // one gesture an unscrollable list can still offer, and a tap opens
        // the gate. A SCROLL trigger (the content-size `onEndReached` the gate
        // exists to swallow) stays silent: arming the row there would defeat
        // the gate on every DM that merely has more.
        if (trigger === 'auto') markCapped();
        return;
      }

      loadingMoreRef.current = true;
      cappedRef.current = false;
      if (mountedRef.current) {
        setCapped(false);
        setLoopActive(true);
      }

      try {
        for (let page = 0; page < MAX_FOLLOW_UP_PAGES; page++) {
          const renderedBefore = renderedCountRef.current;

          let result: LoadMoreResult;
          try {
            result = await loadMoreThreadsForGroup(target);
          } catch {
            // A generic failure. `loadMoreFailed` is already set in the store
            // by the walk, and `hasMore` is deliberately untouched: the member
            // gets a retry, not a silently shortened orbit.
            markCapped();
            break;
          }

          // The screen moved on (switched conversation, or unmounted) while
          // the page was in flight. The page itself was still applied — it
          // belongs to `target`, which is correct — but nothing further is
          // this loop's business.
          if (!mountedRef.current || conversationRef.current !== target) break;

          if (result.status === 'rate-limited') {
            // Difference 3: nothing is chained behind a 429.
            markCapped();
            break;
          }
          if (result.status === 'skipped') {
            // No walk, a page already in flight, or a page discarded as stale
            // (#906). Nothing happened and nothing will until something else
            // changes, so offer the tap rather than spin.
            markCapped();
            break;
          }
          if (result.status === 'exhausted' || result.status === 'unsupported') {
            // `hasMore` is false now; the footer disappears on its own.
            break;
          }
          if (result.status === 'reopened') {
            // The cursor was rejected and the list is back at its head. The
            // content under the member just changed wholesale; let the next
            // end-reach (or tap) decide, rather than immediately re-walking a
            // list they are no longer looking at the end of.
            break;
          }
          if (!result.hasMore) break;

          // Stop as soon as the list actually GREW: new rendered rows extend
          // the content, so `onEndReached` fires again on its own. A page can
          // add ids that render nothing — every author on it blocked, which is
          // exactly the head-page case this feature has to survive — and then
          // content length is unchanged and `onEndReached` never re-fires. So
          // while a filter is active, require real rendered growth before
          // trusting `newIdCount` (#843 review).
          const renderedGrew = renderedCountRef.current > renderedBefore;
          if (result.newIdCount > 0 && (renderedGrew || !filtersActiveRef.current)) break;

          if (page === MAX_FOLLOW_UP_PAGES - 1) markCapped();
        }
      } finally {
        loadingMoreRef.current = false;
        if (mountedRef.current) setLoopActive(false);
      }
    },
    [markCapped, requireFirstScroll],
  );

  const onEndReached = useCallback((): void => {
    void runWalk('scroll');
  }, [runWalk]);

  const onScrollBeginDrag = useCallback((): void => {
    scrolledRef.current = true;
  }, []);

  const retry = useCallback((): void => {
    // A tap IS the gesture the gate was waiting for, and it clears the cap.
    scrolledRef.current = true;
    cappedRef.current = false;
    setCapped(false);
    void runWalk('tap');
  }, [runWalk]);

  /**
   * Auto-fill: a list with no rendered rows cannot be scrolled, so
   * `onEndReached` will never fire and a head page of nothing but blocked
   * authors would show "No threads yet" over an orbit that has plenty.
   *
   * The first-scroll gate still applies, by design: in a DM it leaves the
   * member a "Load more" row to tap instead of walking on its own.
   */
  useEffect(() => {
    if (renderedCount > 0) return;
    if (!paging.hasMore || disabled || conversationId === null) return;
    void runWalk('auto');
  }, [renderedCount, paging.hasMore, disabled, conversationId, runWalk]);

  const loading = loopActive || paging.loadingMore;
  // The store's own failure flag OR this hook's cap. The first survives a
  // re-render the hook did not cause; the second is the no-growth case, which
  // the service layer has no way to know about.
  const stalled = !loading && (capped || paging.loadMoreFailed);

  const footer = useMemo((): React.ReactElement<ThreadListFooterProps> | null => {
    if (disabled || !paging.hasMore) return null;
    if (!loading && !stalled) return null;
    // `createElement`, because this is a .ts hook module and the footer's JSX
    // lives in its own component file.
    return React.createElement(ThreadListFooter, {
      loading,
      stalled,
      onRetry: retry,
    });
  }, [disabled, paging.hasMore, loading, stalled, retry]);

  return {
    onEndReached,
    onScrollBeginDrag,
    footer,
    retry,
    hasMore: paging.hasMore,
    loading,
    stalled,
  };
}
