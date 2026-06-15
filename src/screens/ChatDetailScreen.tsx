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
import { useAuth, useThreads, useContactForConversation } from '../stores';
import type { Thread } from '../types/store';
import { getThreadState } from '../utils/threadState';
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
import { PullToRefreshOverlay } from '../components/PullToRefreshOverlay';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { useSQLiteSearch } from '../hooks/useSQLiteSearch';
import { useWebSocketSubscription } from '../hooks/useWebSocketSubscription';
import { useBlockedSet } from '../hooks/useBlockedSet';

export type ChatDetailScreenProps = NativeStackScreenProps<
  ChatsStackParamList,
  'ChatDetail'
>;

type DaySeparatorRow = { type: 'day'; label: string; key: string };
type SectionSeparatorRow = { type: 'section'; key: string };
type ThreadRow = { type: 'thread'; thread: Thread; key: string };
type ListRow = DaySeparatorRow | SectionSeparatorRow | ThreadRow;

function getDayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const threadDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (threadDay.getTime() === today.getTime()) return 'Today';
  if (threadDay.getTime() === yesterday.getTime()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getDayKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildListRows(threads: Thread[]): ListRow[] {
  if (threads.length === 0) return [];

  const sorted = [...threads].sort((a, b) => b.createdAt - a.createdAt);
  const rows: ListRow[] = [];
  let lastDayKey: string | null = null;
  let groupIndex = 0;

  for (const thread of sorted) {
    const dayKey = getDayKey(thread.createdAt);
    if (dayKey !== lastDayKey) {
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
  const { conversationId, recipientName } = route.params;

  const { threads, threadIdsByConversation, threadLastViewedAt } = useThreads();
  const { userId } = useAuth();
  const contact = useContactForConversation(conversationId);
  const [refreshing, setRefreshing] = useState(false);
  const { scrollY, scrollProps } = usePullToRefresh();

  // Subscribe to real-time updates for this DM conversation
  useWebSocketSubscription(conversationId);

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
        .map((thread) => ({
          type: 'thread' as const,
          thread,
          key: `thread-${thread.id}`,
        }));
    }
    return buildListRows(threadList);
  }, [isSearching, resultThreadIds, threads, threadList]);

  // Scroll to top when entering/exiting search mode
  useEffect(() => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [isSearching]);

  useEffect(() => {
    // Instant hydration from local SQLCipher cache before async API fetch
    hydrateThreadsFromLocal(conversationId);
    loadThreadsForGroup(conversationId).catch((e) => {
      if (__DEV__) console.warn('[ChatDetail] load failed:', e instanceof Error ? e.message : e);
    });
  }, [conversationId]);

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
    navigation.navigate('ComposeChatThread', { groupId: conversationId, isDm: true });
  }, [navigation, conversationId]);

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
              body={t.body}
              author={t.authorUsername}
              time={new Date(t.createdAt).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
              })}
              isOwn={isOwn}
              unread={getThreadState(t, threadLastViewedAt, lastReadAtSnapshot) === 'unread'}
              onPress={handleThreadPress}
            />
          );
        }
      }
    },
    [handleThreadPress, userId, threadLastViewedAt, lastReadAtSnapshot],
  );

  const keyExtractor = useCallback((item: ListRow) => item.key, []);

  const composeBtnStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.xl,
    color: theme.colors.blue,
  };

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="chat-detail-screen">
      <Header
        title={recipientName ?? 'Chat'}
        onBack={() => navigation.goBack()}
        right={
          <TouchableOpacity
            onPress={handleCompose}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="New thread"
          >
            <Text style={composeBtnStyle}>+</Text>
          </TouchableOpacity>
        }
      />

      {showIdentityBanner && (
        <IdentityChangeBanner
          contactName={recipientName ?? contact?.username ?? 'Unknown'}
          onPress={handleBannerPress}
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
        <EmptyState onCompose={handleCompose} />
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
