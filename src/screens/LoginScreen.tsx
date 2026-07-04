/**
 * Login screen — email + password auth form.
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
import { TextInput, Button, ErrorBanner, SuccessBanner, OrbitalLoader, AsciiBanner } from '../components';
import { loginUser } from '../services/authService';
import { AuthError, ConflictError, NetworkError, ValidationError } from '../services/api/errors';
import type { OnPreAuthNavigate } from '../navigation/preAuthTypes';

export interface LoginScreenProps {
  onNavigate: OnPreAuthNavigate;
  successMessage?: string;
}

export function LoginScreen({ onNavigate, successMessage }: LoginScreenProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSuccess, setShowSuccess] = useState(true);

  async function handleLogin(): Promise<void> {
    if (email.trim().length === 0 || password.length === 0) {
      setError('Please enter your email and password');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      await loginUser(email.trim(), password);
      // Auth store update triggers isAuthenticated → App re-renders
    } catch (e) {
      if (e instanceof AuthError || e instanceof ValidationError || e instanceof ConflictError) {
        setError('Invalid email or password');
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



  const switchLinkStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.blue,
    textAlign: 'center',
    textDecorationLine: 'underline',
    marginTop: theme.spacing.base,
  };

  const forgotLinkStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    textDecorationLine: 'underline',
    marginTop: theme.spacing.base,
  };

  function handleEmailChange(text: string): void {
    setEmail(text);
    setShowSuccess(false);
  }

  function handlePasswordChange(text: string): void {
    setPassword(text);
    setShowSuccess(false);
  }

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
        <AsciiBanner text="Sign in to your account" />

        {successMessage && showSuccess && (
          <SuccessBanner message={successMessage} testID="login-success-banner" />
        )}

        <View>
          <TextInput
            label="Email"
            value={email}
            onChangeText={handleEmailChange}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            maxLength={256}
            testID="login-email-input"
          />
          <TextInput
            label="Password"
            value={password}
            onChangeText={handlePasswordChange}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={128}
            testID="login-password-input"
          />

          <ErrorBanner message={error} />

          <Button
            title="Log In"
            onPress={handleLogin}
            loading={loading}
            testID="login-submit-button"
          />
        </View>

        <TouchableOpacity
          onPress={() => onNavigate('forgotPassword')}
          accessibilityRole="button"
          accessibilityLabel="Forgot password"
          testID="login-forgot-password"
        >
          <Text style={forgotLinkStyle}>Forgot password?</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => onNavigate('signup')}
          accessibilityRole="button"
          accessibilityLabel="Switch to sign up"
          testID="login-switch-to-signup"
        >
          <Text style={switchLinkStyle}>Don&apos;t have an account? Sign up</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}
