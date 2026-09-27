/**
 * Thread detail screen — shows the original post, nested reply tree, and reply composer.
 *
 * Data flow:
 * - On mount: setActiveThread(threadId), loadThread(), loadReplies()
 * - On unmount: setActiveThread(null)
 * - Reads from store via useThreads() hook
 * - Pull-to-refresh: re-fetches from API
 * - onEndReached: loads next page of replies (pagination)
 *
 * Reply depth coloring follows getReplyDepthColors():
 *   Level 0 = original post (ThreadHeader, white card)
 *   Level 1 = top-level reply (blue 8%, blue border)
 *   Level 2 = nested (purple 8%, purple border)
 *   Level 3 = deeper (blue 12%, blue border)
 *   Level 4+ = deepest (purple 12%, purple border)
 *
 * Indentation: threadIndent.perLevel (24) * Math.min(depth, 4)
 *
 * Deep-link scroll: when `targetReplyId` is passed via route params (from a
 * push notification tap), the list auto-scrolls to and briefly highlights
 * the target reply once content loads.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  Keyboard,
  Platform,
  RefreshControl,
  Text,
  TouchableOpacity,
  View,
  type ListRenderItemInfo,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { useAuth, useThreads } from '../stores';
import { useAppStore } from '../stores/useAppStore';
import {
  loadThread,
  loadReplies,
  postReply,
  hydrateRepliesFromLocal,
  reconcileThreadReplies,
} from '../services/threadService';
import { buildReplyTree, visibleRows, type ParentState } from '../utils/replyTree';
import { isUploadCancellation } from '../services/mediaUploadService';
import {
  classifyCreateFailure,
  dispositionForCreateFailure,
} from '../services/media/uploadCacheDisposition';
import { captureUploadFailure, type PostPipelineStage } from '../services/uploadTelemetry';
import { QuotaExceededError } from '../services/api/errors';
import { updateMediaParent } from '../database/repositories/mediaRepository';
import { useMediaPicker } from '../hooks/useMediaPicker';
import { useMediaUploadProgress } from '../hooks/useMediaUploadProgress';
import { useDiscardUploadGuard } from '../hooks/useDiscardUploadGuard';
import { Header } from '../components/Header';
import { OrbitalKeyboardAvoidingView } from '../components/OrbitalKeyboardAvoidingView';
import { AsciiSection } from '../components/AsciiSeparator';
import { ThreadHeader } from './threadDetail/ThreadHeader';
import { ReplyItem } from './threadDetail/ReplyItem';
import { ReplyComposer, type ReplyTarget } from './threadDetail/ReplyComposer';
import { EmojiPicker } from '../components/EmojiPicker';
import type { Reply, Thread } from '../types/store';
import type { ThreadsStackParamList } from '../navigation/types';
import { useBlockedSet } from '../hooks/useBlockedSet';
import { useIsMuted } from '../hooks/useIsMuted';
import { useMuteActions } from '../hooks/useMuteActions';
import { Emoji } from '../components/Emoji';
import { OrbitalSpinner } from '../components/OrbitalSpinner';
import { PullToRefreshOverlay } from '../components/PullToRefreshOverlay';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { useWebSocketSubscription } from '../hooks/useWebSocketSubscription';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThreadDetailScreenProps = NativeStackScreenProps<
  ThreadsStackParamList,
  'ThreadDetail'
>;

/** A row in the reply FlatList — a reply with its computed tree context */
type ReplyRow = {
  reply: Reply;
  /** Display depth from the tree, never the stored `depth` hint (#821) */
  depth: number;
  parentState: ParentState;
  /** Parent author, carried only when the parent is loaded and visible */
  parentAuthorId: string | null;
  parentAuthorUsername: string | null;
};

/**
 * Follow-up page cap for the zero-new-rows case. A page that adds no rows
 * leaves content length unchanged, so onEndReached will not fire again and
 * pagination would stall; the loop keeps going, but never unbounded.
 */
