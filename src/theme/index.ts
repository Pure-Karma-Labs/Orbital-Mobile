/**
 * Orbital Mobile — Theme barrel export
 */

// Provider + hook
export { ThemeProvider } from './ThemeProvider';
export type { ColorSchemeOverride } from './ThemeProvider';
export { useTheme } from './useTheme';

// Combined theme type and factory
export { createTheme } from './tokens';
export type { Theme } from './tokens';

// Token modules — re-exported so consumers can import directly from the barrel
export { lightColors, darkColors, getReplyDepthColors } from './colors';
export type { ColorPalette, ReplyDepthColor } from './colors';

export {
  fontFamily,
  fontSize,
  lineHeight,
  fontWeight,
  letterSpacing,
} from './typography';
export type { Typography, FontFamily, FontSize, LineHeight, FontWeight, LetterSpacing } from './typography';

export { spacing, borderRadius, threadIndent } from './spacing';
export type { Spacing, BorderRadius, ThreadIndent } from './spacing';

export { duration, easing } from './animation';
export type { Duration, Easing } from './animation';

export { createComponentTokens } from './components';
export type { ComponentTokens } from './components';
