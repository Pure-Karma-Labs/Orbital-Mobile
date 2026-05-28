/**
 * New chat modal screen -- start a DM by entering a recipient username.
 *
 * Looks up the recipient ID from the contacts store (populated from orbit
 * members). If the user isn't a known contact, shows an error -- we can
 * only DM members of shared orbits since there is no user search API.
 */

import React, { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { useContacts } from '../stores';
import { startDm } from '../services/conversationService';
import { Header } from '../components/Header';
import { Button } from '../components/Button';
import { ErrorBanner } from '../components/ErrorBanner';
import { TextInput } from '../components/TextInput';
import type { ChatsStackParamList } from '../navigation/types';

export type NewChatScreenProps = NativeStackScreenProps<
  ChatsStackParamList,
  'NewChat'
>;

export function NewChatScreen({
  navigation,
}: NewChatScreenProps): React.JSX.Element {
  const theme = useTheme();
  const { contacts } = useContacts();

  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = username.trim().length > 0 && !loading;

  const handleStartChat = useCallback(async () => {
    if (!canSubmit) return;

    setError(null);
    const trimmed = username.trim().toLowerCase();

    // Find recipient in contacts store by username (populated from orbit members)
    const contact = Object.values(contacts).find(
      (c) => c.username?.toLowerCase() === trimmed,
    );

    if (!contact) {
      setError('User not found. You can only message members of your orbits.');
      return;
    }

    setLoading(true);
    try {
      const result = await startDm(contact.id);
      navigation.replace('ChatDetail', {
        conversationId: result.conversationId,
        recipientName: result.recipientName,
      });
    } catch (e) {
      if (__DEV__) console.warn('[NewChat] error:', e instanceof Error ? e.message : e);
      setError('Failed to start chat. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [canSubmit, username, contacts, navigation]);

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const scrollContentStyle: ViewStyle = {
    padding: theme.spacing.base,
    gap: theme.spacing.base,
  };

  const closeBtnStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.xl,
    color: theme.colors.textSecondary,
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
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          contentContainerStyle={scrollContentStyle}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <TextInput
            label="Enter username"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={100}
            testID="new-chat-username-input"
          />

          <ErrorBanner message={error} />

          <Button
            title="Start Chat"
            onPress={handleStartChat}
            loading={loading}
            disabled={!canSubmit}
            variant="primary"
            testID="new-chat-submit-btn"
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default NewChatScreen;
