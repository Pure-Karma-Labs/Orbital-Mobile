/**
 * New chat modal screen -- start a DM by selecting a contact from orbit members.
 *
 * Shows a filterable list of contacts (populated from orbit members).
 * Typing filters the list by username or display name.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
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
import { useContacts } from '../stores';
import { startDm, hydrateContactsFromOrbits } from '../services/conversationService';
import { Header } from '../components/Header';
import { OrbitalKeyboardAvoidingView } from '../components/OrbitalKeyboardAvoidingView';
import { ErrorBanner } from '../components/ErrorBanner';
import { TextInput } from '../components/TextInput';
import type { ChatsStackParamList } from '../navigation/types';
import type { Contact } from '../types/store';

export type NewChatScreenProps = NativeStackScreenProps<
  ChatsStackParamList,
  'NewChat'
>;

export function NewChatScreen({
  navigation,
}: NewChatScreenProps): React.JSX.Element {
  const theme = useTheme();
  const { contacts } = useContacts();

  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hydrateContactsFromOrbits().catch(() => {});
  }, []);

  const contactList = useMemo(() => {
    const all = Object.values(contacts);
    if (filter.trim().length === 0) return all;
    const lower = filter.trim().toLowerCase();
    return all.filter(
      (c) =>
        c.username?.toLowerCase().includes(lower) ||
        c.displayName?.toLowerCase().includes(lower),
    );
  }, [contacts, filter]);

  const handleSelect = useCallback(
    async (contact: Contact) => {
      setError(null);
      setLoading(true);
      try {
        const result = await startDm(contact.id);
        navigation.replace('ChatDetail', {
          conversationId: result.conversationId,
          recipientName: result.recipientName,
        });
      } catch (e) {
        if (__DEV__)
          console.warn(
            '[NewChat] error:',
            e instanceof Error ? e.message : e,
          );
        setError('Failed to start chat. Please try again.');
      } finally {
        setLoading(false);
      }
    },
    [navigation],
  );

  const renderContact = useCallback(
    ({ item }: ListRenderItemInfo<Contact>) => {
      const rowStyle: ViewStyle = {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.base,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.borderSubtle,
      };

      const nameStyle: TextStyle = {
        fontFamily: theme.typography.fontFamily.body,
        fontSize: theme.typography.fontSize.base,
        color: theme.colors.textPrimary,
      };

      const usernameStyle: TextStyle = {
        fontFamily: theme.typography.fontFamily.mono,
        fontSize: theme.typography.fontSize.sm,
        color: theme.colors.textSecondary,
        marginTop: 2,
      };

      return (
        <TouchableOpacity
          style={rowStyle}
          onPress={() => handleSelect(item)}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel={`Start chat with ${item.displayName ?? item.username}`}
          testID={`contact-row-${item.id}`}
        >
          <View style={{ flex: 1 }}>
            <Text style={nameStyle}>
              {item.displayName ?? item.username ?? 'Unknown'}
            </Text>
            {item.username && (
              <Text style={usernameStyle}>@{item.username}</Text>
            )}
          </View>
        </TouchableOpacity>
      );
    },
    [theme, handleSelect, loading],
  );

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const closeBtnStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.xl,
    color: theme.colors.textSecondary,
  };

  const emptyStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    padding: theme.spacing.xl,
  };

  return (
    <SafeAreaView style={containerStyle} edges={['top']} testID="new-chat-screen">
      <Header
        title="New Chat"
        right={
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Text style={closeBtnStyle}>X</Text>
          </TouchableOpacity>
        }
      />
      <OrbitalKeyboardAvoidingView keyboardVerticalOffset={0}>
        <View style={{ paddingHorizontal: theme.spacing.base, paddingTop: theme.spacing.base }}>
          <TextInput
            label="Search by username"
            value={filter}
            onChangeText={setFilter}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={100}
            testID="new-chat-username-input"
          />
          <ErrorBanner message={error} />
        </View>
        <FlatList
          data={contactList}
          keyExtractor={(item) => item.id}
          renderItem={renderContact}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          ListEmptyComponent={
            <Text style={emptyStyle}>
              {filter.trim().length > 0
                ? 'No matching contacts found.'
                : 'No contacts yet. Join an orbit to discover people to chat with.'}
            </Text>
          }
        />
      </OrbitalKeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default NewChatScreen;
