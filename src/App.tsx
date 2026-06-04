/**
 * Orbital Mobile
 * https://github.com/Pure-Karma-Labs/Orbital-Mobile
 *
 * @format
 */

import React, { useEffect, useState } from 'react';
import {
  StatusBar,
  View,
  type ViewStyle,
} from 'react-native';
import * as Sentry from '@sentry/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from './theme';
import { useAuth } from './stores';
import { useAppStore } from './stores/useAppStore';
import { bootstrap } from './bootstrap';
import { restoreSession } from './services/authService';
import { websocketManager } from './services/websocket';
import {
  initNotifications,
  requestPermissionAndRegister,
  setupForegroundHandler,
  setupNotificationTapHandler,
} from './services/notificationService';
import type { PreAuthScreen, PreAuthParams } from './navigation/preAuthTypes';
import { LoginScreen } from './screens/LoginScreen';
import { SignupScreen } from './screens/SignupScreen';
import { ForgotPasswordScreen } from './screens/ForgotPasswordScreen';
import { ResetPasswordScreen } from './screens/ResetPasswordScreen';
import { AppNavigator } from './navigation';
import { OrbitalSpinner } from './components/OrbitalSpinner';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

function App(): React.JSX.Element {
  const colorScheme = useAppStore((s) => s.colorScheme);
  return (
    <SafeAreaProvider>
      <ThemeProvider colorSchemeOverride={colorScheme}>
        <AppContent />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function AppContent(): React.JSX.Element {
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading');
  const [preAuthScreen, setPreAuthScreen] = useState<PreAuthScreen>('login');
  const [preAuthParams, setPreAuthParams] = useState<PreAuthParams>({});
  const { isAuthenticated, userId } = useAuth();

  function handleNavigate(screen: PreAuthScreen, params?: PreAuthParams): void {
    setPreAuthScreen(screen);
    setPreAuthParams(params ?? {});
  }
  const theme = useTheme();
  const isDark = theme.colorScheme === 'dark';

  // Cold start: bootstrap storage/db, then attempt session restoration
  useEffect(() => {
    bootstrap()
      .then(() => restoreSession())
      .then((restored) => {
        if (!restored) setAuthStatus('unauthenticated');
      })
      .catch((e: unknown) => {
        Sentry.captureException(e);
        setAuthStatus('unauthenticated');
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to store auth changes (login success, logout, 401 clearance)
  useEffect(() => {
    if (isAuthenticated) {
      setAuthStatus('authenticated');
      Sentry.setUser(userId ? { id: userId } : null);
    } else if (authStatus !== 'loading') {
      setAuthStatus('unauthenticated');
      Sentry.setUser(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  // WebSocket + push notification lifecycle
  useEffect(() => {
    if (isAuthenticated) {
      websocketManager.connect();

      // Initialize push notifications and request permission.
      // Capture unsubscribe for the token-refresh listener to prevent leak
      // on login/logout cycles.
      let unsubTokenRefresh: (() => void) | undefined;
      initNotifications()
        .then(() => requestPermissionAndRegister())
        .then((unsub) => { unsubTokenRefresh = unsub; })
        .catch((e: unknown) => {
          if (__DEV__) console.warn('[Push]', e instanceof Error ? e.message : e);
        });
      const unsubForeground = setupForegroundHandler();
      const unsubTapHandler = setupNotificationTapHandler();

      return () => {
        websocketManager.disconnect();
        unsubForeground();
        unsubTapHandler();
        unsubTokenRefresh?.();
      };
    } else {
      websocketManager.disconnect();
      return undefined;
    }
  }, [isAuthenticated]);

  return (
    <>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={theme.colors.background}
      />
      {authStatus === 'loading' && <LoadingView />}
      {authStatus === 'unauthenticated' && preAuthScreen === 'login' && (
        <LoginScreen onNavigate={handleNavigate} successMessage={preAuthParams.successMessage} />
      )}
      {authStatus === 'unauthenticated' && preAuthScreen === 'signup' && (
        <SignupScreen onNavigate={handleNavigate} />
      )}
      {authStatus === 'unauthenticated' && preAuthScreen === 'forgotPassword' && (
        <ForgotPasswordScreen onNavigate={handleNavigate} email={preAuthParams.email} />
      )}
      {authStatus === 'unauthenticated' && preAuthScreen === 'resetPassword' && (
        <ResetPasswordScreen onNavigate={handleNavigate} email={preAuthParams.email ?? ''} />
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
      <OrbitalSpinner size={32} />
    </View>
  );
}

export default Sentry.wrap(App);
