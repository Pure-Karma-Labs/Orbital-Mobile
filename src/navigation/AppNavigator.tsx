import React from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { useTheme } from '../theme';
import { MainTabNavigator } from './MainTabNavigator';
import { linking } from './linking';

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

  return (
    <NavigationContainer linking={linking} theme={navTheme}>
      <MainTabNavigator />
    </NavigationContainer>
  );
}
