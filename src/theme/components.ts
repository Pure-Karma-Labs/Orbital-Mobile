/**
 * Orbital Mobile — Component-Level Tokens
 *
 * These are functions over ColorPalette so the tokens remain theme-aware.
 * Sizing/spacing values are in logical pixels (React Native dp).
 */

import { type ColorPalette } from './colors';
import { borderRadius } from './spacing';
import { fontSize } from './typography';

export function createComponentTokens(_colors: ColorPalette) {
  return {
    button: {
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderWidth: 1,
      borderRadius: borderRadius.base, // 3
      fontSize: fontSize.base,         // 13
    },
    input: {
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderWidth: 2,
      borderRadius: borderRadius.base,
      fontSize: fontSize.base,
    },
    post: {
      padding: 12,
      borderRadius: borderRadius.base,
      borderWidth: 1,
      borderLeftWidth: 3, // depth indicator stripe
    },
    badge: {
      paddingVertical: 2,
      paddingHorizontal: 6,
      minWidth: 18,
      fontSize: fontSize.xs,
      borderRadius: borderRadius.full,
      borderWidth: 1,
    },
  } as const;
}

export type ComponentTokens = ReturnType<typeof createComponentTokens>;
