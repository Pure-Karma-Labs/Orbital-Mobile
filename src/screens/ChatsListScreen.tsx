/**
 * Chats list screen -- shows DM conversations sorted by lastMessageAt.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Keyboard,
  RefreshControl,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  type ListRenderItemInfo,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { IFuseOptions } from 'fuse.js';
import { useTheme } from '../theme';
import { useConversations, useContacts } from '../stores';
import type { Conversation } from '../types/store';
import type { ChatsStackParamList } from '../navigation/types';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { SearchEmptyState } from '../components/SearchEmptyState';
import { ChatItem } from './chats/ChatItem';
import { SearchBar } from './threads/SearchBar';
import { getAvatarUrl } from '../utils/avatarUrl';
import { loadDmConversations, hydrateContactsFromOrbits } from '../services/conversationService';
import { PullToRefreshOverlay } from '../components/PullToRefreshOverlay';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { useFuseSearch } from '../hooks/useFuseSearch';

// ---------------------------------------------------------------------------
// Fuse search options — module-level constant for stable WeakMap cache key
// ---------------------------------------------------------------------------

const DM_SEARCH_OPTIONS: IFuseOptions<Conversation> = {
  threshold: 0.2,
  distance: 200,
  includeScore: true,
  ignoreDiacritics: true,
  keys: [{ name: 'name', weight: 1 }],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatsListScreenProps = NativeStackScreenProps<
  ChatsStackParamList,
  'ChatsList'
>;

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function ChatsListScreen({ navigation }: ChatsListScreenProps): React.JSX.Element {
  const theme = useTheme();
  const { conversations } = useConversations();
  const { contacts } = useContacts();
  const [refreshing, setRefreshing] = useState(false);
  const { scrollY, scrollProps } = usePullToRefresh();
  const flatListRef = useRef<FlatList<Conversation>>(null);

  const dmConversations = useMemo((): Conversation[] => {
    const dms = Object.values(conversations).filter((c) => c.type === 'direct');
    return dms.sort((a, b) => {
      const aTime = a.lastMessageAt ?? a.createdAt;
      const bTime = b.lastMessageAt ?? b.createdAt;
      return bTime - aTime;
    });
  }, [conversations]);

  // Fuzzy search filtering
  const { searchText, setSearchText, results: filteredDMs, isSearching, clearSearch } =
    useFuseSearch(dmConversations, DM_SEARCH_OPTIONS);

  // Scroll to top when entering/exiting search mode
  useEffect(() => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [isSearching]);

  const contactByConversation = useMemo(() => {
    const map: Record<string, typeof contacts[string]> = {};
    for (const contact of Object.values(contacts)) {
      for (const convId of contact.conversationIds) {
        map[convId] = contact;
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
      await Promise.all([
        loadDmConversations(),
        hydrateContactsFromOrbits(),
      ]);
    } catch {
      // Silently fail -- stale data is still visible
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handleChatPress = useCallback(
    (conversationId: string) => {
      Keyboard.dismiss();
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
    ({ item }: ListRenderItemInfo<Conversation>) => {
      const contact = contactByConversation[item.id];
      return (
        <ChatItem
          conversationId={item.id}
          recipientName={item.name ?? 'Unknown'}
          lastMessageAt={item.lastMessageAt}
          avatarUrl={contact ? getAvatarUrl(contact.avatarPath) : null}
          unreadCount={item.unreadCount}
          onPress={handleChatPress}
          userId={contact?.id}
          groupId={item.id}
          encryptedAvatarKey={contact?.avatarEncryptedKey}
          avatarKeyIv={contact?.avatarKeyIv}
          avatarDigest={contact?.avatarDigest}
        />
      );
    },
    [handleChatPress, contactByConversation],
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

  // Determine which empty state to show
  const showSearchEmpty = isSearching && filteredDMs.length === 0;
  const showEmpty = !isSearching && dmConversations.length === 0;

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
      <SearchBar
        value={searchText}
        onChangeText={setSearchText}
        onClear={clearSearch}
        placeholder="Search contacts..."
        testID="chats-search"
      />

      {showSearchEmpty ? (
        <SearchEmptyState searchText={searchText} testID="search-empty-state" />
      ) : showEmpty ? (
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          }
        >
          <EmptyState onNewChat={handleNewChat} />
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>
          <PullToRefreshOverlay scrollY={scrollY} refreshing={refreshing} />
          <Animated.FlatList
            ref={flatListRef as React.RefObject<FlatList<Conversation>>}
            data={filteredDMs as Conversation[]}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
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
            removeClippedSubviews
            initialNumToRender={10}
            maxToRenderPerBatch={5}
            windowSize={5}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

export default ChatsListScreen;
