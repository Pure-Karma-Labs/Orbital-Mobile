/**
 * Chat detail screen -- shows threads within a DM conversation.
 *
 * Mirrors the ThreadsScreen data flow but scoped to a single DM conversation.
 * Threads within the DM are displayed with day grouping.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Animated,
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
import { useThreads } from '../stores';
import type { Thread } from '../types/store';
import type { ChatsStackParamList } from '../navigation/types';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { AsciiDay, AsciiSection } from '../components/AsciiSeparator';
import { ThreadItem } from './threads/ThreadItem';
import { loadThreadsForGroup } from '../services/threadService';
import { PullToRefreshOverlay } from '../components/PullToRefreshOverlay';
import { usePullToRefresh } from '../hooks/usePullToRefresh';

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
        <Text style={messageStyle}>{'No threads yet\nStart the conversation!'}</Text>
        <Text style={borderStyle}>{'└─────────────────────┘'}</Text>
        <Button title="New Thread" onPress={onCompose} variant="primary" />
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

  const { threads, threadIdsByConversation } = useThreads();
  const [refreshing, setRefreshing] = useState(false);
  const { scrollY, scrollProps } = usePullToRefresh();

  const threadList = useMemo((): Thread[] => {
    const ids = threadIdsByConversation[conversationId] ?? [];
    return ids.map((id) => threads[id]).filter((t): t is Thread => t != null);
  }, [threads, threadIdsByConversation, conversationId]);

  const listRows = useMemo(() => buildListRows(threadList), [threadList]);

  useEffect(() => {
    loadThreadsForGroup(conversationId).catch((e) => {
      if (__DEV__) console.warn('[ChatDetail] load failed:', e instanceof Error ? e.message : e);
    });
  }, [conversationId]);

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
    navigation.navigate('ComposeChatThread', { groupId: conversationId });
  }, [navigation, conversationId]);

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
              state="read"
              unreadCount={0}
              onPress={handleThreadPress}
            />
          );
        }
      }
    },
    [handleThreadPress],
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

      {listRows.length === 0 ? (
        <EmptyState onCompose={handleCompose} />
      ) : (
        <View style={{ flex: 1 }}>
          <PullToRefreshOverlay scrollY={scrollY} refreshing={refreshing} />
          <Animated.FlatList
            data={listRows}
            keyExtractor={keyExtractor}
            renderItem={renderRow}
            contentContainerStyle={{ flexGrow: 1 }}
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
