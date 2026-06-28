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
  Animated,
  FlatList,
  Keyboard,
  Platform,
  RefreshControl,
  Text,
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
import { loadThread, loadReplies, postReply, hydrateRepliesFromLocal } from '../services/threadService';
import { uploadMediaBatch } from '../services/mediaUploadService';
import { updateMediaParent } from '../database/repositories/mediaRepository';
import { useMediaPicker } from '../hooks/useMediaPicker';
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

/** A row in the reply FlatList — a reply with parent context for display */
type ReplyRow = {
  reply: Reply;
  parentAuthorId: string | null;
  parentAuthorUsername: string | null;
  key: string;
};

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

  const blockedSet = useBlockedSet();

  // Derive reply list from store — ordered by replyIdsByThread, excluding blocked users
  const replyList = useMemo((): Reply[] => {
    const ids = replyIdsByThread[threadId] ?? [];
    const list = ids
      .map((id) => allReplies[id])
      .filter((r): r is Reply => r != null);
    return blockedSet.size > 0 ? list.filter((r) => !blockedSet.has(r.authorId)) : list;
  }, [allReplies, replyIdsByThread, threadId, blockedSet]);

  const replyRows = useMemo((): ReplyRow[] => {
    return replyList.map((r) => {
      const parent = r.parentReplyId ? allReplies[r.parentReplyId] : undefined;
      return {
        reply: r,
        parentAuthorId: parent?.authorId ?? null,
        parentAuthorUsername: parent?.authorUsername ?? null,
        key: `reply-${r.id}`,
      };
    });
  }, [replyList, allReplies]);

  // Local state
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { scrollY, scrollProps } = usePullToRefresh();
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [sending, setSending] = useState(false);
  const { selectedMedia, pickPhotos, removeMedia, clearMedia } = useMediaPicker();
  const [uploading, setUploading] = useState(false);

  // Composer text — lifted here so EmojiPicker can insert into it
  const [composerText, setComposerText] = useState('');

  // Emoji picker state
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  /** Whether we are waiting for keyboard to hide before showing the picker */
  const pendingPickerShow = useRef(false);

  // Pagination offset (local — not stored in Zustand)
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);

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

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const loadedThread = await loadThread(threadId);
      try {
        const result = await loadReplies(
          threadId,
          loadedThread.conversationId,
        );
        offsetRef.current = result.replies.length;
        hasMoreRef.current = result.hasMore;
      } catch (e) {
        if (__DEV__) console.warn('[ThreadDetail] replies failed:', e instanceof Error ? e.message : e);
        hasMoreRef.current = false;
      }
    } catch (e) {
      if (__DEV__) console.warn('[ThreadDetail]', e instanceof Error ? e.message : e);
      setError('Could not load thread');
    } finally {
      setLoading(false);
    }
  }, [threadId]);

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
      const result = await loadReplies(threadId, loadedThread.conversationId);
      offsetRef.current = result.replies.length;
      hasMoreRef.current = result.hasMore;
    } catch {
      // Silently fail on refresh — stale data is still visible
    } finally {
      setRefreshing(false);
    }
  }, [threadId]);

  // Pagination — load more replies
  const handleEndReached = useCallback(async () => {
    if (loadingMore || !hasMoreRef.current || !thread) {
      return;
    }
    setLoadingMore(true);
    try {
      const result = await loadReplies(
        threadId,
        thread.conversationId,
        offsetRef.current,
      );
      offsetRef.current += result.replies.length;
      hasMoreRef.current = result.hasMore;
    } catch {
      hasMoreRef.current = false;
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, thread, threadId]);

  // ---------------------------------------------------------------------------
  // Reply handling
  // ---------------------------------------------------------------------------

  const handleReplyPress = useCallback(
    (replyId: string, authorUsername: string, depth: number) => {
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
      setSending(true);
      setShowEmojiPicker(false);
      try {
        let mediaIds: string[] | undefined;
        if (selectedMedia.length > 0) {
          setUploading(true);
          try {
            mediaIds = await uploadMediaBatch(selectedMedia, thread.conversationId);
          } finally {
            setUploading(false);
          }
        }
        const parentReplyId = replyTarget?.replyId ?? null;
        const depth = replyTarget ? replyTarget.depth + 1 : 0;
        const reply = await postReply(
          threadId,
          thread.conversationId,
          body,
          parentReplyId,
          depth,
          { authorId: userId, authorUsername: username },
          mediaIds ? { mediaIds } : undefined,
        );

        // Update local media rows with the confirmed reply/thread IDs
        // so the file library orbit filter can resolve conversation_id
        if (mediaIds && mediaIds.length > 0) {
          for (const mid of mediaIds) {
            updateMediaParent(mid, threadId, reply.id);
          }
        }

        setComposerText('');
        clearMedia();
        setReplyTarget(null);
      } catch (e) {
        if (__DEV__) console.warn('[Reply] failed:', e instanceof Error ? e.message : e);
      } finally {
        setSending(false);
      }
    },
    [thread, threadId, userId, username, replyTarget, selectedMedia, clearMedia],
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
          depth={item.reply.depth}
          createdAt={item.reply.createdAt}
          syncStatus={item.reply.syncStatus}
          parentAuthorId={item.parentAuthorId}
          parentAuthorUsername={item.parentAuthorUsername}
          onPress={handleReplyPress}
          isHighlighted={highlightRef.current === item.reply.id}
        />
      );
    },
    [handleReplyPress, userId, thread?.conversationId],
  );

  const keyExtractor = useCallback((item: ReplyRow) => item.key, []);

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
    if (replyList.length === 0 && !loading && !refreshing) {
      return <EmptyReplies />;
    }
    return null;
  }, [loadingMore, replyList.length, loading, refreshing, theme]);

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
          onPickMedia={pickPhotos}
          onRemoveMedia={removeMedia}
          showEmojiPicker={showEmojiPicker}
          onToggleEmojiPicker={handleToggleEmojiPicker}
          onInputFocus={handleInputFocus}
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
