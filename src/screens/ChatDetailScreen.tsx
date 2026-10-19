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
import { compareThreadsByActivityDesc, threadActivityAt } from '../utils/threadActivity';
import { VerifiedStatus } from '../types/database';
import type { ChatsStackParamList } from '../navigation/types';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { AsciiDay, AsciiSection } from '../components/AsciiSeparator';
import { SearchEmptyState } from '../components/SearchEmptyState';
import { IdentityChangeBanner } from '../components/IdentityChangeBanner';
import { SearchBar } from './threads/SearchBar';
import { ChatMessageItem } from './chats/ChatMessageItem';
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
import { useBlockedDmPeer, useBlockedPeerTransition } from '../hooks/useBlockedDmPeer';
import { BlockedPeerNotice } from '../components/BlockedPeerNotice';
import { useIsMuted } from '../hooks/useIsMuted';
import { useMuteActions } from '../hooks/useMuteActions';
import { Emoji } from '../components/Emoji';
import { formatDayLabel, formatShortTime, localDayKey } from '../utils/formatPostTimestamp';

export type ChatDetailScreenProps = NativeStackScreenProps<
  ChatsStackParamList,
  'ChatDetail'
>;

type DaySeparatorRow = { type: 'day'; label: string; key: string };
type SectionSeparatorRow = { type: 'section'; key: string };
type ThreadRow = { type: 'thread'; thread: Thread; key: string };
type ListRow = DaySeparatorRow | SectionSeparatorRow | ThreadRow;

function buildListRows(threads: Thread[]): ListRow[] {
  if (threads.length === 0) return [];

  // Most recent activity first: a reply on an old message brings it back to the
  // top of the DM, matching what the Chats list now does with the conversation
  // itself (#883). The comparator is total and never returns NaN.
  const sorted = [...threads].sort(compareThreadsByActivityDesc);
  const rows: ListRow[] = [];
  let lastDayKey: string | null = null;
  let groupIndex = 0;

  for (const thread of sorted) {
    // Group and label by activity, so the day headers agree with the order the
    // rows are in. The row's own clock time still shows its creation time.
    const activityTime = threadActivityAt(thread);
    const dayKey = localDayKey(activityTime);
    // An unrenderable timestamp has no day, so it opens no group and closes
    // none: it joins whatever group it lands in. Letting '' through would both
    // render a bare `───  ───` and split a real day in two, re-emitting its
    // `day-<key>` (a duplicate FlatList key) and an extra section row.
    if (dayKey !== '' && dayKey !== lastDayKey) {
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
   * Group-key state for this DM (#912). `keyPending` is the transient "a peer
   * is re-wrapping" banner; `keyFailureMessage` is every other outcome, which
   * replaces the empty state. Only one of them is ever set.
   *
   * This is the #912 screen: the reported case was a DM whose key had been
   * wrapped to the member's pre-reset identity key, and the member saw "No
   * messages yet / Start the conversation!" on a conversation full of history.
   */
  const [keyPending, setKeyPending] = useState(false);
  const [keyFailureMessage, setKeyFailureMessage] = useState<string | null>(null);

  /**
   * Bumped by `handleWrappedKeyDelivered` once a delivered key has actually
   * been fetched (#912 / D11). In the load effect's deps so this screen
   * reloads itself when the heal lands, with no re-entry.
   */
  const keyGeneration = useGroupKeyGeneration(conversationId);

  useEffect(() => {
    // Instant hydration from local SQLCipher cache before async API fetch
    hydrateThreadsFromLocal(conversationId);
    loadThreadsForGroup(conversationId)
      .then(() => {
        // On success only: clearing before the load would flash the
        // create-first empty state on every reload attempt.
        setKeyPending(false);
        setKeyFailureMessage(null);
      })
      .catch((e) => {
        if (isGroupKeyPending(e)) {
          setKeyPending(true);
          setKeyFailureMessage(null);
        } else {
          const copy = groupKeyFailureCopy(e);
          if (copy) {
            setKeyPending(false);
            setKeyFailureMessage(copy.message);
          }
          // Everything else keeps the pre-#912 behaviour: stale content stays
          // visible, the failure is a dev warning. A network blip must not
          // claim to be a key problem.
        }
        if (__DEV__) console.warn('[ChatDetail] load failed:', e instanceof Error ? e.message : e);
      });
  }, [conversationId, keyGeneration]);

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

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadThreadsForGroup(conversationId);
    } catch {
      // Silently fail -- stale data is still visible
    } finally {
      setRefreshing(false);
    }
  }, [conversationId]);

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
            initialNumToRender={20}
            maxToRenderPerBatch={10}
            windowSize={5}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

export default ChatDetailScreen;
