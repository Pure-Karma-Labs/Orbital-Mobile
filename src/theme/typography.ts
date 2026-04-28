/**
 * Orbital Mobile — Typography Tokens
 *
 * PostScript names extracted from the .ttf files:
 *   BitstreamVeraSans.ttf         → BitstreamVeraSans-Roman
 *   BitstreamVeraSans-Bold.ttf    → BitstreamVeraSans-Bold
 *   BitstreamVeraSans-Italic.ttf  → BitstreamVeraSans-Oblique
 *   BitstreamVeraSansMono.ttf     → BitstreamVeraSansMono-Roman
 *   BitstreamVeraSansMono-Bold.ttf→ BitstreamVeraSansMono-Bold
 *
 * React Native resolves fonts by the PostScript name embedded in the file,
 * so these strings must match exactly.
 */

export const fontFamily = {
  body: 'BitstreamVeraSans-Roman',
  bodyBold: 'BitstreamVeraSans-Bold',
  bodyItalic: 'BitstreamVeraSans-Oblique',
  header: 'FiraSans-Regular',
  mono: 'BitstreamVeraSansMono-Roman',
  monoBold: 'BitstreamVeraSansMono-Bold',
} as const;

export const fontSize = {
  xs: 10,    // timestamps, tiny labels
  sm: 11,    // captions, ASCII art
  base: 13,  // body text — THE standard
  md: 14,    // body large
  lg: 16,    // H3
  xl: 20,    // H2
  '2xl': 32, // H1 Display
} as const;

export const lineHeight = {
  tight: 1.2,
  snug: 1.3,
  normal: 1.4,
  relaxed: 1.5,
} as const;

export const fontWeight = {
  normal: '400' as const,
  bold: '700' as const,
} as const;

export const letterSpacing = {
  normal: 0,
  tight: 0.1,  // ~0.01em at base-10
  wide: 0.5,   // ~0.05em at base-10
  wider: 2.0,  // ~0.2em at base-10
} as const;

export type FontFamily = typeof fontFamily;
export type FontSize = typeof fontSize;
export type LineHeight = typeof lineHeight;
export type FontWeight = typeof fontWeight;
export type LetterSpacing = typeof letterSpacing;

export interface Typography {
  fontFamily: FontFamily;
  fontSize: FontSize;
  lineHeight: LineHeight;
  fontWeight: FontWeight;
  letterSpacing: LetterSpacing;
}
