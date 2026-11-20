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
import {
  loadThreadsForGroup,
  hydrateThreadsFromLocal,
  ensureThreadEntitiesCached,
} from '../services/threadService';
import { markConversationReadEverywhere } from '../services/conversationService';
import {
  GroupKeyFailureNotice,
  GroupKeyPendingBanner,
} from '../components/GroupKeyNotice';
import { useGroupKeyLoadState } from '../hooks/useGroupKeyLoadState';
import { PullToRefreshOverlay } from '../components/PullToRefreshOverlay';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { useSQLiteSearch } from '../hooks/useSQLiteSearch';
import {
  useThreadListPaging,
  THREAD_LIST_MVCP,
  THREAD_LIST_REMOVE_CLIPPED_SUBVIEWS,
} from '../hooks/useThreadListPaging';
import { useWebSocketSubscription } from '../hooks/useWebSocketSubscription';
import { useBlockedSet } from '../hooks/useBlockedSet';
import { useMuteActions } from '../hooks/useMuteActions';
import { getThreadState } from '../utils/threadState';
import { createThreadListRowsCache, type ListRow } from '../utils/threadListRows';
import {
  formatImportDate,
  formatImportDateA11y,
  formatShortTime,
} from '../utils/formatPostTimestamp';
import { NO_TITLE_FALLBACK, threadHeadline } from '../utils/threadHeadline';
import { describeImportedLabel } from './import/importCopy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ThreadsScreenProps = NativeStackScreenProps<
  ThreadsStackParamList,
  'ThreadsList'
>;

/**
 * What a screen reader says about an imported row (#927), folded into the
 * row's own label: "imported from Facebook, June 1, 2014".
 *
 * Lowercase leading, because it is a clause in the middle of a sentence that
 * starts "Thread: ". The date is the LONG form — "June 1" rather than
 * "Jun 1" — since an abbreviation read aloud is not a month.
 */
