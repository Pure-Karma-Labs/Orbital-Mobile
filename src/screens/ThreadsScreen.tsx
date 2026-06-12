/**
 * Threads inbox screen — orbit selector, search bar, day-grouped thread list.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  Animated,
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
import { useAppStore, useThreads, useConversations, useConnection } from '../stores';
import type { Thread } from '../types/store';
import type { ThreadsStackParamList } from '../navigation/types';
import { Button } from '../components/Button';
import { AsciiDay, AsciiSection } from '../components/AsciiSeparator';
import { OrbitBar } from './threads/OrbitBar';
import { SearchBar } from './threads/SearchBar';
import { ThreadItem } from './threads/ThreadItem';
import { OnboardingEmptyState } from './threads/OnboardingEmptyState';
import { loadThreadsForGroup } from '../services/threadService';
import { markConversationReadEverywhere } from '../services/conversationService';
import { PullToRefreshOverlay } from '../components/PullToRefreshOverlay';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { useWebSocketSubscription } from '../hooks/useWebSocketSubscription';
import { useBlockedSet } from '../hooks/useBlockedSet';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThreadsScreenProps = NativeStackScreenProps<
  ThreadsStackParamList,
  'ThreadsList'
>;

/** A row in the FlatList can be a thread, a day separator, or a section separator */
type DaySeparatorRow = { type: 'day'; label: string; key: string };
type SectionSeparatorRow = { type: 'section'; key: string };
type ThreadRow = { type: 'thread'; thread: Thread; key: string };
type ListRow = DaySeparatorRow | SectionSeparatorRow | ThreadRow;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function getDayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const threadDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (threadDay.getTime() === today.getTime()) {
    return 'Today';
  }
  if (threadDay.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getDayKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Compute per-thread unread state.
 *
 * A thread is 'unread' when its latest activity (createdAt or lastReplyAt) is
 * more recent than both:
 *   - the user's last view of that specific thread (threadLastViewedAt)
 *   - the server-side lastReadAt watermark for the conversation (snapshot)
 *
 * The lastReadAt snapshot MUST be captured once on focus and held as a ref
 * for the entire focus session. Reading it live would cause the debounced
 * markConversationReadEverywhere to flip all threads to 'read' seconds later.
 *
 * Exported for unit testing.
 */
export function getThreadState(
  thread: Thread,
  threadLastViewedAt: Record<string, number>,
  lastReadAtSnapshot: number | null,
): 'read' | 'active' | 'unread' {
  const threadActivity = Math.max(thread.createdAt, thread.lastReplyAt ?? 0);
  const viewedAt = threadLastViewedAt[thread.id] ?? 0;
  const watermark = Math.max(viewedAt, lastReadAtSnapshot ?? 0);

  if (threadActivity > watermark) {
    return 'unread';
  }
  return 'read';
}

// ---------------------------------------------------------------------------
// Build flat list rows from threads, grouping by day
// ---------------------------------------------------------------------------

function buildListRows(threads: Thread[]): ListRow[] {
  if (threads.length === 0) {
    return [];
  }

  // Sort by createdAt descending (newest first) — already ordered by store but enforce it
  const sorted = [...threads].sort((a, b) => b.createdAt - a.createdAt);

  const rows: ListRow[] = [];
  let lastDayKey: string | null = null;
  let groupIndex = 0;

  for (const thread of sorted) {
    const dayKey = getDayKey(thread.createdAt);
    if (dayKey !== lastDayKey) {
      // Insert section separator between day groups (not before first group)
      if (lastDayKey !== null) {
        rows.push({ type: 'section', key: `section-${groupIndex}` });
        groupIndex++;
      }
      rows.push({
        type: 'day',
        label: getDayLabel(thread.createdAt),
        key: `day-${dayKey}`,
      });
      lastDayKey = dayKey;
    }
    rows.push({ type: 'thread', thread, key: `thread-${thread.id}` });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ onCompose }: { onCompose: () => void }): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xl,
  };

  const boxStyle: ViewStyle = {
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing.lg,
    alignItems: 'center',
    width: '100%',
    maxWidth: 300,
  };

  const topBorderStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textTertiary,
    marginBottom: theme.spacing.md,
  };

  const messageStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
  };

  return (
    <View style={containerStyle}>
      <View style={boxStyle}>
        <Text style={topBorderStyle}>{'┌─────────────────────┐'}</Text>
        <Text style={messageStyle}>
          {'No threads yet\nCreate your first! ✦'}
        </Text>
        <Text style={topBorderStyle}>{'└─────────────────────┘'}</Text>
        <Button title="New Thread" onPress={onCompose} variant="primary" />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Connection status indicator
// ---------------------------------------------------------------------------

function ConnectionStatusBanner({
  theme,
}: {
  theme: ReturnType<typeof useTheme>;
}): React.JSX.Element {
  const bannerStyle: ViewStyle = {
    backgroundColor: theme.colors.warning ?? theme.colors.borderSubtle,
    paddingVertical: theme.spacing.xs,
    paddingHorizontal: theme.spacing.base,
    alignItems: 'center',
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textPrimary,
  };

  return (
    <View style={bannerStyle}>
      <Text style={textStyle}>Reconnecting...</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function ThreadsScreen({ navigation }: ThreadsScreenProps): React.JSX.Element {
  const theme = useTheme();
  const { threads, threadIdsByConversation, threadLastViewedAt, activeConversationId, conversations } =
    useThreadsAndConversation();
  const { connectionStatus } = useConnection();
  const [refreshing, setRefreshing] = useState(false);
  const { scrollY, scrollProps } = usePullToRefresh();

  // Snapshot lastReadAt on focus — held for the entire focus session.
  // CRITICAL: Do NOT read conversation.lastReadAt live in render —
  // the debounced mark-read would flip all threads to 'read' seconds after focusing.
  const lastReadAtSnapshotRef = useRef<number | null>(null);

  // Subscribe to real-time updates for the active conversation
  useWebSocketSubscription(activeConversationId);

  useFocusEffect(
    useCallback(() => {
      if (activeConversationId) {
        // Capture the lastReadAt snapshot for the focus session
        const conv = useAppStore.getState().conversations[activeConversationId];
        lastReadAtSnapshotRef.current = conv?.lastReadAt ?? null;

        useAppStore.getState().setViewingConversation(activeConversationId);
        markConversationReadEverywhere(activeConversationId);
      }
      return () => {
        useAppStore.getState().setViewingConversation(null);
      };
    }, [activeConversationId]),
  );

  // Get threads for the active conversation (or all threads if no active conversation)
  const blockedSet = useBlockedSet();

  const threadList = useMemo((): Thread[] => {
    let list: Thread[];
    if (activeConversationId) {
      const ids = threadIdsByConversation[activeConversationId] ?? [];
      list = ids.map((id) => threads[id]).filter((t): t is Thread => t != null);
    } else {
      // Show all threads across all conversations when no specific conversation is active
      list = Object.values(threads);
    }
    return blockedSet.size > 0 ? list.filter((t) => !blockedSet.has(t.authorId)) : list;
  }, [threads, threadIdsByConversation, activeConversationId, blockedSet]);

  const listRows = useMemo(() => buildListRows(threadList), [threadList]);

  useEffect(() => {
    if (!activeConversationId) return;
    loadThreadsForGroup(activeConversationId).catch((e) => {
      if (__DEV__) console.warn('[ThreadsScreen] load failed:', e instanceof Error ? e.message : e);
    });
  }, [activeConversationId]);

  const handleThreadPress = useCallback(
    (threadId: string) => {
      const thread = threads[threadId];
      navigation.push('ThreadDetail', {
        threadId,
        threadTitle: thread?.title ?? undefined,
      });
    },
    [navigation, threads],
  );

  const handleRefresh = useCallback(async () => {
    if (!activeConversationId) return;
    setRefreshing(true);
    try {
      await loadThreadsForGroup(activeConversationId);
    } catch {
      // Silently fail — stale data is still visible
    } finally {
      setRefreshing(false);
    }
  }, [activeConversationId]);

  const handleCompose = useCallback(() => {
    if (!activeConversationId) return;
    navigation.navigate('ComposeThread', { groupId: activeConversationId });
  }, [navigation, activeConversationId]);

  const handleOpenOrbits = useCallback(() => {
    navigation.navigate('OrbitSelector');
  }, [navigation]);

  const lastReadAtSnapshot = lastReadAtSnapshotRef.current;

  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<ListRow>) => {
      switch (item.type) {
        case 'day':
          return <AsciiDay label={item.label} />;
        case 'section':
          return <AsciiSection />;
        case 'thread': {
          const t = item.thread;
          return (
            <ThreadItem
              threadId={t.id}
              title={t.title ?? '(no title)'}
              author={t.authorUsername}
              time={new Date(t.createdAt).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
              })}
              replyCount={t.replyCount}
              hasMedia={t.contentType === 'media'}
              state={getThreadState(t, threadLastViewedAt, lastReadAtSnapshot)}
              unreadCount={0}
              onPress={handleThreadPress}
            />
          );
        }
      }
    },
    [handleThreadPress, threadLastViewedAt, lastReadAtSnapshot],
  );

  const keyExtractor = useCallback((item: ListRow) => item.key, []);

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const listContentStyle: ViewStyle = {
    flexGrow: 1,
  };

  const handleCreateOrbit = useCallback(() => {
    navigation.push('CreateOrbit');
  }, [navigation]);

  const handleJoinOrbit = useCallback(() => {
    navigation.push('JoinOrbit');
  }, [navigation]);

  // Compute total unread count for other orbits (all group conversations except the active one)
  const otherOrbitsUnread = useMemo(() => {
    let total = 0;
    for (const conv of Object.values(conversations)) {
      if (conv.type === 'group' && conv.id !== activeConversationId) {
        total += conv.unreadCount;
      }
    }
    return total;
  }, [conversations, activeConversationId]);

  const isOnboarding = activeConversationId == null;
  const activeConversation = activeConversationId
    ? conversations[activeConversationId]
    : undefined;

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="threads-screen">
      {isOnboarding ? (
        <OnboardingEmptyState
          onCreateOrbit={handleCreateOrbit}
          onJoinOrbit={handleJoinOrbit}
        />
      ) : (
        <>
          <OrbitBar
            orbitName={activeConversation?.name ?? 'Orbit'}
            onOpenOrbits={handleOpenOrbits}
            onCompose={handleCompose}
            otherOrbitsUnread={otherOrbitsUnread}
          />
          {connectionStatus === 'reconnecting' && (
            <ConnectionStatusBanner theme={theme} />
          )}
          <SearchBar />

          {listRows.length === 0 ? (
            <EmptyState onCompose={handleCompose} />
          ) : (
            <View style={{ flex: 1 }}>
              <PullToRefreshOverlay scrollY={scrollY} refreshing={refreshing} />
              <Animated.FlatList
                data={listRows}
                keyExtractor={keyExtractor}
                renderItem={renderRow}
                contentContainerStyle={listContentStyle}
                refreshControl={
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={handleRefresh}
                    tintColor="transparent"
                  />
                }
                {...scrollProps}
                removeClippedSubviews
                initialNumToRender={20}
                maxToRenderPerBatch={10}
                windowSize={5}
              />
            </View>
          )}
        </>
      )}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Combined store selector — avoids duplicate hook invocations in render
// ---------------------------------------------------------------------------

function useThreadsAndConversation() {
  const { threads, threadIdsByConversation, threadLastViewedAt } = useThreads();
  const { activeConversationId, conversations } = useConversations();
  return { threads, threadIdsByConversation, threadLastViewedAt, activeConversationId, conversations };
}

export default ThreadsScreen;
