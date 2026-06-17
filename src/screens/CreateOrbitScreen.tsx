/**
 * Create Orbit screen — simple form to create a new orbit (group).
 * Presented as a modal from the Threads tab.
 */

import React, { useCallback, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Share,
  Text,
  TextInput as RNTextInput,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { TextInput } from '../components/TextInput';
import { Button } from '../components/Button';
import { EmojiText } from '../components/EmojiText';
import { Header } from '../components/Header';
import { createOrbit, createInviteCode } from '../services/conversationService';
import { formatInviteCode } from '../services/crypto/inviteCrypto';
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
  const [createdGroupId, setCreatedGroupId] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState('');
  const [email, setEmail] = useState('');
  const [generatingInvite, setGeneratingInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);

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
      setCreatedGroupId(result.groupId);
      setCreatedName(trimmedName);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to create orbit';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [isValid, loading, trimmedName]);

  const handleGenerateInvite = useCallback(async () => {
    if (!createdGroupId || !email.trim()) return;
    setInviteError(null);
    setGeneratingInvite(true);
    try {
      const rawCode = await createInviteCode(createdGroupId, email.trim());
      setGeneratedCode(rawCode);
    } catch {
      setInviteError('Failed to generate invite code. Please try again.');
    } finally {
      setGeneratingInvite(false);
    }
  }, [createdGroupId, email]);

  const handleShare = useCallback(async () => {
    if (!generatedCode) return;
    try {
      await Share.share({
        message: `Join my orbit "${createdName}" on Orbital! Use invite code: ${formatInviteCode(generatedCode)}`,
      });
    } catch {
      // User cancelled share
    }
  }, [generatedCode, createdName]);

  const handleInviteAnother = useCallback(() => {
    Alert.alert(
      'Have you shared this code?',
      'This code will not be shown again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          onPress: () => {
            setGeneratedCode(null);
            setEmail('');
            setInviteError(null);
          },
        },
      ],
    );
  }, []);

  const handleBack = useCallback(() => {
    setGeneratedCode(null);
    setEmail('');
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

  const emailInputStyle: ViewStyle = {
    borderWidth: 1,
    borderColor: theme.colors.borderSubtle,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    marginBottom: theme.spacing.lg,
  };

  const emailInputTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textPrimary,
  };

  const inviteErrorStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.error,
    marginBottom: theme.spacing.md,
  };

  const warningStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.error,
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
  };

  if (createdGroupId != null) {
    // Phase 2: code generated — show formatted code
    if (generatedCode != null) {
      return (
        <View style={containerStyle} testID="create-orbit-success">
          <Header title="Orbit Created" />
          <View style={contentStyle}>
            <EmojiText style={successTitleStyle}>{createdName}</EmojiText>
            <Text style={successSubtitleStyle}>Invite Code Generated</Text>
            <View style={codeBoxStyle}>
              <Text style={codeTextStyle} selectable testID="invite-code-text">
                {formatInviteCode(generatedCode)}
              </Text>
            </View>
            <Text style={warningStyle} testID="code-warning">
              This code will not be shown again.
            </Text>
            <Button
              title="Share Invite Code"
              onPress={handleShare}
              variant="primary"
              testID="share-invite-button"
            />
            <View style={{ height: theme.spacing.sm }} />
            <Button
              title="Invite Another"
              onPress={handleInviteAnother}
              variant="secondary"
              testID="invite-another-button"
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

    // Phase 1: orbit created — prompt for first invite
    return (
      <View style={containerStyle} testID="create-orbit-success">
        <Header title="Orbit Created" />
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={contentStyle}>
            <EmojiText style={successTitleStyle}>{createdName}</EmojiText>
            <Text style={successSubtitleStyle}>Invite your first member</Text>
            <Text style={{
              fontFamily: theme.typography.fontFamily.body,
              fontSize: theme.typography.fontSize.sm,
              color: theme.colors.textSecondary,
              marginBottom: theme.spacing.sm,
            }}>
              Invitee's email:
            </Text>
            <RNTextInput
              style={[emailInputStyle, emailInputTextStyle]}
              value={email}
              onChangeText={setEmail}
              placeholder="email@example.com"
              placeholderTextColor={theme.colors.textTertiary}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              testID="invite-email-input"
            />
            {inviteError != null && (
              <Text style={inviteErrorStyle}>{inviteError}</Text>
            )}
            <Button
              title={generatingInvite ? 'Generating...' : 'Generate Invite Code'}
              onPress={handleGenerateInvite}
              loading={generatingInvite}
              disabled={!email.trim() || generatingInvite}
              variant="primary"
              testID="generate-invite-button"
            />
            <View style={{ height: theme.spacing.sm }} />
            <Button
              title="Skip"
              onPress={handleBack}
              variant="secondary"
              testID="skip-button"
            />
          </View>
        </KeyboardAvoidingView>
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