function describeImportForRow(thread: Thread): string {
  const label = describeImportedLabel(thread.importSource);
  const spoken = label.charAt(0).toLowerCase() + label.slice(1);
  const date = formatImportDateA11y(thread.createdAt);
  return date === '' ? spoken : `${spoken}, ${date}`;
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

  /**
   * #940: the orbit check below is a render-synced mirror of the store, so it
   * cannot see an unmount — the user can pop this screen (or the tab can be
   * torn down) while a pull-to-refresh is still in flight, and
   * `loadThreadsForGroup` is not cancellable.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  /**
   * One rows cache per mounted screen (#923). A walked orbit is long enough
   * that re-sorting it on every `threads` map write misses the frame budget on
   * Hermes; the cache reuses the sorted order when a page only APPENDED rows.
   * See `createThreadListRowsCache`.
   */
  const rowsCache = useRef(createThreadListRowsCache()).current;

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
    return rowsCache(threadList);
  }, [isSearching, resultThreadIds, threads, threadList, blockedSet, rowsCache]);

  /**
   * Scroll to the top when ENTERING search, and only then (#923).
   *
   * Exiting used to scroll too, which threw away a walked list's position:
   * the member scrolled minutes' worth of imported posts, searched, came back,
   * and was at the head again with no way back down but another walk.
   */
  useEffect(() => {
    if (!isSearching) return;
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [isSearching]);

  /**
   * Search reaches every CACHED row, including rows whose entity a leave-trim
   * dropped from the store (#923). FTS still has their ids, so without this
   * the result row would have no thread to render. Entities only — never the
   * list — so a trimmed tail row does not reappear behind the search overlay.
   */
  useEffect(() => {
    if (!isSearching || resultThreadIds.length === 0) return;
    ensureThreadEntitiesCached(resultThreadIds);
  }, [isSearching, resultThreadIds]);

  /**
   * Load-more (#923). Orbits do NOT gate on a first scroll: `onEndReached`
   * firing on a content-size change is exactly the auto-fill a short orbit
   * list wants, and an orbit is where the imports are.
   */
  const paging = useThreadListPaging({
    conversationId: activeConversationId,
    // THREAD rows, not list rows: day and section separators cannot be what a
    // page added, and counting them would read as growth that never happened.
    renderedCount: threadList.length,
    filtersActive: blockedSet.size > 0,
    disabled: isSearching,
  });

  /**
   * Group-key state for the active orbit (#912). `keyPending` is the transient
   * "a peer is re-wrapping" banner; `keyFailureMessage` is every other outcome,
   * which replaces the empty state. Only ONE of them is ever set.
   *
   * Keyed on the orbit id: one orbit's key state must never be shown over
   * another's, and this screen stays MOUNTED across an orbit switch (the
   * selector only writes `activeConversationId`). The hook owns that reset —
   * see `useGroupKeyLoadState` for why it is not keyed on `keyGeneration`.
   */
  const { keyPending, keyFailureMessage, clearKeyState, applyKeyLoadError } =
    useGroupKeyLoadState(activeConversationId);

  /**
   * Bumped by `handleWrappedKeyDelivered` once a delivered key has actually
   * been fetched (#912 / D11). Listed in the load effect's deps so the OPEN
   * screen reloads itself when the heal lands — the whole point of B2: before
   * this, the member stared at a false "No threads yet" until they navigated
   * away and back.
   */
  const keyGeneration = useGroupKeyGeneration(activeConversationId ?? null);

  // Instant hydration from the local SQLCipher cache, before the async fetch.
  // SPLIT from the load effect below: `setThreads` REPLACES this
  // conversation's id list, so re-running it on a heal bump would roll the
  // list back to the disk snapshot the heal was supposed to supersede.
  useEffect(() => {
    if (!activeConversationId) return;
    hydrateThreadsFromLocal(activeConversationId);
  }, [activeConversationId]);

  /**
   * The orbit this effect last issued a load for (#923).
   *
   * The effect has TWO triggers and they want opposite things from the walked
   * tail. An orbit CHANGE is an open: the list belongs to a different orbit,
   * so the previous walk's tail is dropped with its cursor (`tail: 'drop'`). A
   * key-heal rerun is the same orbit re-reading its head page, and dropping
   * the tail there would yank the member back to the top of a list they had
   * walked (`tail: 'keep'`).
   */
  const loadedConversationRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeConversationId) return;
    // The id this load was issued FOR. Every state write below is gated on it
    // still being the active orbit: `loadThreadsForGroup` is not cancellable,
    // and a late settle from the orbit the user just left must not write its
    // verdict onto the one they are looking at.
    const target = activeConversationId;
    const isReopen = loadedConversationRef.current !== target;
    loadedConversationRef.current = target;
    const isStale = (): boolean =>
      useAppStore.getState().activeConversationId !== target;
    loadThreadsForGroup(target, { tail: isReopen ? 'drop' : 'keep' })
      .then(() => {
        if (isStale()) return;
        // Cleared only on success: clearing at the START of the load would
        // flash the create-first empty state on every reload attempt.
        clearKeyState();
      })
      .catch((e) => {
        if (__DEV__) console.warn('[ThreadsScreen] load failed:', e instanceof Error ? e.message : e);
        if (isStale()) return;
        // A non-key failure keeps the pre-#912 behaviour: stale content stays
        // visible and the failure is a dev warning. Not every load failure is a
        // key failure, and a network blip must not claim to be one.
        applyKeyLoadError(e);
      });
  }, [activeConversationId, keyGeneration, clearKeyState, applyKeyLoadError]);

  const handleThreadPress = useCallback(
    (threadId: string) => {
      Keyboard.dismiss();
      const thread = threads[threadId];
      navigation.push('ThreadDetail', {
        threadId,
        // The STORED title, deliberately — never the derived headline (#927).
        // The headline can be body text, and navigation params are persisted
        // state: no decrypted body belongs in them. The detail screen derives
        // its own headline from the store instead.
        //
        // `||`, not `??`: an imported (Meta) post can carry an empty title,
        // and `??` would pass `''` through as the detail screen's header text.
        threadTitle: thread?.title || undefined,
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
      // The same headline the row shows, so the menu names the thread the
      // member long-pressed rather than a bare "Thread" (#927). A row can be
      // pressed after its thread left the map, hence the guard.
      const thread = threadsRef.current[threadId];
      showMuteMenu(threadId, 'thread', (thread ? threadHeadline(thread) : null) ?? 'Thread');
    },
    [showMuteMenu],
  );

  /**
   * Pull-to-refresh. #940: this used to swallow EVERY error, so the group-key
   * banner survived the pull that was meant to re-classify it — most visibly
   * after #938's 24h bound turned a pending wrap into `stale_pending`, where
   * the screen kept promising a re-send that was never coming.
   */
  const handleRefresh = useCallback(async () => {
    if (!activeConversationId) return;
    const target = activeConversationId;
    // Mounted AND still this orbit: the refresh outlives both a pop and an
    // orbit switch, and a verdict from the orbit the user just left must not
    // be written onto the one they are looking at.
    const isStale = (): boolean =>
      !mountedRef.current || useAppStore.getState().activeConversationId !== target;
    setRefreshing(true);
    try {
      // KEEP, explicitly (#923): a pull is "show me what is new at the head",
      // not "start over". Whatever the member walked to stays listed, and the
      // walk keeps its cursor.
      await loadThreadsForGroup(target, { tail: 'keep' });
      if (!isStale()) clearKeyState();
    } catch (e) {
      if (__DEV__)
        console.warn('[ThreadsScreen] refresh failed:', e instanceof Error ? e.message : e);
      // Non-key errors stay silent, as before: stale data is still visible.
      if (!isStale()) applyKeyLoadError(e);
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [activeConversationId, clearKeyState, applyKeyLoadError]);

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
              // A title when there is one, otherwise something derived from
              // what the thread HAS (#927): its first line, its link's host,
              // or its photo count. Meta exports carry no titles at all, so
              // without this every imported row read "(no title)".
              title={threadHeadline(t) ?? NO_TITLE_FALLBACK}
              author={t.authorUsername}
              groupId={activeConversationId ?? null}
              // An import's served time is a synthetic noon-UTC sort key, not
              // a moment: it shows the original DATE, with its year and no
              // clock time. Native rows are unchanged.
              time={t.isImport ? formatImportDate(t.createdAt) : formatShortTime(t.createdAt)}
              replyCount={t.replyCount}
              hasMedia={t.contentType === 'media'}
              state={getThreadState(t, threadLastViewedAt, lastReadAtSnapshot)}
              unreadCount={0}
              isImport={t.isImport}
              importA11y={t.isImport ? describeImportForRow(t) : undefined}
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

  /** The empty-but-`hasMore` body (#923): the footer, centred, nothing else. */
  const pagingEmptyStyle: ViewStyle = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xl,
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
            ) : paging.hasMore ? (
              // #923: nothing rendered, but the server says there is more —
              // a head page of nothing but blocked authors, typically. "No
              // threads yet" would be a lie about an orbit full of threads,
              // and the list is not mounted here so `onEndReached` can never
              // fire: the hook's own auto-fill walks, and this shows its
              // spinner, then its "Load more" row if it stops short.
              // Ordered AFTER the key notices, which are about this orbit
              // being unreadable rather than about what is in it.
              <View style={pagingEmptyStyle} testID="threads-paging-empty">
                {paging.footer}
              </View>
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
                ListFooterComponent={paging.footer}
                onEndReached={paging.onEndReached}
                onEndReachedThreshold={0.3}
                // A walk page sorts OLDER than what is on screen, so it extends
                // the list downward — but a head refresh landing mid-walk, or a
                // reply bumping a thread, inserts above the viewport. Anchoring
                // on row 0 keeps the member's place. Safe on this list because
                // it has no ListHeaderComponent (#923 / #821).
                maintainVisibleContentPosition={THREAD_LIST_MVCP}
                removeClippedSubviews={THREAD_LIST_REMOVE_CLIPPED_SUBVIEWS}
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
