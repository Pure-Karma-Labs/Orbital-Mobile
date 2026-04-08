/**
 * Orbital Mobile — Color Palette
 *
 * Two palettes (light / dark) satisfying the ColorPalette interface.
 * Reply-depth colors are derived from the base palette via getReplyDepthColors().
 */

export interface ReplyDepthColor {
  background: string;
  border: string;
}

export interface ColorPalette {
  // Surfaces
  background: string;
  surface: string;
  surfaceElevated: string;

  // Blue accent
  blue: string;
  blueHover: string;
  blueDark: string;
  blueTintLight: string;
  blueTint: string;

  // Purple accent
  purple: string;
  purpleHover: string;
  purpleDark: string;
  purpleTintLight: string;
  purpleTint: string;

  // Yellow accent
  yellow: string;
  yellowHover: string;
  yellowDark: string;
  yellowTint: string;

  // Text
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;

  // Borders
  borderSubtle: string;
  borderStrong: string;

  // Semantic
  success: string;
  warning: string;
  error: string;
}

export const lightColors: ColorPalette = {
  // Surfaces
  background: '#FAF9F7',       // Warm Canvas
  surface: '#F2F0ED',          // Soft Pearl — cards, sidebar
  surfaceElevated: '#FFFFFF',  // Cloud White — inputs, top-level posts

  // Blue accent
  blue: '#5B9FED',
  blueHover: '#4A8CD9',
  blueDark: '#3D7BC4',
  blueTintLight: 'rgba(91, 159, 237, 0.08)',
  blueTint: 'rgba(91, 159, 237, 0.12)',

  // Purple accent
  purple: '#9B87F5',
  purpleHover: '#8B75E1',
  purpleDark: '#7B65D1',
  purpleTintLight: 'rgba(155, 135, 245, 0.08)',
  purpleTint: 'rgba(155, 135, 245, 0.12)',

  // Yellow accent
  yellow: '#FFC700',
  yellowHover: '#FFD633',
  yellowDark: '#EAAD00',
  yellowTint: 'rgba(255, 199, 0, 0.15)',

  // Text
  textPrimary: '#2A2D35',    // Ink Navy
  textSecondary: '#6B7280',  // Slate Gray
  textTertiary: '#9CA3AF',   // Mist Gray

  // Borders
  borderSubtle: '#E5E7EB',  // Whisper Gray
  borderStrong: '#D1D5DB',  // Soft Shadow

  // Semantic
  success: '#48BB78',
  warning: '#F59E0B',
  error: '#F56565',
} as const satisfies ColorPalette;

export const darkColors: ColorPalette = {
  // Surfaces
  background: '#1A1D24',
  surface: '#24272F',
  surfaceElevated: '#2D3139',

  // Blue accent (slightly lighter for dark backgrounds)
  blue: '#6BA8F0',
  blueHover: '#4A8CD9',
  blueDark: '#3D7BC4',
  blueTintLight: 'rgba(91, 159, 237, 0.08)',
  blueTint: 'rgba(91, 159, 237, 0.12)',

  // Purple accent (slightly lighter for dark backgrounds)
  purple: '#A895F8',
  purpleHover: '#8B75E1',
  purpleDark: '#7B65D1',
  purpleTintLight: 'rgba(155, 135, 245, 0.08)',
  purpleTint: 'rgba(155, 135, 245, 0.12)',

  // Yellow accent
  yellow: '#FFC700',
  yellowHover: '#FFD633',
  yellowDark: '#EAAD00',
  yellowTint: 'rgba(255, 199, 0, 0.15)',

  // Text
  textPrimary: '#F3F4F6',
  textSecondary: '#C7CCD4',
  textTertiary: '#9CA3AF',

  // Borders
  borderSubtle: '#374151',
  borderStrong: '#4B5563',

  // Semantic
  success: '#48BB78',
  warning: '#F59E0B',
  error: '#F56565',
} as const satisfies ColorPalette;

/**
 * Returns an array of 5 reply-depth color entries (index 0–4).
 * Depths >= 4 should use index 4.
 */
export function getReplyDepthColors(palette: ColorPalette): ReplyDepthColor[] {
  return [
    // Level 0 — root post
    { background: palette.surfaceElevated, border: 'transparent' },
    // Level 1
    { background: palette.blueTintLight, border: palette.blue },
    // Level 2
    { background: palette.purpleTintLight, border: palette.purple },
    // Level 3
    { background: palette.blueTint, border: palette.blue },
    // Level 4+ (cap)
    { background: palette.purpleTint, border: palette.purple },
  ];
}
