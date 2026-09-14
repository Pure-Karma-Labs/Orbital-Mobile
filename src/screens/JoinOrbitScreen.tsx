/**
 * Join Orbit screen — enter an invite code to join an existing orbit.
 * Presented as a modal from the Threads tab.
 */

import React, { useCallback, useState } from 'react';
import {
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { TextInput } from '../components/TextInput';
import { Button } from '../components/Button';
import { ErrorBanner } from '../components/ErrorBanner';
import { Header } from '../components/Header';
import { OrbitalKeyboardAvoidingView } from '../components/OrbitalKeyboardAvoidingView';
import { joinOrbit } from '../services/conversationService';
import {
  ApiError,
  AuthError,
  ConflictError,
  NetworkError,
  NotFoundError,
  ValidationError,
} from '../services/api/errors';
import {
  stripInviteCode,
  formatInviteCode,
  hasV2InviteCodeLength,
} from '../services/crypto/inviteCrypto';
import { RATE_LIMIT_MESSAGE } from '../utils/errorMessages';
import * as Sentry from '@sentry/react-native';
import type { ThreadsStackParamList } from '../navigation/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JoinOrbitScreenProps = NativeStackScreenProps<
  ThreadsStackParamList,
  'JoinOrbit'
>;

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function JoinOrbitScreen({
  navigation,
}: JoinOrbitScreenProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  // Two channels: `codeError` is a verdict on the code the user typed (red
  // border under the field); `bannerError` is for outcomes the code is not
  // responsible for — transport, throttling, anything unattributable.
  const [codeError, setCodeError] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const trimmedCode = stripInviteCode(code);
  const isValid = trimmedCode.length > 0;

  const handleCodeChange = useCallback((text: string) => {
    const sanitized = text.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 20);
    setCode(sanitized.length > 0 ? formatInviteCode(sanitized) : '');
    setCodeError(null);
    setBannerError(null);
  }, []);

  const handleJoin = useCallback(async () => {
    if (!isValid || loading) {
      return;
    }
    setCodeError(null);
    setBannerError(null);

    // Pre-flight: a mistyped length is knowable without a request, and every
    // attempt spends this user's contentCreationLimiter budget (60 per 15 min,
    // shared with thread and reply creation — rateLimiters.js), so a typo here
    // costs the user posting headroom, not just a round trip.
    if (!hasV2InviteCodeLength(trimmedCode)) {
      setCodeError('Invalid invite code format — must be a 20-character v2 code');
      return;
    }

    setLoading(true);
    try {
      await joinOrbit(trimmedCode);
      navigation.goBack();
    } catch (err) {
      if (err instanceof NetworkError) {
        setBannerError(err.message);
      } else if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        setBannerError(RATE_LIMIT_MESSAGE);
      } else if (err instanceof ValidationError || err instanceof NotFoundError) {
        // 400 (used / expired / DM code) and 404 (unknown code) are verdicts on
        // this code — Orbital-Backend/src/routes/groups.js:263-271.
        // KNOWN MISROUTE: groups.js:275 answers GROUP_FULL with the same 400,
        // which is indistinguishable client-side, so a valid code for a full
        // orbit reads here as "invalid or expired". Fixing it needs a
        // machine-readable reason on the 400 (backend follow-up pending).
        setCodeError('Invalid or expired invite code');
      } else if (err instanceof ConflictError) {
        // The join route's only 409 — groups.js:273.
        setBannerError('You are already a member of this orbit');
      } else if (err instanceof AuthError && err.statusCode === 403) {
        // Both of the join route's forbiddenError cases — DEMO_BOUNDARY
        // (groups.js:265) and EMAIL_MISMATCH (groups.js:277). Invites minted from
        // CreateOrbit are always email-bound, so this is a likely legitimate
        // failure and the user can act on it.
        setBannerError(
          'This invite is not for this account — check you are signed in with the invited email',
        );
      } else {
        // Auth (401), 5xx, crypto and anything unknown: never claim the code is
        // wrong, and never surface a raw error message. Silent here before
        // #787 — a permanent identity-key fault (#675 class) looked like a
        // transient retry prompt, so report it.
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
          tags: {
            feature: 'orbit-join',
            ...(err instanceof ApiError
              ? { status: String(err.statusCode), api_code: err.code }
              : {}),
          },
        });
        setBannerError('Could not join orbit — please try again');
      }
    } finally {
      setLoading(false);
    }
  }, [isValid, loading, trimmedCode, navigation]);

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

  return (
    <View style={containerStyle} testID="join-orbit-screen">
      <Header
        title="Join an Orbit"
        onBack={handleBack}
        backLabel="Back"
      />
      <OrbitalKeyboardAvoidingView>
        <View style={contentStyle}>
          <TextInput
            label="Invite Code"
            value={code}
            onChangeText={handleCodeChange}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={24}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
            error={codeError}
            testID="invite-code-input"
          />

          <ErrorBanner message={bannerError} />

          <Button
            title="Join"
            onPress={handleJoin}
            loading={loading}
            disabled={!isValid}
            variant="primary"
            testID="join-orbit-button"
          />
        </View>
      </OrbitalKeyboardAvoidingView>
    </View>
  );
}

export default JoinOrbitScreen;
