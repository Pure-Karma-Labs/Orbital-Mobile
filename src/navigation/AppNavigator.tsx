import React, { useCallback } from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { useTheme } from '../theme';
import { MainTabNavigator } from './MainTabNavigator';
import { linking } from './linking';
import { navigationRef, flushPendingNotificationPayload } from './navigationRef';

export function AppNavigator(): React.JSX.Element {
  const theme = useTheme();

  const navTheme = {
    ...DefaultTheme,
    dark: theme.colorScheme === 'dark',
    colors: {
      ...DefaultTheme.colors,
      primary: theme.colors.blue,
      background: theme.colors.background,
      card: theme.colors.surface,
      text: theme.colors.textPrimary,
      border: theme.colors.borderSubtle,
      notification: theme.colors.blue,
    },
  };

  const handleReady = useCallback(() => {
    flushPendingNotificationPayload();
  }, []);

  return (
    <NavigationContainer
      ref={navigationRef}
      linking={linking}
      theme={navTheme}
      onReady={handleReady}
    >
      <MainTabNavigator />
    </NavigationContainer>
  );
}
