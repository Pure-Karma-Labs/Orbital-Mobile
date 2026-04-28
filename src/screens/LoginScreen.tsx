/**
 * Login screen — username + password auth form.
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
import { useTheme } from '../theme';
import { TextInput, Button, ErrorBanner } from '../components';
import { loginUser } from '../services/authService';
import { AuthError, NetworkError, ValidationError } from '../services/api/errors';

export interface LoginScreenProps {
  onSwitchToSignup: () => void;
}

export function LoginScreen({ onSwitchToSignup }: LoginScreenProps): React.JSX.Element {
  const theme = useTheme();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLogin(): Promise<void> {
    if (username.trim().length === 0 || password.length === 0) {
      setError('Please enter your username and password');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      await loginUser(username.trim(), password);
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
    paddingTop: theme.spacing.xl,
    paddingBottom: 300,
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
    <View style={outerStyle}>
      <ScrollView
        contentContainerStyle={scrollContentStyle}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
      >
        <Text style={titleStyle}>Orbital</Text>
        <Text style={subtitleStyle}>Sign in to your account</Text>

        <View>
          <TextInput
            label="Username"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={64}
            testID="login-username-input"
          />
          <TextInput
            label="Password"
            value={password}
            onChangeText={setPassword}
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
          onPress={onSwitchToSignup}
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
