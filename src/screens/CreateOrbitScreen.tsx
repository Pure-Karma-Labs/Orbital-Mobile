/**
 * Create Orbit screen — simple form to create a new orbit (group).
 * Presented as a modal from the Threads tab.
 */

import React, { useCallback, useState } from 'react';
import {
  Alert,
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
import { EmojiText } from '../components/EmojiText';
import { ErrorBanner } from '../components/ErrorBanner';
import { Header } from '../components/Header';
import { OrbitalKeyboardAvoidingView } from '../components/OrbitalKeyboardAvoidingView';
import { createOrbit, createInviteCode } from '../services/conversationService';
import {
  ApiError,
  AuthError,
  NetworkError,
  NotFoundError,
  ValidationError,
} from '../services/api/errors';
import { captureError } from '../services/telemetry';
import { formatInviteCode } from '../services/crypto/inviteCrypto';
import { RATE_LIMIT_MESSAGE } from '../utils/errorMessages';
import { validateEmail } from '../utils/validateEmail';
import type { ThreadsStackParamList } from '../navigation/types';

// ---------------------------------------------------------------------------
// Invite-generation copy
// ---------------------------------------------------------------------------

/**
 * Permanent refusals: the orbit, not the email, is the problem, and no retry
 * will change the answer. 403 covers both of the route's forbiddenError cases
 * (not the creator, and the demo-account boundary) — a 403 body is never
 * parsed by this client, so they share one message.
 */
const NOT_ALLOWED_COPY = "You can't create invites for this orbit";
const ORBIT_GONE_COPY = 'This orbit no longer exists';

/**
 * Transient / unattributable: retrying is honest advice. Also the copy for a
 * pending group-key wrap, which resolves on its own once another key holder
 * delivers the wrap.
 */
const GENERIC_INVITE_FAILURE_COPY =
  'Failed to generate invite code. Please try again.';

/**
 * `PendingWrapError` (services/crypto/contentCrypto) matched by `name` rather
 * than `instanceof`: importing the class drags contentCrypto's module graph —
 * orbital-signal, the conversation repository and `useAppStore` (→ MMKV via
 * nitro) — into a screen that touches none of it, for one branch whose only
 * effect is to suppress a Sentry capture. `name` is assigned in the
 * constructor and is already the load-bearing discriminator for this class
 * across the service suites.
 */
function isPendingWrapError(err: unknown): boolean {
  return err instanceof Error && err.name === 'PendingWrapError';
}

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
  // Two channels for the invite step. `inviteEmailError` is the ONE verdict on
  // the address typed above — the client's own format check, or the backend's
  // `EMAIL_FORMAT` reason, which on this route is emitted by
  // `normalizeEmail(target_email)` before any DB access and so judges nothing
  // but the invitee email (Backend #294). `inviteError` is the banner: every
  // other outcome is about the orbit, the network or this device, and pinning
  // any of them under the field would accuse a correct address.
  const [inviteEmailError, setInviteEmailError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);

  const trimmedName = name.trim();
  const isValid = trimmedName.length >= 1 && trimmedName.length <= 50;

  const handleNameChange = useCallback((text: string) => {
    setName(text);
    setBannerError(null);
  }, []);

  const handleEmailChange = useCallback((text: string) => {
    setEmail(text);
    // Clear both slots: whichever one is showing, the user is now acting on it.
    setInviteEmailError(null);
    setInviteError(null);
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
        // captureError adds status/api_code for an ApiError (#746).
        captureError(err, { tags: { feature: 'orbit-create' } });
        setBannerError('Could not create orbit — please try again');
      }
    } finally {
      setLoading(false);
    }
  }, [isValid, loading, trimmedName]);

  const handleGenerateInvite = useCallback(async () => {
    const trimmedEmail = email.trim();
    if (!createdGroupId || !trimmedEmail) return;
    setInviteEmailError(null);
    setInviteError(null);

    // Pre-flight, before the spinner: the rule is byte-identical to the
    // backend's `isValidEmail` (see utils/validateEmail.ts), and every request
    // — rejected ones included — spends one of this user's 20 `inviteLimiter`
    // slots per 15 minutes, so a typo must not cost invite headroom. The
    // backend's own `EMAIL_FORMAT` reason is still routed below, as the safety
    // net for any divergence between the two rules (#786).
    const emailProblem = validateEmail(trimmedEmail);
    if (emailProblem !== null) {
      setInviteEmailError(emailProblem);
      return;
    }

    setGeneratingInvite(true);
    try {
      const rawCode = await createInviteCode(createdGroupId, trimmedEmail);
      setGeneratedCode(rawCode);
    } catch (err) {
      if (err instanceof NetworkError) {
        setInviteError(err.message);
      } else if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        setInviteError(RATE_LIMIT_MESSAGE);
      } else if (err instanceof ValidationError && err.reason === 'EMAIL_FORMAT') {
        // The only server outcome that is a verdict on the address.
        // `err.message` is client copy selected by the code (errors.ts), never
        // server text.
        setInviteEmailError(err.message);
      } else if (err instanceof AuthError && err.statusCode === 403) {
        setInviteError(NOT_ALLOWED_COPY);
      } else if (err instanceof NotFoundError) {
        setInviteError(ORBIT_GONE_COPY);
      } else if (isPendingWrapError(err)) {
        // A modelled transient state, not a fault: the group key wrap for this
        // device has not been delivered yet. Retrying is the right advice and
        // there is nothing to report.
        setInviteError(GENERIC_INVITE_FAILURE_COPY);
      } else {
        // Everything unattributable: 401, 5xx, an uncoded 400 (a client-contract
        // bug on this route), a code hash collision, and local crypto faults.
        // Silent before #871 — a permanent identity-key fault (#675 class)
        // presented to the user as a transient retry prompt with no telemetry.
        // captureError adds status/api_code for an ApiError (#746); `api_code`
        // is `VALIDATION_ERROR` for every 400 and `reason` is never sent, so
        // without the content-free flag below a future reason this build does
        // not route would be invisible in Sentry.
        const tags: Record<string, string> = { feature: 'orbit-invite-create' };
        if (err instanceof ValidationError && err.reason !== undefined) {
          tags.validation_reason_routed = 'false';
        }
        captureError(err, { tags });
        setInviteError(GENERIC_INVITE_FAILURE_COPY);
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
            setInviteEmailError(null);
            setInviteError(null);
          },
        },
      ],
    );
  }, []);

  const handleBack = useCallback(() => {
    setGeneratedCode(null);
    setEmail('');
    setInviteEmailError(null);
    setInviteError(null);
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
            {/*
              Shared TextInput, so a bad address gets a red border, an
              `accessibilityHint` carrying the message and a
              `invite-email-input-error` node. Its defaults are wrong for an
              email field (sentences-casing, autocorrect on, default keyboard),
              so all four keyboard props are carried over explicitly;
              `textContentType` stays unset because `emailAddress` would offer
              the inviter their OWN address into an invitee field.
            */}
            <TextInput
              label="Invitee's Email"
              value={email}
              onChangeText={handleEmailChange}
              placeholder="email@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={256}
              error={inviteEmailError}
              testID="invite-email-input"
            />
            <ErrorBanner message={inviteError} testID="invite-error-banner" />
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
