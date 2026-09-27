/**
 * Focus (scroll + highlight) for a single reply row in the thread list (#821).
 *
 * One mechanism serves three callers, which differ only in how long they are
 * willing to wait for the row to exist:
 * - `deeplink` — a push-notification tap. The row may be on an unloaded page,
 *   so the request stays open for 10s while pagination runs.
 * - `jump`     — the "↳ Replying to @x" control. The parent is loaded by
 *   definition (the tree said `jumpable`), so 3s is generous.
 * - `landing`  — the user's own reply just confirmed. 3s, and the request
 *   RE-resolves on every content-size change inside that window, because a
 *   media gallery painting after the scroll moves the row again.
 *
 * Invariants this hook exists to keep:
 * - The index is looked up BY ID at resolve time, never captured. Tree order
 *   inserts mid-list, so an index captured a frame ago points at a stranger.
 * - A new request cancels the previous one outright (timers included). There
 *   is never more than one focus in flight.
 * - Every timer callback checks `mountedRef` before touching state.
 * - Nothing here calls `navigation.setParams`: a deep-link param that rewrites
 *   itself re-triggers the effect that consumed it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import {
  ancestorIds,
  type ReplyTreeInput,
  type ReplyTreeNode,
} from '../../utils/replyTree';

/** Where the focus request came from — this is what sets the patience budget. */
export type ReplyFocusSource = 'deeplink' | 'jump' | 'landing';

/** The slice of FlatList's imperative surface this hook drives. */
export interface ReplyFocusListHandle {
  scrollToIndex: (params: {
    index: number;
    animated?: boolean | null;
    viewPosition?: number;
  }) => void;
  scrollToOffset: (params: { offset: number; animated?: boolean | null }) => void;
}

/**
 * Any row shape the thread list renders. The id is what the hook resolves on;
 * `authorUsername` is used ONLY for the screen-reader announcement, so a row
 * type without it still works (the announcement just drops the name).
 */
export interface ReplyFocusRow {
  reply: { id: string; authorUsername?: string };
}

export interface UseReplyFocusOptions<Row extends ReplyFocusRow> {
  listRef: React.RefObject<ReplyFocusListHandle | null>;
  /** The CURRENT visible rows, in render order. */
  rows: readonly Row[];
  /**
   * Expand every collapsed ancestor of `id` so the row can become visible.
   * MUST be idempotent: when nothing needs expanding it has to leave state
   * identity untouched, or the resolve effect re-runs forever.
   * {@link makeExpandAncestors} builds one with that property.
   */
  expandAncestors: (id: string) => void;
  /** Measured height of `ListHeaderComponent`, added to the fallback offset. */
  headerHeight: number;
}

export interface ReplyFocusApi {
  /** Focus a reply by id. A second call cancels whatever was in flight. */
  requestFocus: (id: string, options: { source: ReplyFocusSource }) => void;
  /**
   * Abandon the in-flight request and drop the highlight. Wired to
   * `onScrollBeginDrag`: once the user is dragging, a landing re-scroll would
   * yank the list out from under their thumb.
   */
  cancelFocus: () => void;
  /** The row currently painted with the highlight overlay. */
  highlightedId: string | null;
  /** Wire to `FlatList#onContentSizeChange`. */
  onContentSizeChange: () => void;
  /** Wire to `FlatList#onScrollToIndexFailed`. */
  onScrollToIndexFailed: (info: {
    index: number;
    averageItemLength: number;
    highestMeasuredFrameIndex?: number;
  }) => void;
}

interface FocusRequest {
  id: string;
  source: ReplyFocusSource;
  /** Monotonic — identifies THIS request, so a re-request for the same id
   *  restarts the machinery instead of being swallowed as a duplicate. */
  token: number;
}

/** How long a request stays open waiting for its row to appear. */
const WINDOW_MS: Record<ReplyFocusSource, number> = {
  deeplink: 10000,
  jump: 3000,
  landing: 3000,
};

/** How long the highlight overlay stays on after a resolve. */
const HIGHLIGHT_MS = 2000;

/** scrollToIndex failures before the request gives up. */
const MAX_RETRIES = 3;

