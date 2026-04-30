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
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
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
import { loadThread, loadReplies, postReply } from '../services/threadService';
import { Header } from '../components/Header';
import { AsciiDay, AsciiSection } from '../components/AsciiSeparator';
import { ThreadHeader } from './threadDetail/ThreadHeader';
import { ReplyItem } from './threadDetail/ReplyItem';
import { ReplyComposer, type ReplyTarget } from './threadDetail/ReplyComposer';
import type { Reply, Thread } from '../types/store';
import type { ThreadsStackParamList } from '../navigation/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThreadDetailScreenProps = NativeStackScreenProps<
  ThreadsStackParamList,
  'ThreadDetail'
>;

/** A row in the FlatList can be a reply, a day separator, or a section separator */
type DaySeparatorRow = { type: 'day'; label: string; key: string };
type SectionSeparatorRow = { type: 'section'; key: string };
type ReplyRow = { type: 'reply'; reply: Reply; key: string };
type ListRow = DaySeparatorRow | SectionSeparatorRow | ReplyRow;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function getDayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const replyDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );

  if (replyDay.getTime() === today.getTime()) return 'Today';
  if (replyDay.getTime() === yesterday.getTime()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getDayKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Build flat list rows from replies, grouping by day
// ---------------------------------------------------------------------------

function buildListRows(replies: Reply[]): ListRow[] {
  if (replies.length === 0) return [];

  // Replies are already ordered chronologically from the store
  const rows: ListRow[] = [];
  let lastDayKey: string | null = null;
  let groupIndex = 0;

  for (const reply of replies) {
    const dayKey = getDayKey(reply.createdAt);
    if (dayKey !== lastDayKey) {
      if (lastDayKey !== null) {
        rows.push({ type: 'section', key: `section-${groupIndex}` });
        groupIndex++;
      }
      rows.push({
        type: 'day',
        label: getDayLabel(reply.createdAt),
        key: `day-${dayKey}`,
      });
      lastDayKey = dayKey;
    }
    rows.push({ type: 'reply', reply, key: `reply-${reply.id}` });
  }

  return rows;
}

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
  const { threadId, threadTitle } = route.params;

  // Store selectors
  const {
    threads,
    replies: allReplies,
    replyIdsByThread,
    setActiveThread,
  } = useThreads();
  const { userId, username } = useAuth();

  // Local state
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [sending, setSending] = useState(false);

  // Pagination offset (local — not stored in Zustand)
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);

  // The current thread from the store
  const thread: Thread | undefined = threads[threadId];

  // Derive reply list from store — ordered by replyIdsByThread
  const replyList = useMemo((): Reply[] => {
    const ids = replyIdsByThread[threadId] ?? [];
    return ids
      .map((id) => allReplies[id])
      .filter((r): r is Reply => r != null);
  }, [allReplies, replyIdsByThread, threadId]);

  const listRows = useMemo(() => buildListRows(replyList), [replyList]);

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const loadedThread = await loadThread(threadId);
      const result = await loadReplies(
        threadId,
        loadedThread.conversationId,
      );
      offsetRef.current = result.replies.length;
      hasMoreRef.current = result.hasMore;
    } catch (e) {
      if (__DEV__) console.error('[ThreadDetail]', e instanceof Error ? e.message : e);
      setError('Could not load thread');
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  // Mount/unmount lifecycle
  useEffect(() => {
    setActiveThread(threadId);
    fetchData();
    return () => {
      setActiveThread(null);
    };
  }, [threadId, setActiveThread, fetchData]);

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
      // Silently fail — user can scroll again to retry
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
      try {
        const parentReplyId = replyTarget?.replyId ?? null;
        const depth = replyTarget ? replyTarget.depth + 1 : 0;
        await postReply(
          threadId,
          thread.conversationId,
          body,
          parentReplyId,
          depth,
          userId,
          username,
        );
        setReplyTarget(null);
      } catch {
        // Error is reflected in the reply's sync status (shown in UI)
      } finally {
        setSending(false);
      }
    },
    [thread, threadId, userId, username, replyTarget],
  );

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<ListRow>) => {
      switch (item.type) {
        case 'day':
          return <AsciiDay label={item.label} />;
        case 'section':
          return <AsciiSection />;
        case 'reply':
          return (
            <ReplyItem
              replyId={item.reply.id}
              body={item.reply.body}
              authorUsername={item.reply.authorUsername}
              depth={item.reply.depth}
              createdAt={item.reply.createdAt}
              syncStatus={item.reply.syncStatus}
              onPress={handleReplyPress}
            />
          );
      }
    },
    [handleReplyPress],
  );

  const keyExtractor = useCallback((item: ListRow) => item.key, []);

  const listHeader = useMemo(() => {
    if (!thread) return null;
    return (
      <ThreadHeader
        title={thread.title}
        body={thread.body}
        authorUsername={thread.authorUsername}
        createdAt={thread.createdAt}
      />
    );
  }, [thread]);

  const listFooter = useMemo(() => {
    if (loadingMore) {
      return (
        <View style={{ paddingVertical: theme.spacing.base }}>
          <ActivityIndicator color={theme.colors.blue} />
        </View>
      );
    }
    if (replyList.length === 0 && !loading) {
      return <EmptyReplies />;
    }
    return null;
  }, [loadingMore, replyList.length, loading, theme]);

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
    <SafeAreaView
      style={containerStyle}
      edges={['top', 'bottom']}
      testID="thread-detail-screen"
    >
      <Header
        title={thread?.title ?? threadTitle ?? 'Thread'}
        onBack={() => navigation.goBack()}
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {loading && !thread ? (
          <View style={centerStyle}>
            <ActivityIndicator size="large" color={theme.colors.blue} />
          </View>
        ) : error && !thread ? (
          <View style={centerStyle}>
            <Text style={errorTextStyle}>{error}</Text>
          </View>
        ) : (
          <FlatList<ListRow>
            data={listRows}
            keyExtractor={keyExtractor}
            renderItem={renderRow}
            ListHeaderComponent={listHeader}
            ListFooterComponent={listFooter}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                tintColor={theme.colors.blue}
                colors={[theme.colors.blue]}
              />
            }
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.3}
            removeClippedSubviews
            initialNumToRender={20}
            maxToRenderPerBatch={10}
            windowSize={5}
          />
        )}

        <ReplyComposer
          replyTarget={replyTarget}
          onClearReplyTarget={handleClearReplyTarget}
          onSend={handleSend}
          sending={sending}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default ThreadDetailScreen;
