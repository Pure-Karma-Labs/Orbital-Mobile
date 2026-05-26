/**
 * Forgot password screen — sends a reset code to the user's email.
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
import { requestPasswordReset } from '../services/authService';
import { ApiError, NetworkError } from '../services/api/errors';
import type { OnPreAuthNavigate } from '../navigation/preAuthTypes';

export interface ForgotPasswordScreenProps {
  onNavigate: OnPreAuthNavigate;
  email?: string;
}

export function ForgotPasswordScreen({
  onNavigate,
  email: initialEmail,
}: ForgotPasswordScreenProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState(initialEmail ?? '');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(): Promise<void> {
    const trimmed = email.trim();
    if (trimmed.length === 0 || !trimmed.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      await requestPasswordReset(trimmed);
      onNavigate('resetPassword', { email: trimmed });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'RATE_LIMITED') {
        setError('Too many attempts — please wait a few minutes');
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

  const warningStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
  };

  const backLinkStyle: TextStyle = {
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
        <View style={{ marginBottom: theme.spacing.lg }}>
          <OrbitalLoader size={64} />
        </View>
        <Text style={titleStyle}>Orbital</Text>
        <AsciiBanner text="Reset your password" />

        <Text style={warningStyle}>
          This resets your login password. Messages on a lost device cannot be recovered.
        </Text>

        <View>
          <TextInput
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={256}
            testID="forgot-email-input"
          />

          <ErrorBanner message={error} />

          <Button
            title="Send Reset Code"
            onPress={handleSubmit}
            loading={loading}
            testID="forgot-submit-button"
          />
        </View>

        <TouchableOpacity
          onPress={() => onNavigate('login')}
          accessibilityRole="button"
          accessibilityLabel="Back to log in"
          testID="forgot-back-link"
        >
          <Text style={backLinkStyle}>Back to log in</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}
