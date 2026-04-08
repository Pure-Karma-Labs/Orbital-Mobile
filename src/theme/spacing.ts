/**
 * Orbital Mobile — Spacing & Layout Tokens
 */

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 24,
  xl: 32,
  '2xl': 48,
} as const;

export const borderRadius = {
  sm: 2,
  base: 3,    // retro-reduced default
  md: 3,      // cards
  lg: 4,      // modals
  full: 9999, // pills, avatars
} as const;

export const threadIndent = {
  perLevel: 24,
  maxIndent: 96, // level 4+
} as const;

export type Spacing = typeof spacing;
export type BorderRadius = typeof borderRadius;
export type ThreadIndent = typeof threadIndent;
