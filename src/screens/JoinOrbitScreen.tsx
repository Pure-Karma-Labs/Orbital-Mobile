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
  type ValidationReason,
} from '../services/api/errors';
import {
  stripInviteCode,
  formatInviteCode,
  hasV2InviteCodeLength,
} from '../services/crypto/inviteCrypto';
import { RATE_LIMIT_MESSAGE } from '../utils/errorMessages';
import { captureError } from '../services/telemetry';
import type { ThreadsStackParamList } from '../navigation/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JoinOrbitScreenProps = NativeStackScreenProps<
  ThreadsStackParamList,
  'JoinOrbit'
>;

// ---------------------------------------------------------------------------
// Reason routing
// ---------------------------------------------------------------------------

/**
 * Where a server validation reason belongs on this form. Typed as an
 * exhaustive `Record`, so `tsc --noEmit` IS the routing proof: adding a code
 * to `ValidationReason` is a compile error here until it has been routed, and
 * a new reason can never silently fall through to the legacy "invalid code"
 * field copy — which is precisely how a valid code for a full orbit used to
 * read as a typo (Backend #271).
 *
 * `code` means "the code you typed is the problem"; `banner` means the code is
 * fine and something else is in the way:
 * - `GROUP_FULL` — the orbit has no room; the admin has to act, not the user.
 * - `INVITE_EMAIL_MISMATCH` — it is the *pair* (this code, this account) that
 *   is wrong, so pinning it to the code field would misdirect the fix. The
 *   join route actually delivers this outcome as an uncoded 403 (the AuthError
 *   branch below), so this entry exists for Record exhaustiveness only.
 * - `EMAIL_FORMAT` — this form has no email input at all, so it is
 *   unattributable here (the join route does not emit it today).
 */
const REASON_CHANNEL: Record<ValidationReason, 'code' | 'banner'> = {
  INVITE_INVALID: 'code',
  INVITE_USED: 'code',
  INVITE_CANCELLED: 'code',
  INVITE_EXPIRED: 'code',
  GROUP_FULL: 'banner',
  INVITE_EMAIL_MISMATCH: 'banner',
  EMAIL_FORMAT: 'banner',
};

/**
 * Pre-#271 copy, still correct for the two outcomes that genuinely carry no
 * machine-readable reason: the 404 (unknown code) and an unreasoned 400 from
 * an older backend.
 */
const UNREASONED_CODE_ERROR = 'Invalid or expired invite code';

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
      } else if (err instanceof ValidationError && err.reason !== undefined) {
        // A reason the backend named on its 400 (Orbital-Backend
        // POST /api/groups/join — see tests/joinValidationCodes.test.js for the
        // full sentinel → code table). Render the curated copy on the channel
        // that matches what is actually wrong; `e.message` is client copy
        // selected by the code, never server text.
        if (REASON_CHANNEL[err.reason] === 'code') {
          setCodeError(err.message);
        } else {
          setBannerError(err.message);
        }
      } else if (err instanceof ValidationError) {
        // Unreasoned 400: either a backend older than Backend #271 or a code
        // this build does not know. Show the legacy copy, and report the drift
        // with content-free tags only — never the code or the server text
        // (SignupScreen precedent, #746).
        setCodeError(UNREASONED_CODE_ERROR);
        captureError(err, {
          tags: { feature: 'orbit-join', validation_reason_known: 'false' },
        });
      } else if (err instanceof NotFoundError) {
        // 404 — no such invite code. This one legitimately carries no
        // `details.code`, so it is NOT drift and must not be captured.
        setCodeError(UNREASONED_CODE_ERROR);
      } else if (err instanceof ConflictError) {
        // The join route's only 409 — already a member.
        setBannerError('You are already a member of this orbit');
      } else if (err instanceof AuthError && err.statusCode === 403) {
        // Both of the join route's forbiddenError cases — DEMO_BOUNDARY and
        // EMAIL_MISMATCH. Deliberately uncoded on the backend (no client parses
        // a 403 body: client.ts maps every 401/403 to AuthError and discards
        // it), so they share one message. Invites minted from CreateOrbit are
        // always email-bound, so this is a likely legitimate failure and the
        // user can act on it. Residue: a demo-boundary refusal reads as an
        // email mismatch — demo accounts only.
        setBannerError(
          'This invite is not for this account — check you are signed in with the invited email',
        );
      } else {
        // Auth (401), 5xx, crypto and anything unknown: never claim the code is
        // wrong, and never surface a raw error message. Silent here before
        // #787 — a permanent identity-key fault (#675 class) looked like a
        // transient retry prompt, so report it.
        // captureError adds status/api_code for an ApiError (#746).
        captureError(err, { tags: { feature: 'orbit-join' } });
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

          <ErrorBanner message={bannerError} testID="join-orbit-error-banner" />

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
