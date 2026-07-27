/**
 * Non-blocking banner shown when identity restore was deferred due to a
 * transient network failure. Provides a manual "Retry" action and also
 * auto-retries on app-foreground transitions.
 *
 * Placement: rendered inside the authenticated app shell (e.g. above the
 * main tab navigator) so it does NOT block usage but remains visible.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState as RNAppState, Pressable, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { useAuth } from '../stores';
import { retryIdentityRestore } from '../services/identityRestoreRetry';

export function IdentityRestoreBanner(): React.JSX.Element | null {
  const theme = useTheme();
  const { identityRestoreDeferred } = useAuth();
  const [retrying, setRetrying] = useState(false);
  const appStateRef = useRef(RNAppState.currentState);
  // Synchronous re-entrancy guard: `retrying` state is captured by value in
  // closures, so a foreground event landing between setRetrying(true) and the
  // next render could double-invoke. The ref is set before any await.
  const retryInFlightRef = useRef(false);

  const handleRetry = useCallback(async () => {
    if (retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    setRetrying(true);
    try {
      await retryIdentityRestore();
    } finally {
      retryInFlightRef.current = false;
      setRetrying(false);
    }
  }, []);

  // Auto-retry on app-foreground transition
  useEffect(() => {
    if (!identityRestoreDeferred) return;

    const subscription = RNAppState.addEventListener('change', (nextState) => {
      if (appStateRef.current.match(/inactive|background/) && nextState === 'active') {
        handleRetry();
      }
      appStateRef.current = nextState;
    });

    return () => subscription.remove();
  }, [identityRestoreDeferred, handleRetry]);

  if (!identityRestoreDeferred) return null;

  const containerStyle: ViewStyle = {
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.warning ?? '#f5a623',
    backgroundColor: `${theme.colors.warning ?? '#f5a623'}18`,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.sm,
    marginHorizontal: theme.spacing.base,
    marginTop: theme.spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const textStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textPrimary,
    lineHeight: theme.typography.fontSize.sm * theme.typography.lineHeight.normal,
    flex: 1,
    marginRight: theme.spacing.sm,
  };

  const buttonStyle: ViewStyle = {
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.warning ?? '#f5a623',
    minHeight: 44,
    justifyContent: 'center',
  };

  const buttonTextStyle: TextStyle = {
    fontFamily: theme.typography.fontFamily.body,
    fontSize: theme.typography.fontSize.sm,
    color: '#ffffff',
    fontWeight: '600',
  };

  return (
    <View style={containerStyle} testID="identity-restore-banner">
      <Text style={textStyle}>
        Encryption keys could not be restored. Tap Retry when online.
      </Text>
      <Pressable
        style={buttonStyle}
        onPress={handleRetry}
        disabled={retrying}
        testID="identity-restore-retry"
        accessibilityRole="button"
        accessibilityLabel={retrying ? 'Retrying encryption key restore' : 'Retry encryption key restore'}
      >
        <Text style={buttonTextStyle}>
          {retrying ? 'Retrying...' : 'Retry'}
        </Text>
      </Pressable>
    </View>
  );
}
