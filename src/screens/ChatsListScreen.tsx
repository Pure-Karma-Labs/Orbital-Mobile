/**
 * Chats list screen -- shows DM conversations sorted by lastMessageAt.
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
import { useConversations, useContacts } from '../stores';
import type { Conversation } from '../types/store';
import type { ChatsStackParamList } from '../navigation/types';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { ChatItem } from './chats/ChatItem';
import { getAvatarUrl } from '../utils/avatarUrl';
import { loadDmConversations } from '../services/conversationService';
import { PullToRefreshOverlay } from '../components/PullToRefreshOverlay';
import { usePullToRefresh } from '../hooks/usePullToRefresh';

export type ChatsListScreenProps = NativeStackScreenProps<
  ChatsStackParamList,
  'ChatsList'
>;

function EmptyState({ onNewChat }: { onNewChat: () => void }): React.JSX.Element {
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
        <Text style={messageStyle}>{'No chats yet\nStart a conversation!'}</Text>
        <Text style={borderStyle}>{'└─────────────────────┘'}</Text>
        <Button title="New Chat" onPress={onNewChat} variant="primary" />
      </View>
    </View>
  );
}

export function ChatsListScreen({ navigation }: ChatsListScreenProps): React.JSX.Element {
  const theme = useTheme();
  const { conversations } = useConversations();
  const { contacts } = useContacts();
  const [refreshing, setRefreshing] = useState(false);
  const { scrollY, scrollProps } = usePullToRefresh();

  const dmConversations = useMemo((): Conversation[] => {
    const dms = Object.values(conversations).filter((c) => c.type === 'direct');
    return dms.sort((a, b) => {
      const aTime = a.lastMessageAt ?? a.createdAt;
      const bTime = b.lastMessageAt ?? b.createdAt;
      return bTime - aTime;
    });
  }, [conversations]);

  const avatarByConversation = useMemo(() => {
    const map: Record<string, string | null> = {};
    for (const contact of Object.values(contacts)) {
      const url = getAvatarUrl(contact.avatarPath);
      for (const convId of contact.conversationIds) {
        map[convId] = url;
      }
    }
    return map;
  }, [contacts]);

  useEffect(() => {
    loadDmConversations().catch((e) => {
      if (__DEV__) console.warn('[ChatsListScreen] load failed:', e instanceof Error ? e.message : e);
    });
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadDmConversations();
    } catch {
      // Silently fail -- stale data is still visible
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handleChatPress = useCallback(
    (conversationId: string) => {
      const conversation = conversations[conversationId];
      // Find the contact associated with this DM conversation
      const contact = Object.values(contacts).find((c) =>
        c.conversationIds.includes(conversationId),
      );
      navigation.push('ChatDetail', {
        conversationId,
        recipientName: conversation?.name ?? undefined,
        recipientId: contact?.id,
      });
    },
    [navigation, conversations, contacts],
  );

  const handleNewChat = useCallback(() => {
    navigation.navigate('NewChat');
  }, [navigation]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Conversation>) => (
      <ChatItem
        conversationId={item.id}
        recipientName={item.name ?? 'Unknown'}
        lastMessageAt={item.lastMessageAt}
        avatarUrl={avatarByConversation[item.id]}
        unreadCount={item.unreadCount}
        onPress={handleChatPress}
      />
    ),
    [handleChatPress, avatarByConversation],
  );

  const keyExtractor = useCallback((item: Conversation) => item.id, []);

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
    <SafeAreaView style={containerStyle} edges={['top']} testID="chats-list-screen">
      <Header
        title="Chats"
        right={
          <TouchableOpacity
            onPress={handleNewChat}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="New chat"
          >
            <Text style={composeBtnStyle}>+</Text>
          </TouchableOpacity>
        }
      />

      {dmConversations.length === 0 ? (
        <EmptyState onNewChat={handleNewChat} />
      ) : (
        <View style={{ flex: 1 }}>
          <PullToRefreshOverlay scrollY={scrollY} refreshing={refreshing} />
          <Animated.FlatList
            data={dmConversations}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
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

export default ChatsListScreen;
