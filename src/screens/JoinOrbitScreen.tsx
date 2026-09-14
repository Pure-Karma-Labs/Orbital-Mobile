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
  ConflictError,
  NetworkError,
  NotFoundError,
  ValidationError,
} from '../services/api/errors';
import {
  stripInviteCode,
  formatInviteCode,
  isValidV2InviteCode,
} from '../services/crypto/inviteCrypto';
import { RATE_LIMIT_MESSAGE } from '../utils/errorMessages';
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
    // attempt spends the shared auth rate-limit budget.
    if (!isValidV2InviteCode(trimmedCode)) {
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
        setCodeError('Invalid or expired invite code');
      } else if (err instanceof ConflictError) {
        // The join route's only 409 — groups.js:273.
        setBannerError('You are already a member of this orbit');
      } else {
        // Auth, 5xx, crypto and anything unknown: never claim the code is wrong,
        // and never surface a raw error message.
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
