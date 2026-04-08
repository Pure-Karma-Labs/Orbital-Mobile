/**
 * Orbital Mobile
 * https://github.com/Pure-Karma-Labs/Orbital-Mobile
 *
 * @format
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  SafeAreaView,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from './theme';
import { useAuth } from './stores';
import { restoreSession, logout } from './services/authService';
import { LoginScreen } from './screens/LoginScreen';
import { SignupScreen } from './screens/SignupScreen';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AppContent />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function AppContent(): React.JSX.Element {
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading');
  const [showSignup, setShowSignup] = useState(false);
  const { isAuthenticated } = useAuth();
  const theme = useTheme();
  const isDark = theme.colorScheme === 'dark';

  // Cold start: attempt session restoration from stored token
  useEffect(() => {
    restoreSession()
      .then((restored) => {
        if (!restored) setAuthStatus('unauthenticated');
      })
      .catch(() => setAuthStatus('unauthenticated'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to store auth changes (login success, logout, 401 clearance)
  useEffect(() => {
    if (isAuthenticated) {
      setAuthStatus('authenticated');
    } else if (authStatus !== 'loading') {
      setAuthStatus('unauthenticated');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  return (
    <>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={theme.colors.background}
      />
      {authStatus === 'loading' && <LoadingView />}
      {authStatus === 'unauthenticated' && (
        showSignup
          ? <SignupScreen onSwitchToLogin={() => setShowSignup(false)} />
          : <LoginScreen onSwitchToSignup={() => setShowSignup(true)} />
      )}
      {authStatus === 'authenticated' && (
        <AuthenticatedPlaceholder />
      )}
    </>
  );
}

function LoadingView(): React.JSX.Element {
  const theme = useTheme();

  const containerStyle: ViewStyle = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.background,
  };

  return (
    <View style={containerStyle}>
      <ActivityIndicator size="large" color={theme.colors.blue} />
    </View>
  );
}

function AuthenticatedPlaceholder(): React.JSX.Element {
  const theme = useTheme();
  const { displayName, username } = useAuth();
  const name = displayName ?? username ?? 'there';

  const containerStyle: ViewStyle = {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.background,
    padding: theme.spacing.lg,
  };

  const welcomeStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.header,
    fontSize: theme.typography.fontSize.xl,
    color: theme.colors.textPrimary,
    marginBottom: theme.spacing.lg,
  };

  const logoutStyle: ViewStyle = {
    backgroundColor: theme.colors.blue,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.borderRadius.base,
  };

  const logoutTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.bodyBold,
    fontSize: theme.typography.fontSize.base,
    color: '#FFFFFF',
  };

  async function handleLogout(): Promise<void> {
    await logout();
  }

  return (
    <SafeAreaView style={containerStyle}>
      <Text style={welcomeStyle}>Welcome, {name}</Text>
      <TouchableOpacity
        style={logoutStyle}
        onPress={handleLogout}
        accessibilityRole="button"
        accessibilityLabel="Log out"
        testID="logout-button"
      >
        <Text style={logoutTextStyle}>Log Out</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

export default App;
