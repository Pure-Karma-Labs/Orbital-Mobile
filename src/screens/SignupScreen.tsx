/**
 * Signup screen — new account creation form with invite code.
 */

import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import { TextInput, Button, ErrorBanner } from '../components';
import { signupUser } from '../services/authService';
import { AuthError, NetworkError, ValidationError } from '../services/api/errors';

export interface SignupScreenProps {
  onSwitchToLogin: () => void;
}

export function SignupScreen({ onSwitchToLogin }: SignupScreenProps): React.JSX.Element {
  const theme = useTheme();

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
      if (e instanceof AuthError || e instanceof ValidationError) {
        setError('Invalid username or password');
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
    paddingVertical: theme.spacing.xl,
  };

  const titleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.header,
    fontSize: theme.typography.fontSize['2xl'],
    color: theme.colors.blue,
    textAlign: 'center',
    marginBottom: theme.spacing.xs,
  };

  const subtitleStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
  };

  const switchLinkStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.blue,
    textAlign: 'center',
    marginTop: theme.spacing.base,
  };

  return (
    <KeyboardAvoidingView
      style={outerStyle}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={scrollContentStyle}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={titleStyle}>Orbital</Text>
        <Text style={subtitleStyle}>Create your account</Text>

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

        <Button
          title="Sign Up"
          onPress={handleSignup}
          loading={loading}
          testID="signup-submit-button"
        />

        <TouchableOpacity
          onPress={onSwitchToLogin}
          accessibilityRole="button"
          accessibilityLabel="Switch to log in"
          testID="signup-switch-to-login"
        >
          <Text style={switchLinkStyle}>Already have an account? Log in</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
