/**
 * Chat detail screen -- shows threads within a DM conversation.
 *
 * Mirrors the ThreadsScreen data flow but scoped to a single DM conversation.
 * Threads within the DM are displayed with day grouping.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  Animated,
  FlatList,
  Keyboard,
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
import { useAppStore } from '../stores';
import {
  useAuth,
  useThreads,
  useContactForConversation,
  useGroupKeyGeneration,
} from '../stores';
import type { Thread } from '../types/store';
import { getThreadState } from '../utils/threadState';
import { createThreadListRowsCache, type ListRow } from '../utils/threadListRows';
import { VerifiedStatus } from '../types/database';
import type { ChatsStackParamList } from '../navigation/types';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { AsciiDay, AsciiSection } from '../components/AsciiSeparator';
import { SearchEmptyState } from '../components/SearchEmptyState';
import { IdentityChangeBanner } from '../components/IdentityChangeBanner';
import { SearchBar } from './threads/SearchBar';
import { ChatMessageItem } from './chats/ChatMessageItem';
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
import { useBlockedDmPeer, useBlockedPeerTransition } from '../hooks/useBlockedDmPeer';
import { BlockedPeerNotice } from '../components/BlockedPeerNotice';
import { useIsMuted } from '../hooks/useIsMuted';
import { useMuteActions } from '../hooks/useMuteActions';
import { Emoji } from '../components/Emoji';
import { formatShortTime } from '../utils/formatPostTimestamp';

export type ChatDetailScreenProps = NativeStackScreenProps<
  ChatsStackParamList,
  'ChatDetail'
>;

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

  const borderStyle: TextStyle = {
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
        <Text style={borderStyle}>{'┌─────────────────────┐'}</Text>
        <Text style={messageStyle}>{'No messages yet\nStart the conversation!'}</Text>
        <Text style={borderStyle}>{'└─────────────────────┘'}</Text>
        <Button title="Send a Message" onPress={onCompose} variant="primary" />
      </View>
    </View>
  );
}

export function ChatDetailScreen({
  route,
  navigation,
}: ChatDetailScreenProps): React.JSX.Element {
  const theme = useTheme();
  const { conversationId, recipientName, recipientId } = route.params;

  const { threads, threadIdsByConversation, threadLastViewedAt } = useThreads();
  const { userId } = useAuth();
  const contact = useContactForConversation(conversationId);
  const [refreshing, setRefreshing] = useState(false);
  const { scrollY, scrollProps } = usePullToRefresh();

  // Subscribe to real-time updates for this DM conversation
  useWebSocketSubscription(conversationId);

  // Conversation-level mute (#449). A DM is a group server-side, so the mute
  // row is ('group', conversationId) — it suppresses every push carrying this
  // gid, including the thread traffic inside the DM.
  const isMuted = useIsMuted(conversationId);
  const { toggleMuteFor } = useMuteActions();
  const handleToggleMute = useCallback(() => {
    toggleMuteFor(conversationId, 'group');
  }, [toggleMuteFor, conversationId]);

  // Snapshot lastReadAt on focus — held for the entire focus session.
  // Do NOT read conversation.lastReadAt live in render: the debounced
  // mark-read below would flip all rows to 'read' seconds after focusing.
  const lastReadAtSnapshotRef = useRef<number | null>(null);

  useFocusEffect(
    useCallback(() => {
      const conv = useAppStore.getState().conversations[conversationId];
      lastReadAtSnapshotRef.current = conv?.lastReadAt ?? null;

      useAppStore.getState().setViewingConversation(conversationId);
      markConversationReadEverywhere(conversationId);
      return () => {
        useAppStore.getState().setViewingConversation(null);
      };
    }, [conversationId]),
  );

  const blockedSet = useBlockedSet();

  // Blocked DM peer (#908). `recipientId` is the route's DM-only hint, used
  // when the conversation row is missing from the store — a push tap or a
  // deep link can land here before the DM list has loaded. Nothing redirects:
  // the screen stays reachable and explains itself.
  const blockedPeer = useBlockedDmPeer(conversationId, {
    hint: recipientId,
    dmIntent: true,
  });
  const isBlocked = blockedPeer != null;

  // Announce once on the false -> true edge only (iOS ignores a live region,
  // so the announcement is explicit). This screen has nothing to reset: no
  // composer input and no upload of its own.
  useBlockedPeerTransition(blockedPeer);

  const flatListRef = useRef<FlatList<ListRow>>(null);

  const threadList = useMemo((): Thread[] => {
    const ids = threadIdsByConversation[conversationId] ?? [];
    const list = ids.map((id) => threads[id]).filter((t): t is Thread => t != null);
    return blockedSet.size > 0 ? list.filter((t) => !blockedSet.has(t.authorId)) : list;
  }, [threads, threadIdsByConversation, conversationId, blockedSet]);

  // FTS5 full-text search
  const { searchText, setSearchText, resultThreadIds, isSearching, clearSearch } =
    useSQLiteSearch(conversationId);

  /**
   * One rows cache per mounted screen (#923) — see `createThreadListRowsCache`
   * and the ThreadsScreen comment: re-sorting a walked list on every `threads`
   * map write misses the frame budget on Hermes.
   */
  const rowsCache = useRef(createThreadListRowsCache()).current;

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
   * Scroll to the top when ENTERING search, and only then (#923). Exiting used
   * to scroll too, which threw away the position of a list the member had
   * walked back through.
   */
  useEffect(() => {
    if (!isSearching) return;
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [isSearching]);

  /**
   * Search reaches every CACHED row, including rows whose entity a leave-trim
   * dropped from the store (#923). Entities only — never the list — so a
   * trimmed row does not reappear behind the search overlay.
   */
  useEffect(() => {
    if (!isSearching || resultThreadIds.length === 0) return;
    ensureThreadEntitiesCached(resultThreadIds);
  }, [isSearching, resultThreadIds]);

  /**
   * Load-more (#923), GATED on a real scroll gesture — the difference from
   * ThreadsScreen.
   *
   * `onEndReached` also fires on a content-size change, so an orbit's short
   * list auto-walks on open, which is what an orbit wants. A DM must not:
   * a conversation of five messages would fire off walk requests nobody asked
   * for every time it is opened (#886). `onScrollBeginDrag` below opens the
   * gate; until then the footer offers a tap instead.
   */
  const paging = useThreadListPaging({
    conversationId,
    // THREAD rows only: day and section separators cannot be what a page
    // added, and counting them would read as growth that never happened.
    renderedCount: threadList.length,
    filtersActive: blockedSet.size > 0,
    disabled: isSearching,
    requireFirstScroll: true,
  });

  /**
   * Group-key state for this DM (#912). `keyPending` is the transient "a peer
   * is re-wrapping" banner; `keyFailureMessage` is every other outcome, which
   * replaces the empty state. Only one of them is ever set.
   *
   * This is the #912 screen: the reported case was a DM whose key had been
   * wrapped to the member's pre-reset identity key, and the member saw "No
   * messages yet / Start the conversation!" on a conversation full of history.
   *
   * Keyed on the conversation, so a params-in-place navigate to another DM
   * (which keeps this screen mounted) resets it — and NOT on a `keyGeneration`
   * bump, which re-runs the load below and would flash the empty state on
   * every reload attempt.
   */
  const { keyPending, keyFailureMessage, clearKeyState, applyKeyLoadError } =
    useGroupKeyLoadState(conversationId);

  /**
   * Bumped by `handleWrappedKeyDelivered` once a delivered key has actually
   * been fetched (#912 / D11). In the load effect's deps so this screen
   * reloads itself when the heal lands, with no re-entry.
   */
  const keyGeneration = useGroupKeyGeneration(conversationId);

  /**
   * The conversation this render belongs to, read at settle time. A
   * params-in-place navigate to another DM keeps this screen mounted, and
   * `loadThreadsForGroup` is not cancellable, so a late settle from the
   * previous conversation would otherwise write its key verdict onto this one
   * (the ThreadsScreen leak, in its milder form here).
   */
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  /**
   * #940: `conversationIdRef` is a render-synced mirror, so it cannot see an
   * unmount — the user can pop this screen while a pull-to-refresh is still in
   * flight, and `loadThreadsForGroup` is not cancellable.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Instant hydration from the local SQLCipher cache, before the async fetch.
  // SPLIT from the load effect: `setThreads` REPLACES this conversation's id
  // list, so re-running it on a heal bump would roll the list back to the disk
  // snapshot the heal was supposed to supersede.
  useEffect(() => {
    hydrateThreadsFromLocal(conversationId);
  }, [conversationId]);

  /**
   * The DM this effect last issued a load for (#923). A conversation CHANGE is
   * an open — the walked tail belongs to the DM being left, so it goes with
   * its cursor — while a key-heal rerun is this same DM re-reading its head
   * page, where dropping the tail would yank the member back to the top.
   */
  const loadedConversationRef = useRef<string | null>(null);

  useEffect(() => {
    const target = conversationId;
    const isReopen = loadedConversationRef.current !== target;
    loadedConversationRef.current = target;
    const isStale = (): boolean => conversationIdRef.current !== target;
    loadThreadsForGroup(target, { tail: isReopen ? 'drop' : 'keep' })
      .then(() => {
        if (isStale()) return;
        // On success only: clearing before the load would flash the
        // create-first empty state on every reload attempt.
        clearKeyState();
      })
      .catch((e) => {
        if (__DEV__) console.warn('[ChatDetail] load failed:', e instanceof Error ? e.message : e);
        if (isStale()) return;
        // A non-key failure keeps the pre-#912 behaviour: stale content stays
        // visible, the failure is a dev warning. A network blip must not claim
        // to be a key problem.
        applyKeyLoadError(e);
      });
  }, [conversationId, keyGeneration, clearKeyState, applyKeyLoadError]);

  const handleThreadPress = useCallback(
    (threadId: string) => {
      Keyboard.dismiss();
      const thread = threads[threadId];
      navigation.push('ThreadDetail', {
        threadId,
        threadTitle: thread?.title || undefined,
      });
    },
    [navigation, threads],
  );

  /**
   * Pull-to-refresh. #940: this used to swallow EVERY error, so the group-key
   * banner survived the pull meant to re-classify it — most visibly after
   * #938's 24h bound turned a pending wrap into `stale_pending`, where the
   * screen kept promising a re-send that was never coming.
   */
  const handleRefresh = useCallback(async () => {
    const target = conversationId;
    // Mounted AND still this DM: the refresh outlives both a pop and a
    // params-in-place switch to another DM.
    const isStale = (): boolean => !mountedRef.current || conversationIdRef.current !== target;
    setRefreshing(true);
    try {
      // KEEP, explicitly (#923): a pull shows what is new at the head; it does
      // not start the walk over.
      await loadThreadsForGroup(target, { tail: 'keep' });
      if (!isStale()) clearKeyState();
    } catch (e) {
      if (__DEV__) console.warn('[ChatDetail] refresh failed:', e instanceof Error ? e.message : e);
      // Non-key errors stay silent, as before: stale data is still visible.
      if (!isStale()) applyKeyLoadError(e);
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [conversationId, clearKeyState, applyKeyLoadError]);

  const handleCompose = useCallback(() => {
    // UX guard: the compose button is not rendered while blocked, but a stale
    // empty-state press must not open a composer either (#908). The composer
    // and threadService both re-check from the store.
    if (isBlocked) return;
    navigation.navigate('ComposeChatThread', { groupId: conversationId, isDm: true });
  }, [navigation, conversationId, isBlocked]);

  const handleBannerPress = useCallback(() => {
    if (contact) {
      navigation.navigate('SafetyNumber', {
        contactId: contact.id,
        contactName: recipientName ?? contact.username ?? 'Unknown',
      });
    }
  }, [navigation, contact, recipientName]);

  const showIdentityBanner =
    contact?.verifiedStatus === VerifiedStatus.Unverified;

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
          const isOwn = t.authorId === userId;
          return (
            <ChatMessageItem
              threadId={t.id}
              authorId={t.authorId}
              body={t.body}
              author={t.authorUsername}
              groupId={conversationId}
              time={formatShortTime(t.createdAt)}
              isOwn={isOwn}
              unread={getThreadState(t, threadLastViewedAt, lastReadAtSnapshot) === 'unread'}
              onPress={handleThreadPress}
            />
          );
        }
      }
    },
    [handleThreadPress, userId, conversationId, threadLastViewedAt, lastReadAtSnapshot],
  );

  const keyExtractor = useCallback((item: ListRow) => item.key, []);

  const composeBtnStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.xl,
    color: theme.colors.blue,
  };

  const headerActionsStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
  };

  const muteBellStyle: ViewStyle = {
    marginRight: theme.spacing.md,
  };

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const noticeStyle: ViewStyle = {
    marginHorizontal: theme.spacing.base,
    marginTop: theme.spacing.xs,
  };

  /** The empty-but-`hasMore` body (#923): the footer, centred, nothing else. */
  const pagingEmptyStyle: ViewStyle = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.xl,
  };

  const blockedEmptyStyle: ViewStyle = {
    flex: 1,
    justifyContent: 'center',
    padding: theme.spacing.base,
  };

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="chat-detail-screen">
      <Header
        title={recipientName ?? 'Chat'}
        onBack={() => navigation.goBack()}
        right={
          <View style={headerActionsStyle}>
            <TouchableOpacity
              onPress={handleToggleMute}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel={isMuted ? 'Unmute this chat' : 'Mute this chat'}
              accessibilityState={{ selected: isMuted }}
              testID="chat-mute-bell"
              style={muteBellStyle}
            >
              <Emoji unified={isMuted ? '1F515' : '1F514'} size={20} />
            </TouchableOpacity>
            {!isBlocked && (
              <TouchableOpacity
                onPress={handleCompose}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel="New thread"
                testID="chat-compose-button"
              >
                <Text style={composeBtnStyle}>+</Text>
              </TouchableOpacity>
            )}
          </View>
        }
      />

      {showIdentityBanner && (
        <IdentityChangeBanner
          contactName={recipientName ?? contact?.username ?? 'Unknown'}
          onPress={handleBannerPress}
        />
      )}

      {keyPending && <GroupKeyPendingBanner />}

      {blockedPeer != null && listRows.length > 0 && (
        // Non-empty list: the notice sits above the search bar and the
        // blocker's own older threads stay readable below it.
        <BlockedPeerNotice
          label={blockedPeer.label}
          peerId={blockedPeer.peerId}
          style={noticeStyle}
        />
      )}

      <SearchBar
        value={searchText}
        onChangeText={setSearchText}
        onClear={clearSearch}
        placeholder="Search messages..."
        testID="chat-detail-search"
      />

      {isSearching && resultThreadIds.length === 0 ? (
        <SearchEmptyState searchText={searchText} />
      ) : listRows.length === 0 ? (
        blockedPeer != null ? (
          // The notice REPLACES the empty state: no "No messages yet /
          // Start the conversation!" box and no "Send a Message" CTA.
          // Checked FIRST: a block is the user's own decision and outranks a
          // key problem they cannot act on.
          <View style={blockedEmptyStyle}>
            <BlockedPeerNotice label={blockedPeer.label} peerId={blockedPeer.peerId} />
          </View>
        ) : keyPending ? (
          // #912: same discipline as the blocked notice — the banner above is
          // the whole message, and the false "Start the conversation!" box and
          // its CTA are both gone while the key is being re-sent.
          <View style={{ flex: 1 }} testID="group-key-pending-body" />
        ) : keyFailureMessage !== null ? (
          <GroupKeyFailureNotice message={keyFailureMessage} />
        ) : !isSearching && paging.hasMore ? (
          // #923: nothing renders, but the server says there is more — a head
          // page of nothing but a blocked author, typically. "Start the
          // conversation!" would be a lie about a DM full of history. Ordered
          // after the blocked and key notices, which are about this DM being
          // unreadable rather than about what is in it. The list is not
          // mounted here, so the hook's footer is the whole body: a spinner
          // while it walks, then a "Load more" row to tap.
          <View style={pagingEmptyStyle} testID="chat-paging-empty">
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
            contentContainerStyle={{ flexGrow: 1 }}
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
            // AFTER the spread, deliberately: `usePullToRefresh` supplies only
            // onScroll today, but this gate must survive it ever growing an
            // onScrollBeginDrag of its own.
            onScrollBeginDrag={paging.onScrollBeginDrag}
            onEndReached={paging.onEndReached}
            onEndReachedThreshold={0.3}
            // Anchor on row 0 so a head refresh landing mid-walk does not
            // shift what the member is reading. Safe here because this list
            // has no ListHeaderComponent (#923 / #821).
            maintainVisibleContentPosition={THREAD_LIST_MVCP}
            removeClippedSubviews={THREAD_LIST_REMOVE_CLIPPED_SUBVIEWS}
            // In line with ThreadsScreen (#923): lower batches mean fewer
            // concurrent avatar resolutions per scroll, and a DM list is now
            // as long as an orbit's.
            initialNumToRender={10}
            maxToRenderPerBatch={5}
            windowSize={5}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

export default ChatDetailScreen;
