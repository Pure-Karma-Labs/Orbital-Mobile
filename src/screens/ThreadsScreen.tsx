/**
 * Threads inbox screen — orbit selector, search bar, day-grouped thread list.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  Animated,
  FlatList,
  Keyboard,
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
import {
  useAppStore,
  useThreads,
  useConversations,
  useConnection,
  useGroupKeyGeneration,
} from '../stores';
import type { Thread } from '../types/store';
import type { ThreadsStackParamList } from '../navigation/types';
import { Button } from '../components/Button';
import { AsciiDay, AsciiSection } from '../components/AsciiSeparator';
import { SearchEmptyState } from '../components/SearchEmptyState';
import { OrbitBar } from './threads/OrbitBar';
import { SearchBar } from './threads/SearchBar';
import { ThreadItem } from './threads/ThreadItem';
import { OnboardingEmptyState } from './threads/OnboardingEmptyState';
import { loadThreadsForGroup, hydrateThreadsFromLocal } from '../services/threadService';
import { markConversationReadEverywhere } from '../services/conversationService';
import {
  GroupKeyFailureNotice,
  GroupKeyPendingBanner,
} from '../components/GroupKeyNotice';
import { groupKeyFailureCopy, isGroupKeyPending } from '../utils/groupKeyErrorCopy';
import { PullToRefreshOverlay } from '../components/PullToRefreshOverlay';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { useSQLiteSearch } from '../hooks/useSQLiteSearch';
import { useWebSocketSubscription } from '../hooks/useWebSocketSubscription';
import { useBlockedSet } from '../hooks/useBlockedSet';
import { useMuteActions } from '../hooks/useMuteActions';
import { getThreadState } from '../utils/threadState';
import { compareThreadsByActivityDesc, threadActivityAt } from '../utils/threadActivity';
import { formatDayLabel, formatShortTime, localDayKey } from '../utils/formatPostTimestamp';

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
// Build flat list rows from threads, grouping by day
// ---------------------------------------------------------------------------

function buildListRows(threads: Thread[]): ListRow[] {
  if (threads.length === 0) {
    return [];
  }

  // Sort by most recent activity (the newer of createdAt and lastReplyAt)
  // descending. The shared comparator is total: it never returns NaN, it sorts
  // a thread with no valid timestamp last, and it breaks ties on createdAt then
  // id so the order is stable across re-sorts (#883).
  const sorted = [...threads].sort(compareThreadsByActivityDesc);

  const rows: ListRow[] = [];
  let lastDayKey: string | null = null;
  let groupIndex = 0;

  for (const thread of sorted) {
    // Group and label by activity, so the day headers agree with the row order.
    // The row's own clock time still shows its creation time.
    const activityTime = threadActivityAt(thread);
    const dayKey = localDayKey(activityTime);
    // An unrenderable timestamp has no day, so it opens no group and closes
    // none: it joins whatever group it lands in. Letting '' through would both
    // render a bare `───  ───` and split a real day in two, re-emitting its
    // `day-<key>` (a duplicate FlatList key) and an extra section row.
    if (dayKey !== '' && dayKey !== lastDayKey) {
      // Insert section separator between day groups (not before first group)
      if (lastDayKey !== null) {
        rows.push({ type: 'section', key: `section-${groupIndex}` });
        groupIndex++;
      }
      rows.push({
        type: 'day',
        label: formatDayLabel(activityTime),
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
  const flatListRef = useRef<FlatList<ListRow>>(null);

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

  // FTS5 full-text search
  const { searchText, setSearchText, resultThreadIds, isSearching, clearSearch } =
    useSQLiteSearch(activeConversationId);

  // Build list rows: flat when searching (no day separators), grouped when not
  const listRows = useMemo((): ListRow[] => {
    if (isSearching) {
      return resultThreadIds
        .map((id) => threads[id])
        .filter((t): t is Thread => t != null)
        .filter((t) => !blockedSet.has(t.authorId))
        .map((thread) => ({
          type: 'thread' as const,
          thread,
          key: `thread-${thread.id}`,
        }));
    }
    return buildListRows(threadList);
  }, [isSearching, resultThreadIds, threads, threadList, blockedSet]);

  // Scroll to top when entering/exiting search mode
  useEffect(() => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [isSearching]);

  /**
   * Group-key state for the active orbit (#912). `pending` is the transient
   * "a peer is re-wrapping" banner; `failureMessage` is every other outcome,
   * which replaces the empty state. Only ONE of them is ever set.
   */
  const [keyPending, setKeyPending] = useState(false);
  const [keyFailureMessage, setKeyFailureMessage] = useState<string | null>(null);

  /**
   * Bumped by `handleWrappedKeyDelivered` once a delivered key has actually
   * been fetched (#912 / D11). Listed in the load effect's deps so the OPEN
   * screen reloads itself when the heal lands — the whole point of B2: before
   * this, the member stared at a false "No threads yet" until they navigated
   * away and back.
   */
  const keyGeneration = useGroupKeyGeneration(activeConversationId ?? null);

  /**
   * One orbit's key state must never be shown over another's. This screen
   * stays MOUNTED across orbit switches (the selector only writes
   * activeConversationId), so without this the banner from orbit A sat over
   * orbit B — indefinitely, if B's own load then failed for a non-key reason,
   * since the flags clear only on a success.
   *
   * Keyed on the id ALONE, deliberately not on `keyGeneration`: a heal bump
   * re-runs the load below, and clearing the flags there would flash the
   * create-first empty state on every reload attempt.
   */
  useEffect(() => {
    setKeyPending(false);
    setKeyFailureMessage(null);
  }, [activeConversationId]);

  // Instant hydration from the local SQLCipher cache, before the async fetch.
  // SPLIT from the load effect below: `setThreads` REPLACES this
  // conversation's id list, so re-running it on a heal bump would roll the
  // list back to the disk snapshot the heal was supposed to supersede.
  useEffect(() => {
    if (!activeConversationId) return;
    hydrateThreadsFromLocal(activeConversationId);
  }, [activeConversationId]);

  useEffect(() => {
    if (!activeConversationId) return;
    // The id this load was issued FOR. Every state write below is gated on it
    // still being the active orbit: `loadThreadsForGroup` is not cancellable,
    // and a late settle from the orbit the user just left must not write its
    // verdict onto the one they are looking at.
    const target = activeConversationId;
    const isStale = (): boolean =>
      useAppStore.getState().activeConversationId !== target;
    loadThreadsForGroup(target)
      .then(() => {
        if (isStale()) return;
        // Cleared only on success: clearing at the START of the load would
        // flash the create-first empty state on every reload attempt.
        setKeyPending(false);
        setKeyFailureMessage(null);
      })
      .catch((e) => {
        if (__DEV__) console.warn('[ThreadsScreen] load failed:', e instanceof Error ? e.message : e);
        if (isStale()) return;
        if (isGroupKeyPending(e)) {
          setKeyPending(true);
          setKeyFailureMessage(null);
        } else {
          const copy = groupKeyFailureCopy(e);
          if (copy) {
            setKeyPending(false);
            setKeyFailureMessage(copy.message);
          }
          // Anything else keeps the pre-#912 behaviour: stale content stays
          // visible and the failure is a dev warning. Not every load failure
          // is a key failure, and a network blip must not claim to be one.
        }
      });
  }, [activeConversationId, keyGeneration]);

  const handleThreadPress = useCallback(
    (threadId: string) => {
      Keyboard.dismiss();
      const thread = threads[threadId];
      navigation.push('ThreadDetail', {
        threadId,
        threadTitle: thread?.title ?? undefined,
      });
    },
    [navigation, threads],
  );

  // Long-press → mute menu (#449). The handler must be STABLE: it is a prop on
  // the memoized ThreadItem, so a new identity per render would re-render every
  // visible row. The title is therefore read from a latest-ref at press time
  // rather than closed over from the (frequently replaced) threads map.
  const { showMuteMenu } = useMuteActions();
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  const handleThreadLongPress = useCallback(
    (threadId: string) => {
      showMuteMenu(threadId, 'thread', threadsRef.current[threadId]?.title ?? 'Thread');
    },
    [showMuteMenu],
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
    navigation.navigate('ComposeThread', { groupId: activeConversationId, isDm: false });
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
              authorId={t.authorId}
              title={t.title ?? '(no title)'}
              author={t.authorUsername}
              groupId={activeConversationId ?? null}
              time={formatShortTime(t.createdAt)}
              replyCount={t.replyCount}
              hasMedia={t.contentType === 'media'}
              state={getThreadState(t, threadLastViewedAt, lastReadAtSnapshot)}
              unreadCount={0}
              onPress={handleThreadPress}
              onLongPress={handleThreadLongPress}
            />
          );
        }
      }
    },
    [handleThreadPress, handleThreadLongPress, activeConversationId, threadLastViewedAt, lastReadAtSnapshot],
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

  // Determine which empty state to show
  const showSearchEmpty = isSearching && resultThreadIds.length === 0;
  const showEmpty = !isSearching && threadList.length === 0;

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
          {keyPending && <GroupKeyPendingBanner />}
          <SearchBar
            value={searchText}
            onChangeText={setSearchText}
            onClear={clearSearch}
            placeholder="Search threads..."
            testID="threads-search"
          />

          {showSearchEmpty ? (
            <SearchEmptyState searchText={searchText} testID="search-empty-state" />
          ) : showEmpty ? (
            // #912: an undecryptable orbit is NOT a brand-new one. While the
            // key is pending the banner above is the whole message and the
            // body stays blank — no "No threads yet" box and no New Thread
            // CTA, which would only fail. A terminal outcome gets the
            // explanation in place of that box.
            keyPending ? (
              <View style={{ flex: 1 }} testID="group-key-pending-body" />
            ) : keyFailureMessage !== null ? (
              <GroupKeyFailureNotice message={keyFailureMessage} />
            ) : (
              <EmptyState onCompose={handleCompose} />
            )
          ) : (
            <View style={{ flex: 1 }}>
              <PullToRefreshOverlay scrollY={scrollY} refreshing={refreshing} />
              <Animated.FlatList
                ref={flatListRef as React.RefObject<FlatList<ListRow>>}
                data={listRows}
                keyExtractor={keyExtractor}
                renderItem={renderRow}
                contentContainerStyle={listContentStyle}
                keyboardDismissMode="on-drag"
                refreshControl={
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={handleRefresh}
                    tintColor="transparent"
                  />
                }
                {...scrollProps}
                keyboardShouldPersistTaps="handled"
                removeClippedSubviews
                initialNumToRender={10}
                maxToRenderPerBatch={5}
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
