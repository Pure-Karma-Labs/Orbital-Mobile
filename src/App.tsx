/**
 * Orbital Mobile
 * https://github.com/Pure-Karma-Labs/Orbital-Mobile
 *
 * @format
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StatusBar,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from './theme';
import { useAuth } from './stores';
import { restoreSession } from './services/authService';
import { LoginScreen } from './screens/LoginScreen';
import { SignupScreen } from './screens/SignupScreen';
import { AppNavigator } from './navigation';

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
        <AppNavigator />
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

export default App;
