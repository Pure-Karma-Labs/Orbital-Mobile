/**
 * Signup screen — new account creation form with invite code.
 */

import React, { useCallback, useState } from 'react';
import {
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { TextInput, Button, ErrorBanner, OrbitalLoader, AsciiBanner } from '../components';
import { TermsCheckbox } from '../components/TermsCheckbox';
import { signupUser } from '../services/authService';
import { AccountSwitchError, ApiError, AuthError, ConflictError, NetworkError, ValidationError } from '../services/api/errors';
import type { ValidationReason } from '../services/api/errors';
import { formatInviteCode, stripInviteCode, hasV2InviteCodeLength } from '../services/crypto/inviteCrypto';
import { validatePassword, PASSWORD_RULE_HINT } from '../utils/validatePassword';
import { validateUsername } from '../utils/validateUsername';
import { RATE_LIMIT_MESSAGE } from '../utils/errorMessages';
import { validateEmail } from '../utils/validateEmail';
import { captureError } from '../services/telemetry';
import type { OnPreAuthNavigate } from '../navigation/preAuthTypes';

export interface SignupScreenProps {
  onNavigate: OnPreAuthNavigate;
}

/**
 * Where a server validation reason belongs on this form. Typed as an exhaustive
 * `Record`, so adding a code to `ValidationReason` is a compile error here
 * until it has been routed — a new reason can never silently fall through to
 * the generic banner.
 *
 * `INVITE_EMAIL_MISMATCH` is a banner rather than a field error on purpose: it
 * is the *pair* (this code, this email) that is wrong, so pinning it to either
 * single field would misdirect the fix.
 */
const REASON_CHANNEL: Record<ValidationReason, 'email' | 'invite' | 'banner'> = {
  EMAIL_FORMAT: 'email',
  INVITE_INVALID: 'invite',
  INVITE_USED: 'invite',
  INVITE_CANCELLED: 'invite',
  INVITE_EXPIRED: 'invite',
  INVITE_EMAIL_MISMATCH: 'banner',
};

export function SignupScreen({ onNavigate }: SignupScreenProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [inviteCodeError, setInviteCodeError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);

  const handleUsernameChange = useCallback((text: string) => {
    setUsername(text);
    setUsernameError(null);
  }, []);

  const handleEmailChange = useCallback((text: string) => {
    setEmail(text);
    setEmailError(null);
  }, []);

  const handlePasswordChange = useCallback((text: string) => {
    setPassword(text);
    setPasswordError(null);
  }, []);

  const handleInviteCodeChange = useCallback((text: string) => {
    const sanitized = text.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 20);
    setInviteCode(sanitized.length > 0 ? formatInviteCode(sanitized) : '');
    setInviteCodeError(null);
  }, []);

  async function handleSignup(): Promise<void> {
    // Clear every error slot up front: a guard that returns early must never
    // leave a now-false message from the previous submit on screen (a banner
    // beside a fresh field error is exactly the misdiagnosis #777 removes).
    setError(null);
    setUsernameError(null);
    setEmailError(null);
    setPasswordError(null);
    setInviteCodeError(null);

    // Validate all required fields
    if (
      username.trim().length === 0 ||
      email.trim().length === 0 ||
      password.length === 0 ||
      inviteCode.trim().length === 0
    ) {
      setError('All fields are required');
      return;
    }

    // Validate email format
    const emailRuleError = validateEmail(email.trim());
    if (emailRuleError !== null) {
      setEmailError(emailRuleError);
      return;
    }

    // Backend rules enforced client-side so the user is never spent on a
    // round-trip (and the shared auth rate limiter) for a knowable failure.
    // Messages are verbatim from Orbital-Backend/src/routes/auth.js.
    const usernameRuleError = validateUsername(username.trim());
    if (usernameRuleError !== null) {
      setUsernameError(usernameRuleError);
      return;
    }

    const passwordRuleError = validatePassword(password);
    if (passwordRuleError !== null) {
      setPasswordError(passwordRuleError);
      return;
    }

    if (!hasV2InviteCodeLength(stripInviteCode(inviteCode))) {
      setInviteCodeError('Invalid invite code format — must be a 20-character v2 code');
      return;
    }

    setLoading(true);
    try {
      await signupUser(username.trim(), password, email.trim(), stripInviteCode(inviteCode));
      // Auth store update triggers isAuthenticated → App re-renders
    } catch (e) {
      if (e instanceof AccountSwitchError) {
        setError(e.message);
      } else if (e instanceof ApiError && e.code === 'RATE_LIMITED') {
        setError(RATE_LIMIT_MESSAGE);
      } else if (e instanceof ValidationError && e.reason !== undefined) {
        // A reason the backend named: render the curated copy on the field the
        // user can actually act on (#777 — an invite-state failure used to read
        // as "Invalid request" beside four innocent fields).
        const channel = REASON_CHANNEL[e.reason];
        if (channel === 'email') {
          setEmailError(e.message);
        } else if (channel === 'invite') {
          setInviteCodeError(e.message);
        } else {
          setError(e.message);
        }
      } else if (e instanceof AuthError || e instanceof ValidationError || e instanceof ConflictError) {
        if (e instanceof ValidationError) {
          // Unreasoned 400: either an old backend or a code this build does not
          // know. Content-free tag only — the raw code and server text never
          // leave the device (matches JoinOrbitScreen's shape, #746).
          captureError(e, { tags: { feature: 'signup', validation_reason_known: 'false' } });
        }
        setError(e.message || 'Signup failed');
      } else if (e instanceof NetworkError) {
        setError(e.message);
      } else {
        // Not a validation outcome (5xx, crypto, unexpected throw): feature tag
        // only, so validation_reason_known:'false' stays a clean drift signal.
        captureError(e, { tags: { feature: 'signup' } });
        setError('Server error — please try again');
      }
    } finally {
      setLoading(false);
    }
  }

  const outerStyle: ViewStyle = {
    flex: 1,
    backgroundColor: theme.colors.background,
  };

  const scrollContentStyle: ViewStyle = {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: Math.max(insets.top, theme.spacing.xl),
    paddingBottom: 300,
  };

  const titleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.header,
    fontSize: theme.typography.fontSize['2xl'],
    color: theme.colors.blue,
    textAlign: 'center',
    marginBottom: theme.spacing.xs,
  };



  const switchLinkStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.blue,
    textAlign: 'center',
    textDecorationLine: 'underline',
    marginTop: theme.spacing.base,
  };

  return (
    <View style={outerStyle}>
      <ScrollView
        contentContainerStyle={scrollContentStyle}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
      >
        <View style={{marginBottom: theme.spacing.lg}}>
          <OrbitalLoader size={64} />
        </View>
        <Text style={titleStyle}>Orbital</Text>
        <AsciiBanner text="Create your account" />

        <View>
          <TextInput
            label="Username"
            value={username}
            onChangeText={handleUsernameChange}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={64}
            error={usernameError}
            testID="signup-username-input"
          />
          <TextInput
            label="Email"
            value={email}
            onChangeText={handleEmailChange}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            maxLength={256}
            error={emailError}
            testID="signup-email-input"
          />
          <TextInput
            label="Password"
            value={password}
            onChangeText={handlePasswordChange}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="newPassword"
            maxLength={128}
            helperText={PASSWORD_RULE_HINT}
            error={passwordError}
            testID="signup-password-input"
          />
          <TextInput
            label="Invite Code"
            value={inviteCode}
            onChangeText={handleInviteCodeChange}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={24}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
            error={inviteCodeError}
            testID="signup-invite-code-input"
          />

          <ErrorBanner message={error} testID="signup-error-banner" />

          <TermsCheckbox
            checked={termsAccepted}
            onToggle={() => setTermsAccepted((v) => !v)}
            includePrivacyLink
            testID="signup-terms-checkbox"
          />

          <Button
            title="Sign Up"
            onPress={handleSignup}
            loading={loading}
            disabled={!termsAccepted}
            testID="signup-submit-button"
          />
        </View>

        <TouchableOpacity
          onPress={() => onNavigate('login')}
          accessibilityRole="button"
          accessibilityLabel="Switch to log in"
          testID="signup-switch-to-login"
        >
          <Text style={switchLinkStyle}>Already have an account? Log in</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}