const MAX_FOLLOW_UP_PAGES = 5;

// ---------------------------------------------------------------------------
// Empty replies state
// ---------------------------------------------------------------------------

function EmptyReplies(): React.JSX.Element {
  const theme = useTheme();
  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    textAlign: 'center',
    marginTop: theme.spacing.lg,
    marginBottom: theme.spacing.md,
  };
  return (
    <View>
      <AsciiSection />
      <Text style={textStyle}>Be the first to reply</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function ThreadDetailScreen({
  route,
  navigation,
}: ThreadDetailScreenProps): React.JSX.Element {
  const theme = useTheme();
  const { threadId, threadTitle, targetReplyId } = route.params;

  // Store selectors
  const {
    threads,
    replies: allReplies,
    replyIdsByThread,
    setActiveThread,
    markThreadViewed,
  } = useThreads();
  const { userId, username } = useAuth();

  // The current thread from the store
  const thread: Thread | undefined = threads[threadId];

  // Subscribe to real-time updates for this thread's conversation
  useWebSocketSubscription(thread?.conversationId ?? null);

  // Per-thread mute (#449) — header bell. Muting only stops PUSH; the thread
  // keeps receiving replies over WebSocket/sync.
  const isMuted = useIsMuted(threadId);
  const { toggleMuteFor } = useMuteActions();
  const handleToggleMute = useCallback(() => {
    toggleMuteFor(threadId, 'thread');
  }, [toggleMuteFor, threadId]);

  const blockedSet = useBlockedSet();

  // This thread's replies, in store (insertion) order. That order is NOT the
  // display order — replyTree.ts derives that below (#821).
  const threadReplies = useMemo((): Reply[] => {
    const ids = replyIdsByThread[threadId] ?? [];
    return ids.map((id) => allReplies[id]).filter((r): r is Reply => r != null);
  }, [allReplies, replyIdsByThread, threadId]);

  const replyRows = useMemo((): ReplyRow[] => {
    try {
      const { nodes } = buildReplyTree(threadReplies);
      return visibleRows(nodes, { hiddenAuthorIds: blockedSet }).map((row) => {
        // Only a 'jumpable' parent may be named: 'hidden' means the author is
        // blocked, and naming them would put a blocked username back on screen.
        const parent =
          row.parentState === 'jumpable' && row.parentId
            ? allReplies[row.parentId]
            : undefined;
        return {
          reply: row.reply,
          depth: row.depth,
          parentState: row.parentState,
          parentAuthorId: parent?.authorId ?? null,
          parentAuthorUsername: parent?.authorUsername ?? null,
        };
      });
    } catch {
      // The tree functions are total, so this should be unreachable — but the
      // app has no ErrorBoundary, and a wrong ORDER is survivable where a blank
      // thread screen is not. Degrade to flat store order, naming no parent.
      const visible =
        blockedSet.size > 0
          ? threadReplies.filter((r) => !blockedSet.has(r.authorId))
          : threadReplies;
      return visible.map((r) => ({
        reply: r,
        depth: 0,
        parentState: (r.parentReplyId ? 'orphan' : 'none') as ParentState,
        parentAuthorId: null,
        parentAuthorUsername: null,
      }));
    }
  }, [threadReplies, allReplies, blockedSet]);

  // Local state
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { scrollY, scrollProps } = usePullToRefresh();
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [sending, setSending] = useState(false);
  const { selectedMedia, pickMedia, removeMedia, clearMedia } = useMediaPicker();
  const {
    progress: uploadProgress,
    cancel: cancelUpload,
    uploadBatch,
    releaseUploadCache,
    hasUnsentUpload,
  } = useMediaUploadProgress();
  const uploading = uploadProgress != null;

  // #722: leaving mid-upload aborts it, and leaving after a failed send strands
  // media that only this screen session can still attach. Both get a confirm.
  const handleDiscardUpload = useCallback(() => {
    cancelUpload();
    // The user said the reply is not happening, so any ids the cache still
    // holds are rolled back rather than left as FileLibrary ghosts (#724b).
    releaseUploadCache('discard');
  }, [cancelUpload, releaseUploadCache]);

  useDiscardUploadGuard({
    uploading: uploadProgress != null && !uploadProgress.cancelling,
    // Only while media is still selected (clearing the strip after a failed
    // send leaves nothing the prompt could be about), and never while a send is
    // in flight. `hasUnsentUpload` turns true the moment the batch lands, i.e.
    // BEFORE the unabortable create call; and on success releaseUploadCache()'s
    // setState is not yet committed when a navigation dispatches, while
    // usePreventRemove reads the last COMMITTED render. `sending` is still true on
    // that frame, so gating on it keeps the guard off the composer's own
    // success navigation (PR #839 review). The finally flips it false after a
    // failure, so the post-failure state still arms.
    unsent: hasUnsentUpload && selectedMedia.length > 0 && !sending,
    noun: 'reply',
    onDiscard: handleDiscardUpload,
  });

  // Live view of the selection for the hook's post-batch id filter — the batch
  // holds the array captured at call time, so an item removed mid-upload must
  // not end up attached to the reply.
  const selectedMediaRef = useRef(selectedMedia);
  useEffect(() => {
    selectedMediaRef.current = selectedMedia;
  }, [selectedMedia]);

  // Composer text — lifted here so EmojiPicker can insert into it
  const [composerText, setComposerText] = useState('');

  // Emoji picker state
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  /** Whether we are waiting for keyboard to hide before showing the picker */
  const pendingPickerShow = useRef(false);

  // Pagination state (local — not stored in Zustand). Offsets count RAW server
  // rows, never decrypted ones: a row that fails to decrypt still occupies a
  // slot in the server's window, so counting decrypted rows drifts and skips.
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  /** Raw server ids seen in the CURRENT pass — the reconcile keep-set. */
  const serverIdsSeenRef = useRef<Set<string>>(new Set());
  /**
   * Reply ids that existed when the current pass STARTED — the only ids the
   * reconcile may delete. A WebSocket reply or the user's own confirmed send
   * that lands mid-pass is newer than the server snapshot the pass compares
   * against, so it is not evidence of a removal and must survive.
   */
  const candidatesRef = useRef<Set<string>>(new Set());
  /** Rows covered contiguously from offset 0 in the current pass. */
  const coveredRef = useRef(0);
  /**
   * False once a page is fetched at an offset beyond what this pass has
   * covered (the refresh high-water jump). Such a pass has a HOLE in it, so
   * its id set is not a complete picture and must never drive a reconcile —
   * that would delete the rows sitting in the hole.
   */
  const passContiguousRef = useRef(true);

  // ---------------------------------------------------------------------------
  // Deep-link scroll + highlight
  // ---------------------------------------------------------------------------

  const listRef = useRef<FlatList<ReplyRow>>(null);
  const highlightRef = useRef<string | null>(targetReplyId ?? null);
  const scrollAttemptedRef = useRef(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const highlightClearRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryClearRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryCountRef = useRef(0);
  const mountedRef = useRef(true);
  const workingTargetRef = useRef<string | null>(null);
  const [highlightTick, setHighlightTick] = useState(0);

  // Centralized cleanup — cancels all pending scroll/highlight timeouts
  const clearAllScrollTimeouts = useCallback(() => {
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = undefined;
    }
    if (highlightClearRef.current) {
      clearTimeout(highlightClearRef.current);
      highlightClearRef.current = undefined;
    }
    if (retryClearRef.current) {
      clearTimeout(retryClearRef.current);
      retryClearRef.current = undefined;
    }
    retryCountRef.current = 0;
  }, []);

  // Deep-link scroll: capture targetReplyId into workingTargetRef and set up
  // a safety timeout. Uses scrollAttemptedRef as the idempotency guard —
  // does NOT call navigation.setParams to avoid circular dependency.
  useEffect(() => {
    if (!targetReplyId || scrollAttemptedRef.current) return;

    // Capture into working ref for timeout/callback use
    clearAllScrollTimeouts();
    workingTargetRef.current = targetReplyId;
    highlightRef.current = targetReplyId;
    scrollAttemptedRef.current = false;
    retryCountRef.current = 0;
    setHighlightTick(n => n + 1);

    // Safety timeout: give up after 10s
    scrollTimeoutRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      workingTargetRef.current = null;
      scrollAttemptedRef.current = true;
      highlightRef.current = null;
      setHighlightTick(n => n + 1);
    }, 10000);

    return () => {
      clearAllScrollTimeouts();
      scrollAttemptedRef.current = false;
    };
  }, [targetReplyId, clearAllScrollTimeouts]);

  const handleContentSizeChange = useCallback(() => {
    if (!mountedRef.current) return;
    const target = workingTargetRef.current;
    if (!target || scrollAttemptedRef.current || !listRef.current) return;
    const idx = replyRows.findIndex(r => r.reply.id === target);
    if (idx === -1) return;

    scrollAttemptedRef.current = true;
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = undefined;

    listRef.current.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 });

    // Trigger highlight and clear after 2 seconds
    highlightRef.current = target;
    setHighlightTick(n => n + 1);
    highlightClearRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      highlightRef.current = null;
      workingTargetRef.current = null;
      setHighlightTick(n => n + 1);
    }, 2000);
  }, [replyRows]);

  const handleScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      if (!mountedRef.current) return;
      if (retryCountRef.current >= 3) {
        workingTargetRef.current = null;
        scrollAttemptedRef.current = true;
        highlightRef.current = null;
        setHighlightTick(n => n + 1);
        return;
      }
      retryCountRef.current++;

      listRef.current?.scrollToOffset({
        offset: info.averageItemLength * info.index,
        animated: true,
      });

      // Clear previous retry timeout before setting new one
      if (retryClearRef.current) clearTimeout(retryClearRef.current);
      retryClearRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        listRef.current?.scrollToIndex({
          index: info.index,
          animated: true,
          viewPosition: 0.3,
        });
      }, 200);
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Keyboard coordination
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
      // Don't hide picker here — the search TextInput inside the picker
      // also triggers keyboardWillShow. The composer's onFocus callback
      // (handleInputFocus) is the correct path to dismiss the picker.
      pendingPickerShow.current = false;
    });

    const hideSub = Keyboard.addListener(hideEvent, () => {
      // If we dismissed the keyboard to show the picker, now show it
      if (pendingPickerShow.current) {
        pendingPickerShow.current = false;
        setShowEmojiPicker(true);
      }
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const handleToggleEmojiPicker = useCallback(() => {
    if (showEmojiPicker) {
      // Hide picker
      setShowEmojiPicker(false);
    } else {
      // Show picker — dismiss keyboard first if it's up
      if (keyboardHeight > 0) {
        pendingPickerShow.current = true;
        Keyboard.dismiss();
      } else {
        setShowEmojiPicker(true);
      }
    }
  }, [showEmojiPicker, keyboardHeight]);

  const handleInputFocus = useCallback(() => {
    // When user taps into TextInput, hide picker (keyboard will show via showEvent)
    setShowEmojiPicker(false);
    pendingPickerShow.current = false;
  }, []);

  const handleEmojiSelect = useCallback((native: string) => {
    setComposerText((prev) => prev + native);
  }, []);

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  /** Thread the pagination refs belong to — a params-in-place navigate to
   *  another thread keeps this screen (and its refs) mounted. */
  const paginationThreadRef = useRef(threadId);

  /** Start a fresh pagination pass: the keep-set only spans one pass. */
  const beginPaginationPass = useCallback(() => {
    if (paginationThreadRef.current !== threadId) {
      // Different thread: the high-water offset would otherwise skip straight
      // past the new thread's first pages.
      paginationThreadRef.current = threadId;
      offsetRef.current = 0;
      hasMoreRef.current = true;
    }
    serverIdsSeenRef.current = new Set();
    // Read from the store, not from the render-time selector value: this runs
    // inside an async load, where the captured value may already be a frame old.
    candidatesRef.current = new Set(
      useAppStore.getState().replyIdsByThread?.[threadId] ?? [],
    );
    coveredRef.current = 0;
    passContiguousRef.current = true;
  }, [threadId]);

  /**
   * Fold one page into the pagination state.
   *
   * - The offset advances by RAW rows, as a high-water mark, so a refresh does
   *   not re-download the pages already loaded.
   * - `rawCount === 0` ends the pass: the server has nothing at this offset.
   * - When the pass ends AND it was contiguous, its accumulated raw ids are a
   *   complete picture of the thread, so anything else in the store was removed
   *   server-side and is reconciled away (store + SQLite + FTS).
   */
  const applyRepliesPage = useCallback(
    (
      offsetUsed: number,
      result: { rawCount: number; serverIds: string[]; hasMore: boolean },
    ) => {
      for (const id of result.serverIds) serverIdsSeenRef.current.add(id);

      if (offsetUsed <= coveredRef.current) {
        coveredRef.current = Math.max(coveredRef.current, offsetUsed + result.rawCount);
      } else {
        passContiguousRef.current = false;
      }

      offsetRef.current = Math.max(offsetRef.current, offsetUsed + result.rawCount);
      hasMoreRef.current = result.hasMore && result.rawCount > 0;

      // paginationThreadRef guards the in-place thread switch: a page that
      // resolves after the screen re-pointed at another thread must not
      // reconcile the new thread against the old thread's ids.
      if (
        !hasMoreRef.current &&
        passContiguousRef.current &&
        paginationThreadRef.current === threadId
      ) {
        try {
          reconcileThreadReplies(
            threadId,
            serverIdsSeenRef.current,
            candidatesRef.current,
          );
        } catch (e) {
          if (__DEV__) console.warn('[ThreadDetail] reconcile failed:', e instanceof Error ? e.message : e);
        }
      }
    },
    [threadId],
  );

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const loadedThread = await loadThread(threadId);
      try {
        beginPaginationPass();
        const result = await loadReplies(
          threadId,
          loadedThread.conversationId,
        );
        applyRepliesPage(0, result);
      } catch (e) {
        if (__DEV__) console.warn('[ThreadDetail] replies failed:', e instanceof Error ? e.message : e);
        hasMoreRef.current = false;
      }
    } catch (e) {
      if (__DEV__) console.warn('[ThreadDetail]', e instanceof Error ? e.message : e);
      setError('Could not load thread');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [threadId, beginPaginationPass, applyRepliesPage]);

  // Mount/unmount lifecycle
  useEffect(() => {
    mountedRef.current = true;
    setActiveThread(threadId);
    markThreadViewed(threadId);
    // Instant hydration from local SQLCipher cache before async API fetch
    hydrateRepliesFromLocal(threadId);
    fetchData();
    return () => {
      mountedRef.current = false;
      clearAllScrollTimeouts();
      // Mark viewed again on cleanup — captures replies streamed while reading
      markThreadViewed(threadId);
      setActiveThread(null);
    };
  }, [threadId, setActiveThread, markThreadViewed, fetchData, clearAllScrollTimeouts]);

  // Track which conversation the user is viewing (for foreground push suppression)
  const conversationId = thread?.conversationId;
  useEffect(() => {
    if (conversationId) {
      useAppStore.getState().setViewingConversation(conversationId);
    }
    return () => {
      useAppStore.getState().setViewingConversation(null);
    };
  }, [conversationId]);

  // Pull-to-refresh
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const loadedThread = await loadThread(threadId);
      beginPaginationPass();
      const result = await loadReplies(threadId, loadedThread.conversationId);
      applyRepliesPage(0, result);
    } catch {
      // Silently fail on refresh — stale data is still visible
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [threadId, beginPaginationPass, applyRepliesPage]);

  // Pagination — load more replies
  const handleEndReached = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current || !conversationId) {
      return;
    }
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      for (let page = 0; page < MAX_FOLLOW_UP_PAGES; page++) {
        const offsetUsed = offsetRef.current;
        const result = await loadReplies(
          threadId,
          conversationId,
          offsetUsed > 0 ? offsetUsed : undefined,
        );
        applyRepliesPage(offsetUsed, result);
        // Stop at the end of the thread, or as soon as the list actually grew:
        // new rows extend the content, so onEndReached fires again on its own.
        // A page of nothing but already-known (or undecryptable) rows does not,
        // which is what this loop exists to get past.
        if (!hasMoreRef.current || result.newIdCount > 0) break;
        if (!mountedRef.current) break;
      }
    } catch {
      hasMoreRef.current = false;
    } finally {
      loadingMoreRef.current = false;
      if (mountedRef.current) setLoadingMore(false);
    }
  }, [threadId, conversationId, applyRepliesPage]);

  // ---------------------------------------------------------------------------
  // Reply handling
  // ---------------------------------------------------------------------------

  const handleReplyPress = useCallback(
    (replyId: string, authorUsername: string, depth: number) => {
      // LOAD-BEARING: a FRESH object every press. ReplyComposer keys its
      // focus effect on replyTarget identity, so memoizing or reusing the
      // object here would silently stop the composer re-focusing when the
      // same row's arrow is pressed again after the keyboard was dismissed.
      setReplyTarget({ replyId, authorUsername, depth });
    },
    [],
  );

  const handleClearReplyTarget = useCallback(() => {
    setReplyTarget(null);
  }, []);

  const handleSend = useCallback(
    async (body: string) => {
      if (!thread || !userId || !username) return;
      // #745: DM vs orbit discriminator for post-failure telemetry. Tri-state:
      // undefined (tag omitted) when the conversation is not in the store, so
      // dm:'false' always means "known orbit", never "unknown".
      const conversation = useAppStore.getState().conversations[thread.conversationId];
      const dm = conversation ? conversation.type === 'direct' : undefined;
      setSending(true);
      setShowEmojiPicker(false);
      // Which half of the send failed — reported as the Sentry `stage` tag so a
      // release event separates a media-pipeline failure from a postReply
      // failure without symbolicated frames (#738).
      let stage: PostPipelineStage = 'media-upload';
      try {
        let mediaIds: string[] | undefined;
        if (selectedMedia.length > 0) {
          // scopeKey = threadId: a params-in-place navigate to another thread
          // keeps this screen mounted, and those ids belong to the old thread.
          mediaIds = await uploadBatch(
            selectedMedia,
            thread.conversationId,
            () => selectedMediaRef.current,
            threadId,
          );
        } else {
          // Nothing attached: any held ids are from an abandoned send, so they
          // are rolled back, not just forgotten (#724b).
          releaseUploadCache('discard');
        }
        const parentReplyId = replyTarget?.replyId ?? null;
        const depth = replyTarget ? replyTarget.depth + 1 : 0;
        stage = 'reply-create';
        const reply = await postReply(
          threadId,
          thread.conversationId,
          body,
          parentReplyId,
          depth,
          { authorId: userId, authorUsername: username },
          mediaIds ? { mediaIds } : undefined,
        );

        // The ids are attached now, so the reuse cache must not survive into
        // the next send (mount-guarded inside the hook).
        releaseUploadCache('attached');

        // Reset composer immediately on successful post
        if (mountedRef.current) {
          setComposerText('');
          clearMedia();
          setReplyTarget(null);
        }

        // Best-effort: update local media rows with confirmed reply/thread IDs
        if (mediaIds && mediaIds.length > 0) {
          for (const mid of mediaIds) {
            try {
              updateMediaParent(mid, threadId, reply.id);
            } catch (e) {
              captureUploadFailure(e, {
                stage: 'local-commit',
                surface: 'thread-reply',
                level: 'warning',
                dm,
              });
            }
          }
        }
      } catch (e) {
        // A self-cancel raises no Alert. The composer text, the selected media
        // and the reply target are all left untouched (the reset block above
        // runs on the success path only), so the user can just send again.
        if (isUploadCancellation(e)) {
          if (__DEV__) console.warn('[Reply] upload cancelled by user');
        } else {
          captureUploadFailure(e, { stage, surface: 'thread-reply', dm });
          // One classification drives both the cache and the alert, so the two
          // can never disagree about whether the reply may exist. Stage-gated:
          // a media-stage failure never reached postReply, and the backend maps
          // every unique-key violation to 409, so only a create-stage error
          // carries this meaning.
          const verdict = stage === 'reply-create' ? classifyCreateFailure(e) : 'no';
          // Cache state, not screen state -- deliberately outside the mounted
          // block below. 'committed'/'maybe-committed' flag the cached ids so a
          // later Discard does not roll back media that is in fact on a reply;
          // a 'no' verdict keeps the cache too, it simply stays
          // rollback-eligible (#724b).
          const disposition = dispositionForCreateFailure(verdict);
          if (disposition) {
            releaseUploadCache(disposition);
          }
          // Telemetry above fires unconditionally; the alerts must not —
          // postReply is not abortable, so a rejection can land after the user
          // navigated away, and an unguarded Alert pops over whatever screen
          // they're on now (panel finding, PR #744).
          if (mountedRef.current) {
            if (e instanceof QuotaExceededError) {
              Alert.alert('Upload Failed', e.message);
            } else if (verdict !== 'no') {
              // The send may have landed: a 409 is near-proof of it, and a
              // network or 5xx failure leaves it genuinely unknown. Never
              // invite a blind retry here -- the cache is deliberately kept so
              // a repeat press draws another 409 instead of posting a
              // duplicate.
              Alert.alert(
                'Reply May Have Been Sent',
                'Your reply may already have been sent. Pull to refresh before sending again.',
              );
            } else {
              // Every remaining failure (a local-pipeline error, a 4xx the
              // server rejected outright) used to just stop the spinner,
              // leaving the user unsure whether the reply went out (#612). The
              // draft, media and reply target all survive (the reset block runs
              // on the success path only), so this is signal, not recovery.
              Alert.alert('Reply Failed', 'Failed to send your reply. Please try again.');
            }
          }
          if (__DEV__) console.warn('[Reply] failed:', e instanceof Error ? e.message : e);
        }
      } finally {
        if (mountedRef.current) setSending(false);
      }
    },
    [thread, threadId, userId, username, replyTarget, selectedMedia, clearMedia, uploadBatch, releaseUploadCache],
  );

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<ReplyRow>) => {
      return (
        <ReplyItem
          replyId={item.reply.id}
          body={item.reply.body}
          authorUsername={item.reply.authorUsername}
          authorId={item.reply.authorId}
          groupId={thread?.conversationId ?? null}
          currentUserId={userId}
          depth={item.depth}
          createdAt={item.reply.createdAt}
          syncStatus={item.reply.syncStatus}
          parentState={item.parentState}
          parentAuthorId={item.parentAuthorId}
          parentAuthorUsername={item.parentAuthorUsername}
          onReplyPress={handleReplyPress}
          isHighlighted={highlightRef.current === item.reply.id}
        />
      );
    },
    [handleReplyPress, userId, thread?.conversationId],
  );

  const keyExtractor = useCallback((item: ReplyRow) => item.reply.id, []);

  const listHeader = useMemo(() => {
    if (!thread) return null;
    return (
      <ThreadHeader
        threadId={threadId}
        title={thread.title}
        body={thread.body}
        authorUsername={thread.authorUsername}
        authorId={thread.authorId}
        groupId={thread.conversationId}
        currentUserId={userId}
        createdAt={thread.createdAt}
      />
    );
  }, [thread, threadId, userId]);

  const listFooter = useMemo(() => {
    if (loadingMore) {
      return (
        <View style={{ paddingVertical: theme.spacing.base }}>
          <OrbitalSpinner size={20} />
        </View>
      );
    }
    if (replyRows.length === 0 && !loading && !refreshing) {
      return <EmptyReplies />;
    }
    return null;
  }, [loadingMore, replyRows.length, loading, refreshing, theme]);

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const centerStyle: ViewStyle = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  };

  const errorTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.error,
    textAlign: 'center',
    padding: theme.spacing.lg,
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <View style={containerStyle} testID="thread-detail-screen">
      <SafeAreaView edges={['top']} style={{ backgroundColor: theme.colors.background }}>
        <Header
          title={thread?.title || threadTitle || 'Thread'}
          onBack={() => navigation.goBack()}
          right={
            <TouchableOpacity
              onPress={handleToggleMute}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel={isMuted ? 'Unmute this thread' : 'Mute this thread'}
              accessibilityState={{ selected: isMuted }}
              testID="thread-mute-bell"
            >
              <Emoji unified={isMuted ? '1F515' : '1F514'} size={20} />
            </TouchableOpacity>
          }
        />
      </SafeAreaView>

      <OrbitalKeyboardAvoidingView keyboardVerticalOffset={0}>
        {loading && !thread ? (
          <View style={centerStyle}>
            <OrbitalSpinner size={32} />
          </View>
        ) : error && !thread ? (
          <View style={centerStyle}>
            <Text style={errorTextStyle}>{error}</Text>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <PullToRefreshOverlay scrollY={scrollY} refreshing={refreshing} />
            <Animated.FlatList
              ref={listRef as React.RefObject<FlatList<ReplyRow>>}
              style={{ flex: 1 }}
              data={replyRows}
              keyExtractor={keyExtractor}
              renderItem={renderRow}
              ListHeaderComponent={listHeader}
              ListFooterComponent={listFooter}
              contentContainerStyle={{ flexGrow: 1 }}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={handleRefresh}
                  tintColor="transparent"
                />
              }
              {...scrollProps}
              onEndReached={handleEndReached}
              onEndReachedThreshold={0.3}
              onContentSizeChange={handleContentSizeChange}
              // NO maintainVisibleContentPosition here, deliberately. Tree order
              // does insert mid-list, but RN 0.82.1's VirtualizedList adds +1 to
              // minIndexForVisible whenever a ListHeaderComponent exists, so even
              // minIndexForVisible: 0 anchors on the FIRST REPLY, not on offset 0.
              // ThreadHeader grows after its first layout (LinkPreviewCard and
              // MediaGallery load late), and the anchor then scrolls the original
              // post off screen on open — a worse bug than the one this would fix.
              // Revisit only with on-device verification (#821).
              onScrollToIndexFailed={handleScrollToIndexFailed}
              extraData={highlightTick}
              initialNumToRender={20}
              maxToRenderPerBatch={10}
              windowSize={5}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
            />
          </View>
        )}

        <ReplyComposer
          replyTarget={replyTarget}
          onClearReplyTarget={handleClearReplyTarget}
          onSend={handleSend}
          sending={sending || uploading}
          text={composerText}
          onChangeText={setComposerText}
          media={selectedMedia}
          onPickMedia={pickMedia}
          onRemoveMedia={removeMedia}
          showEmojiPicker={showEmojiPicker}
          onToggleEmojiPicker={handleToggleEmojiPicker}
          onInputFocus={handleInputFocus}
          uploadProgress={uploadProgress}
          onCancelUpload={cancelUpload}
        />
        <EmojiPicker
          visible={showEmojiPicker}
          onSelectEmoji={handleEmojiSelect}
          height={keyboardHeight > 0 ? keyboardHeight : 300}
        />
      </OrbitalKeyboardAvoidingView>
    </View>
  );
}

export default ThreadDetailScreen;
