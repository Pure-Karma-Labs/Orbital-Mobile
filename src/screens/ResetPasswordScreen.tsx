/**
 * Reset password screen — enter code + new password to complete the reset.
 */

import React, { useState } from 'react';
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
import { resetPassword } from '../services/authService';
import { ApiError, NetworkError, ValidationError } from '../services/api/errors';
import { maskEmail } from '../utils/maskEmail';
import { validatePassword } from '../utils/validatePassword';
import type { OnPreAuthNavigate } from '../navigation/preAuthTypes';

export interface ResetPasswordScreenProps {
  onNavigate: OnPreAuthNavigate;
  email: string;
}

export function ResetPasswordScreen({
  onNavigate,
  email,
}: ResetPasswordScreenProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(): Promise<void> {
    // Normalize code: strip whitespace + hyphens, uppercase
    const normalizedCode = code.trim().replace(/[\s-]/g, '').toUpperCase();

    if (normalizedCode.length !== 8) {
      setError('Reset code must be 8 characters');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError !== null) {
      setError(passwordError);
      return;
    }

    setError(null);
    setLoading(true);
    try {
      await resetPassword(email, normalizedCode, newPassword);
      // Clear sensitive state before navigating
      setNewPassword('');
      setConfirmPassword('');
      setCode('');
      onNavigate('login', { successMessage: 'Password reset successfully. Please log in.' });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'RATE_LIMITED') {
        setError('Too many attempts — please request a new code');
      } else if (e instanceof ValidationError) {
        setError('Invalid or expired code. Please try again or request a new code.');
      } else if (e instanceof NetworkError) {
        setError(e.message);
      } else {
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

  const infoStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
  };

  const linkStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.blue,
    textAlign: 'center',
    textDecorationLine: 'underline',
    marginTop: theme.spacing.base,
  };

  const secondaryLinkStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    textDecorationLine: 'underline',
    marginTop: theme.spacing.sm,
  };

  return (
    <View style={outerStyle}>
      <ScrollView
        contentContainerStyle={scrollContentStyle}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
      >
        <View style={{ marginBottom: theme.spacing.lg }}>
          <OrbitalLoader size={64} />
        </View>
        <Text style={titleStyle}>Orbital</Text>
        <AsciiBanner text="Enter reset code" />

        <Text style={infoStyle}>
          We sent a code to {maskEmail(email)}
        </Text>

        <View>
          <TextInput
            label="Reset Code"
            value={code}
            onChangeText={setCode}
            autoCapitalize="characters"
            autoCorrect={false}
            textContentType="oneTimeCode"
            maxLength={12}
            testID="reset-code-input"
          />
          <TextInput
            label="New Password"
            value={newPassword}
            onChangeText={setNewPassword}
            secureTextEntry
            textContentType="newPassword"
            maxLength={128}
            testID="reset-new-password-input"
          />
          <TextInput
            label="Confirm Password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            textContentType="newPassword"
            maxLength={128}
            testID="reset-confirm-password-input"
          />

          <ErrorBanner message={error} />

          <Button
            title="Reset Password"
            onPress={handleSubmit}
            loading={loading}
            testID="reset-submit-button"
          />
        </View>

        <TouchableOpacity
          onPress={() => onNavigate('forgotPassword', { email })}
          accessibilityRole="button"
          accessibilityLabel="Request a new code"
          testID="reset-resend-link"
        >
          <Text style={linkStyle}>Didn&apos;t receive it?</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => onNavigate('forgotPassword', { email })}
          accessibilityRole="button"
          accessibilityLabel="Back to forgot password"
          testID="reset-back-link"
        >
          <Text style={secondaryLinkStyle}>Back</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}
