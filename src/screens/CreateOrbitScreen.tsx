/**
 * Create Orbit screen — simple form to create a new orbit (group).
 * Presented as a modal from the Threads tab.
 */

import React, { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Share,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { TextInput } from '../components/TextInput';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { createOrbit } from '../services/conversationService';
import type { ThreadsStackParamList } from '../navigation/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateOrbitScreenProps = NativeStackScreenProps<
  ThreadsStackParamList,
  'CreateOrbit'
>;

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function CreateOrbitScreen({
  navigation,
}: CreateOrbitScreenProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState('');

  const trimmedName = name.trim();
  const isValid = trimmedName.length >= 1 && trimmedName.length <= 50;

  const handleCreate = useCallback(async () => {
    if (!isValid || loading) {
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const result = await createOrbit(trimmedName);
      setCreatedName(trimmedName);
      setInviteCode(result.inviteCode);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to create orbit';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [isValid, loading, trimmedName]);

  const handleShare = useCallback(async () => {
    if (!inviteCode) return;
    try {
      await Share.share({
        message: `Join my orbit "${createdName}" on Orbital! Use invite code: ${inviteCode}`,
      });
    } catch {
      // User cancelled share
    }
  }, [inviteCode, createdName]);

  const handleBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const containerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
    paddingTop: insets.top,
  };

  const contentStyle: ViewStyle = {
    flex: 1,
    paddingHorizontal: theme.spacing.base,
    paddingTop: theme.spacing.lg,
  };

  const errorStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.error,
    marginBottom: theme.spacing.md,
  };

  const successTitleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.header,
    fontSize: theme.typography.fontSize.xl,
    color: theme.colors.textPrimary,
    textAlign: 'center',
    marginBottom: theme.spacing.md,
  };

  const successSubtitleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
  };

  const codeBoxStyle: ViewStyle = {
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing.lg,
    alignItems: 'center',
    marginBottom: theme.spacing.lg,
    backgroundColor: theme.colors.surfaceElevated,
  };

  const codeTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.mono,
    fontSize: theme.typography.fontSize['2xl'],
    color: theme.colors.textPrimary,
    letterSpacing: 4,
  };

  if (inviteCode != null) {
    return (
      <View style={containerStyle} testID="create-orbit-success">
        <Header title="Orbit Created" />
        <View style={contentStyle}>
          <Text style={successTitleStyle}>{createdName}</Text>
          <Text style={successSubtitleStyle}>
            Share this invite code so others can join your orbit.
          </Text>
          <View style={codeBoxStyle}>
            <Text style={codeTextStyle} selectable testID="invite-code-text">
              {inviteCode}
            </Text>
          </View>
          <Button
            title="Share Invite Code"
            onPress={handleShare}
            variant="primary"
            testID="share-invite-button"
          />
          <View style={{ height: theme.spacing.sm }} />
          <Button
            title="Done"
            onPress={handleBack}
            variant="secondary"
            testID="done-button"
          />
        </View>
      </View>
    );
  }

  return (
    <View style={containerStyle} testID="create-orbit-screen">
      <Header
        title="Create an Orbit"
        onBack={handleBack}
        backLabel="Back"
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={contentStyle}>
          <TextInput
            label="Orbit Name"
            value={name}
            onChangeText={setName}
            autoCapitalize="sentences"
            autoCorrect={false}
            maxLength={50}
            testID="orbit-name-input"
          />

          {error != null && <Text style={errorStyle}>{error}</Text>}

          <Button
            title="Create"
            onPress={handleCreate}
            loading={loading}
            disabled={!isValid}
            variant="primary"
            testID="create-orbit-button"
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

export default CreateOrbitScreen;
