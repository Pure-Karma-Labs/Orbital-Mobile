/**
 * Signup screen — new account creation form with invite code.
 */

import React, { useState } from 'react';
import {
  Linking,
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
import { signupUser } from '../services/authService';
import { AuthError, ConflictError, NetworkError, ValidationError } from '../services/api/errors';
import type { OnPreAuthNavigate } from '../navigation/preAuthTypes';

export interface SignupScreenProps {
  onNavigate: OnPreAuthNavigate;
}

export function SignupScreen({ onNavigate }: SignupScreenProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSignup(): Promise<void> {
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
    if (!email.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      await signupUser(username.trim(), password, email.trim(), inviteCode.trim());
      // Auth store update triggers isAuthenticated → App re-renders
    } catch (e) {
      if (e instanceof AuthError || e instanceof ValidationError || e instanceof ConflictError) {
        setError(e.message || 'Signup failed');
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



  const legalTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.md,
  };

  const legalLinkStyle: TextStyle = {
    color: theme.colors.blue,
    textDecorationLine: 'underline',
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
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={64}
            testID="signup-username-input"
          />
          <TextInput
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            maxLength={256}
            testID="signup-email-input"
          />
          <TextInput
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={128}
            testID="signup-password-input"
          />
          <TextInput
            label="Invite Code"
            value={inviteCode}
            onChangeText={setInviteCode}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={64}
            testID="signup-invite-code-input"
          />

          <ErrorBanner message={error} />

          <Text style={legalTextStyle}>
            By creating an account, you agree to our{' '}
            <Text
              style={legalLinkStyle}
              accessibilityRole="link"
              testID="signup-terms-link"
              onPress={() => Linking.openURL('https://orbitl.org/terms').catch(() => {})}
            >
              Terms of Service
            </Text>
            {' '}and{' '}
            <Text
              style={legalLinkStyle}
              accessibilityRole="link"
              testID="signup-privacy-link"
              onPress={() => Linking.openURL('https://orbitl.org/privacy').catch(() => {})}
            >
              Privacy Policy
            </Text>
            .
          </Text>

          <Button
            title="Sign Up"
            onPress={handleSignup}
            loading={loading}
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
