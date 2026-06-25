import React, { useCallback } from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { MainTabNavigator } from './MainTabNavigator';
import { linking } from './linking';
import { navigationRef, flushPendingNotificationPayload } from './navigationRef';
import type { RootStackParamList } from './types';

const RootStack = createNativeStackNavigator<RootStackParamList>();

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
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        <RootStack.Screen name="MainTabs" component={MainTabNavigator} />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
