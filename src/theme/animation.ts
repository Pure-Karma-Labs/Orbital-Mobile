/**
 * Orbital Mobile — Animation Tokens
 */

export const duration = {
  instant: 100,
  fast: 150,
  base: 250,
} as const;

export const easing = {
  default: 'ease',
} as const;

export type Duration = typeof duration;
export type Easing = typeof easing;
