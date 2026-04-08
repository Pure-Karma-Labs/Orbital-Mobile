/**
 * Orbital Mobile — Combined Theme Tokens
 *
 * createTheme() is the single entry-point for building a complete theme object.
 */

import {
  type ColorPalette,
  type ReplyDepthColor,
  lightColors,
  darkColors,
  getReplyDepthColors,
} from './colors';
import {
  type Typography,
  fontFamily,
  fontSize,
  lineHeight,
  fontWeight,
  letterSpacing,
} from './typography';
import { type Spacing, type BorderRadius, type ThreadIndent, spacing, borderRadius, threadIndent } from './spacing';
import { type Duration, type Easing, duration, easing } from './animation';
import { type ComponentTokens, createComponentTokens } from './components';

export interface Theme {
  colorScheme: 'light' | 'dark';
  colors: ColorPalette;
  typography: Typography;
  spacing: Spacing;
  borderRadius: BorderRadius;
  threadIndent: ThreadIndent;
  duration: Duration;
  easing: Easing;
  components: ComponentTokens;
  replyDepthColors: ReplyDepthColor[];
}

const typographyTokens: Typography = {
  fontFamily,
  fontSize,
  lineHeight,
  fontWeight,
  letterSpacing,
};

export function createTheme(colorScheme: 'light' | 'dark'): Theme {
  const colors = colorScheme === 'dark' ? darkColors : lightColors;

  return {
    colorScheme,
    colors,
    typography: typographyTokens,
    spacing,
    borderRadius,
    threadIndent,
    duration,
    easing,
    components: createComponentTokens(colors),
    replyDepthColors: getReplyDepthColors(colors),
  };
}
