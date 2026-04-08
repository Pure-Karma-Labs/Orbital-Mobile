/**
 * Orbital Mobile — Theme React Context
 *
 * Separated from ThemeProvider to avoid circular import issues and to allow
 * useTheme to import only the context without pulling in React component code.
 */

import { createContext } from 'react';
import { type Theme } from './tokens';

export const ThemeContext = createContext<Theme | null>(null);
