/**
 * Orbital Mobile
 * https://github.com/Pure-Karma-Labs/Orbital-Mobile
 *
 * @format
 */

import React, { useEffect, useRef, useState } from 'react';
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
import { deriveAuthPhase, assertLegalTransition } from './navigation/authPhase';
import { LoginScreen } from './screens/LoginScreen';
import { SignupScreen } from './screens/SignupScreen';
import { ForgotPasswordScreen } from './screens/ForgotPasswordScreen';
import { ResetPasswordScreen } from './screens/ResetPasswordScreen';
import { AppNavigator } from './navigation';
import { ReportContentSheet } from './components/ReportContentSheet';
import { TermsAcceptanceScreen } from './screens/TermsAcceptanceScreen';
import { KeyConflictScreen } from './screens/KeyConflictScreen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import BootSplash from 'react-native-bootsplash';
import { OrbitalLoader } from './components/OrbitalLoader';
import { IdentityRestoreBanner } from './components/IdentityRestoreBanner';

function App(): React.JSX.Element {
  const colorScheme = useAppStore((s) => s.colorScheme);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider colorSchemeOverride={colorScheme}>
          <AppContent />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function AppContent(): React.JSX.Element {
  const [restoreDone, setRestoreDone] = useState(false);
  const [preAuthScreen, setPreAuthScreen] = useState<PreAuthScreen>('login');
  const [preAuthParams, setPreAuthParams] = useState<PreAuthParams>({});
  const { isAuthenticated, userId, needsTermsAcceptance, identityKeyConflict, keyRecoveryInProgress } = useAuth();

  // Derive the current auth phase from boolean inputs.
  const phase = deriveAuthPhase({
    restoreDone,
    isAuthenticated,
    needsTermsAcceptance,
    identityKeyConflict,
    keyRecoveryInProgress,
  });

  // Dev-only: warn on unexpected phase transitions
  const prevPhaseRef = useRef(phase);
  useEffect(() => {
    if (prevPhaseRef.current !== phase) {
      assertLegalTransition(prevPhaseRef.current, phase);
      prevPhaseRef.current = phase;
    }
  }, [phase]);

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
        if (!restored) setRestoreDone(true);
      })
      .catch((e: unknown) => {
        Sentry.captureException(e);
        setRestoreDone(true);
      })
      .finally(() => {
        BootSplash.hide({ fade: true });
      });
  }, []);

  // React to store auth changes (login success, logout, 401 clearance)
  useEffect(() => {
    if (isAuthenticated) {
      // restoreSession / login set isAuthenticated in the store, which
      // means restore is done (session was found or login succeeded).
      setRestoreDone(true);
      Sentry.setUser(userId ? { id: userId } : null);
    } else if (restoreDone) {
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

  // ---- Render based on derived phase ----
  const renderPhaseContent = (): React.JSX.Element | null => {
    switch (phase) {
      case 'loading':
        return <LoadingView />;

      case 'unauthenticated':
        switch (preAuthScreen) {
          case 'login':
            return <LoginScreen onNavigate={handleNavigate} successMessage={preAuthParams.successMessage} />;
          case 'signup':
            return <SignupScreen onNavigate={handleNavigate} />;
          case 'forgotPassword':
            return <ForgotPasswordScreen onNavigate={handleNavigate} email={preAuthParams.email} />;
          case 'resetPassword':
            return <ResetPasswordScreen onNavigate={handleNavigate} email={preAuthParams.email ?? ''} />;
        }
        break; // exhaustive but satisfies TS

      case 'terms-required':
        return <TermsAcceptanceScreen />;

      case 'authenticated':
        return (
          <>
            <IdentityRestoreBanner />
            <AppNavigator />
            <ReportContentSheet />
          </>
        );

      case 'key-conflict':
        return <KeyConflictScreen />;

      case 'key-recovery':
        return <LoadingView />;
    }
    return null;
  };

  return (
    <>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={theme.colors.background}
      />
      {renderPhaseContent()}
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
      <OrbitalLoader size={80} />
    </View>
  );
}

export default Sentry.wrap(App);