/** Settle time between the fallback offset scroll and the retried index scroll. */
const RETRY_DELAY_MS = 200;

/** Where in the viewport a focused row lands (0 = top, 1 = bottom). */
const VIEW_POSITION = 0.3;

/**
 * Fire-and-forget VoiceOver/TalkBack announcement. Wrapped because this is a
 * native call on a purely cosmetic path: it must never take the screen down.
 */
function announce(message: string): void {
  try {
    AccessibilityInfo.announceForAccessibility(message);
  } catch {
    // no-op
  }
}

export function useReplyFocus<Row extends ReplyFocusRow>({
  listRef,
  rows,
  expandAncestors,
  headerHeight,
}: UseReplyFocusOptions<Row>): ReplyFocusApi {
  const [activeRequest, setActiveRequest] = useState<FocusRequest | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // Mirror, so cancelFocus can no-op when there is nothing to cancel without
  // taking `highlightedId` as a dependency (its identity must stay stable:
  // it is wired straight to the list's onScrollBeginDrag).
  const highlightedIdRef = useRef<string | null>(highlightedId);
  highlightedIdRef.current = highlightedId;

  // Render-synced mirrors. The list callbacks below fire from native layout
  // events and must see the CURRENT rows/request, not the ones captured when
  // the (deliberately stable) callback identity was created.
  const rowsRef = useRef<readonly Row[]>(rows);
  rowsRef.current = rows;
  const activeRequestRef = useRef<FocusRequest | null>(activeRequest);
  activeRequestRef.current = activeRequest;
  const headerHeightRef = useRef(headerHeight);
  headerHeightRef.current = headerHeight;

  const mountedRef = useRef(true);
  const tokenRef = useRef(0);
  /** Token of the request that has already been scrolled to. */
  const resolvedTokenRef = useRef(-1);
  const retryCountRef = useRef(0);
  const windowTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearAllScrollTimeouts = useCallback(() => {
    if (windowTimerRef.current) {
      clearTimeout(windowTimerRef.current);
      windowTimerRef.current = undefined;
    }
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = undefined;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = undefined;
    }
    retryCountRef.current = 0;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearAllScrollTimeouts();
    };
  }, [clearAllScrollTimeouts]);

  const requestFocus = useCallback(
    (id: string, options: { source: ReplyFocusSource }) => {
      if (!id) return;
      // A new request cancels the old one completely — including its highlight,
      // so two rows can never be lit at once.
      clearAllScrollTimeouts();
      const token = ++tokenRef.current;
      const request: FocusRequest = { id, source: options.source, token };
      activeRequestRef.current = request;
      setActiveRequest(request);
      setHighlightedId(null);

      windowTimerRef.current = setTimeout(() => {
        windowTimerRef.current = undefined;
        if (!mountedRef.current) return;
        if (activeRequestRef.current?.token !== token) return;
        // Window over. If it never resolved this is the give-up path; if it did
        // (a landing re-resolve window), it just closes.
        activeRequestRef.current = null;
        setActiveRequest(null);
        if (resolvedTokenRef.current !== token) setHighlightedId(null);
      }, WINDOW_MS[options.source]);
    },
    [clearAllScrollTimeouts],
  );

  const cancelFocus = useCallback(() => {
    if (!activeRequestRef.current && !highlightedIdRef.current) return;
    clearAllScrollTimeouts();
    activeRequestRef.current = null;
    setActiveRequest(null);
    setHighlightedId(null);
  }, [clearAllScrollTimeouts]);

  /** Scroll to `index` and light the row. Shared by the effect and the retry. */
  const scrollTo = useCallback(
    (index: number) => {
      listRef.current?.scrollToIndex({
        index,
        animated: true,
        viewPosition: VIEW_POSITION,
      });
    },
    [listRef],
  );

  // Resolve: keyed on [rows, activeRequest] so a jump to an ALREADY VISIBLE row
  // resolves on the very next commit, without waiting for a content-size event.
  useEffect(() => {
    const request = activeRequest;
    if (!request) return;
    if (resolvedTokenRef.current === request.token) return;

    // A target inside a collapsed branch is not in `rows` at all. Expanding is
    // idempotent, so running it on each attempt is safe and also covers the
    // case where the row only arrives (under a collapsed ancestor) on a later
    // page.
    expandAncestors(request.id);

    const index = rowsRef.current.findIndex((row) => row.reply.id === request.id);
    if (index === -1) return; // Not loaded yet — the window timer owns giving up.

    resolvedTokenRef.current = request.token;
    if (windowTimerRef.current && request.source !== 'landing') {
      // Resolved: stop the give-up timer. A landing request keeps its window,
      // because that window is also its re-resolve window.
      clearTimeout(windowTimerRef.current);
      windowTimerRef.current = undefined;
    }

    scrollTo(index);
    setHighlightedId(request.id);

    // A jump or a deep link moves the list under the user with no other
    // signal; a landing does not need one, because the user just pressed Send
    // and the composer already announced itself. Name only — never an id, and
    // never any body text: this string is spoken aloud.
    if (request.source !== 'landing') {
      const name = rowsRef.current[index]?.reply.authorUsername;
      announce(name ? `Showing reply from ${name}` : 'Showing reply');
    }

    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      highlightTimerRef.current = undefined;
      if (!mountedRef.current) return;
      setHighlightedId((current) => (current === request.id ? null : current));
    }, HIGHLIGHT_MS);
  }, [rows, activeRequest, expandAncestors, scrollTo]);

  const onContentSizeChange = useCallback(() => {
    if (!mountedRef.current) return;
    const request = activeRequestRef.current;
    if (!request || request.source !== 'landing') return;
    if (resolvedTokenRef.current !== request.token) return; // Resolve effect owns it.
    const index = rowsRef.current.findIndex((row) => row.reply.id === request.id);
    if (index === -1) return;
    // The content grew after we scrolled — a gallery or link preview painting
    // above the row pushes it out of view. Re-aim at the same id.
    scrollTo(index);
  }, [scrollTo]);

  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      if (!mountedRef.current) return;
      const request = activeRequestRef.current;
      if (!request) return;

      if (retryCountRef.current >= MAX_RETRIES) {
        clearAllScrollTimeouts();
        activeRequestRef.current = null;
        setActiveRequest(null);
        setHighlightedId(null);
        return;
      }
      retryCountRef.current++;

      // The header is NOT part of averageItemLength * index (VirtualizedList
      // measures cells only), so without it the estimate lands short by a whole
      // original post — which on a media-heavy OP is most of a screen.
      listRef.current?.scrollToOffset({
        offset: headerHeightRef.current + info.averageItemLength * info.index,
        animated: true,
      });

      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = undefined;
        if (!mountedRef.current) return;
        const current = activeRequestRef.current;
        if (!current || current.token !== request.token) return;
        // Re-measure: rows may have shifted while the offset scroll ran, so the
        // index from the failure info is re-derived from the id.
        const index = rowsRef.current.findIndex((row) => row.reply.id === current.id);
        if (index === -1) return;
        scrollTo(index);
      }, RETRY_DELAY_MS);
    },
    [listRef, clearAllScrollTimeouts, scrollTo],
  );

  return {
    requestFocus,
    cancelFocus,
    highlightedId,
    onContentSizeChange,
    onScrollToIndexFailed,
  };
}

/**
 * Build the `expandAncestors` callback from a reply tree, with the identity
 * stability the hook requires: when no ancestor is collapsed the setter returns
 * the SAME Set, React bails out of the update, and the resolve effect does not
 * re-run.
 */
export function makeExpandAncestors<T extends ReplyTreeInput>(
  getTreeById: () => ReadonlyMap<string, ReplyTreeNode<T>> | null,
  setCollapsedIds: (updater: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void,
): (id: string) => void {
  return (id: string) => {
    setCollapsedIds((prev) => {
      if (prev.size === 0) return prev;
      const byId = getTreeById();
      if (!byId) return prev;
      const ancestors = ancestorIds(byId, id);
      if (ancestors.length === 0) return prev;
      let next: Set<string> | null = null;
      for (const ancestorId of ancestors) {
        if (!prev.has(ancestorId)) continue;
        if (!next) next = new Set(prev);
        next.delete(ancestorId);
      }
      return next ?? prev;
    });
  };
}
