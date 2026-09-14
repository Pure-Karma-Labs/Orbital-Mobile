/**
 * Create Orbit screen — simple form to create a new orbit (group).
 * Presented as a modal from the Threads tab.
 */

import React, { useCallback, useState } from 'react';
import {
  Alert,
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
import { ErrorBanner } from '../components/ErrorBanner';
import { Header } from '../components/Header';
import { OrbitalKeyboardAvoidingView } from '../components/OrbitalKeyboardAvoidingView';
import { createOrbit, createInviteCode } from '../services/conversationService';
import { ApiError, NetworkError } from '../services/api/errors';
import * as Sentry from '@sentry/react-native';
import { formatInviteCode } from '../services/crypto/inviteCrypto';
import { RATE_LIMIT_MESSAGE } from '../utils/errorMessages';
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
  // Banner only, deliberately: nothing the server can answer here is a verdict
  // on the orbit name. The name is encrypted client-side and never validated by
  // POST /groups — a 400 from that route means a malformed envelope or group id
  // (a client bug), not a bad name — and the 1-50 character rule is enforced by
  // `isValid` disabling the button. So no failure may render as a red border on
  // the field.
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [createdGroupId, setCreatedGroupId] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState('');
  const [email, setEmail] = useState('');
  const [generatingInvite, setGeneratingInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);

  const trimmedName = name.trim();
  const isValid = trimmedName.length >= 1 && trimmedName.length <= 50;

  const handleNameChange = useCallback((text: string) => {
    setName(text);
    setBannerError(null);
  }, []);

  const handleCreate = useCallback(async () => {
    if (!isValid || loading) {
      return;
    }
    setBannerError(null);
    setLoading(true);
    try {
      const result = await createOrbit(trimmedName);
      setCreatedGroupId(result.groupId);
      setCreatedName(trimmedName);
    } catch (err) {
      if (err instanceof NetworkError) {
        setBannerError(err.message);
      } else if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        setBannerError(RATE_LIMIT_MESSAGE);
      } else {
        // Never surface a raw error message: outside __DEV__ these are either
        // hardcoded client copy or server internals. Report it — this branch
        // also catches local crypto faults (identity key, group key wrap), and
        // a permanent fault (#675 class) otherwise presents to the user as a
        // transient retry prompt with no telemetry at all.
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
          tags: {
            feature: 'orbit-create',
            ...(err instanceof ApiError
              ? { status: String(err.statusCode), api_code: err.code }
              : {}),
          },
        });
        setBannerError('Could not create orbit — please try again');
      }
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
    } catch (err) {
      // Same split as handleCreate: no outcome here is a verdict on the email
      // typed above (the server validates it only for shape), so everything
      // lands on the banner — but transport and throttling still say what
      // actually happened.
      if (err instanceof NetworkError) {
        setInviteError(err.message);
      } else if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        setInviteError(RATE_LIMIT_MESSAGE);
      } else {
        setInviteError('Failed to generate invite code. Please try again.');
      }
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
        <OrbitalKeyboardAvoidingView>
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
            <ErrorBanner message={inviteError} />
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
        </OrbitalKeyboardAvoidingView>
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
      <OrbitalKeyboardAvoidingView>
        <View style={contentStyle}>
          <TextInput
            label="Orbit Name"
            value={name}
            onChangeText={handleNameChange}
            autoCapitalize="sentences"
            autoCorrect={false}
            maxLength={50}
            testID="orbit-name-input"
          />

          <ErrorBanner message={bannerError} />

          <Button
            title="Create"
            onPress={handleCreate}
            loading={loading}
            disabled={!isValid}
            variant="primary"
            testID="create-orbit-button"
          />
        </View>
      </OrbitalKeyboardAvoidingView>
    </View>
  );
}

export default CreateOrbitScreen;
