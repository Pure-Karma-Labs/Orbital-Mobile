/**
 * Orbital Mobile — useTheme hook
 *
 * Must be called inside a ThemeProvider. Throws if used outside the provider
 * so misconfiguration surfaces early as a clear error.
 */

import { useContext } from 'react';
import { ThemeContext } from './ThemeContext';
import { type Theme } from './tokens';

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return theme;
}
