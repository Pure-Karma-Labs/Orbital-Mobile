/**
 * Orbital Mobile
 * https://github.com/Pure-Karma-Labs/Orbital-Mobile
 *
 * @format
 */

import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'react-native';
import { ThemeProvider } from './theme';
import { useTheme } from './theme';

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
  const theme = useTheme();
  const isDark = theme.colorScheme === 'dark';

  return (
    <StatusBar
      barStyle={isDark ? 'light-content' : 'dark-content'}
      backgroundColor={theme.colors.background}
    />
  );
}

export default App;
