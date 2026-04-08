/**
 * Orbital Mobile — Theme Provider
 *
 * Wraps the app and resolves the active theme from system preference or an
 * explicit override. All child components consume the theme via useTheme().
 */

import React, { useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { ThemeContext } from './ThemeContext';
import { createTheme } from './tokens';

export type ColorSchemeOverride = 'light' | 'dark' | 'system';

interface ThemeProviderProps {
  children?: React.ReactNode;
  colorSchemeOverride?: ColorSchemeOverride;
}

export function ThemeProvider({
  children,
  colorSchemeOverride,
}: ThemeProviderProps): React.JSX.Element {
  const systemColorScheme = useColorScheme();

  const resolvedScheme = useMemo((): 'light' | 'dark' => {
    if (colorSchemeOverride === 'light') return 'light';
    if (colorSchemeOverride === 'dark') return 'dark';
    // 'system' or undefined — follow device preference, default to light
    return systemColorScheme === 'dark' ? 'dark' : 'light';
  }, [colorSchemeOverride, systemColorScheme]);

  const theme = useMemo(() => createTheme(resolvedScheme), [resolvedScheme]);

  return (
    <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>
  );
}
