/**
 * Orbital Mobile — Theme system tests
 */

import React from 'react';
import { act, create } from 'react-test-renderer';
import { createTheme, type Theme } from '../tokens';
import { ThemeProvider } from '../ThemeProvider';
import { useTheme } from '../useTheme';
import { getReplyDepthColors, lightColors, darkColors } from '../colors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true for values that look like valid CSS hex or rgba colors. */
function isValidColorString(value: string): boolean {
  return (
    /^#[0-9a-fA-F]{3,8}$/.test(value) ||
    /^rgba?\(/.test(value) ||
    value === 'transparent'
  );
}

function assertAllColorsValid(colors: Record<string, string>): void {
  for (const [key, value] of Object.entries(colors)) {
    expect({ key, valid: isValidColorString(value) }).toEqual({
      key,
      valid: true,
    });
  }
}

// ---------------------------------------------------------------------------
// createTheme — structure
// ---------------------------------------------------------------------------

describe('createTheme', () => {
  const expectedTopLevelKeys: (keyof Theme)[] = [
    'colorScheme',
    'colors',
    'typography',
    'spacing',
    'borderRadius',
    'threadIndent',
    'duration',
    'easing',
    'components',
    'replyDepthColors',
  ];

  it('createTheme("light") returns a complete Theme with all expected keys', () => {
    const theme = createTheme('light');
    for (const key of expectedTopLevelKeys) {
      expect(theme).toHaveProperty(key);
    }
    expect(theme.colorScheme).toBe('light');
  });

  it('createTheme("dark") returns a complete Theme with all expected keys', () => {
    const theme = createTheme('dark');
    for (const key of expectedTopLevelKeys) {
      expect(theme).toHaveProperty(key);
    }
    expect(theme.colorScheme).toBe('dark');
  });

  it('light and dark themes have different background colors', () => {
    const light = createTheme('light');
    const dark = createTheme('dark');
    expect(light.colors.background).not.toBe(dark.colors.background);
  });

  it('typography tokens are shared across both color schemes', () => {
    const light = createTheme('light');
    const dark = createTheme('dark');
    expect(light.typography).toBe(dark.typography);
  });
});

// ---------------------------------------------------------------------------
// Color palette validity
// ---------------------------------------------------------------------------

describe('color palettes', () => {
  it('all lightColors values are valid color strings', () => {
    assertAllColorsValid(lightColors as unknown as Record<string, string>);
  });

  it('all darkColors values are valid color strings', () => {
    assertAllColorsValid(darkColors as unknown as Record<string, string>);
  });

  it('lightColors background matches spec', () => {
    expect(lightColors.background).toBe('#FAF9F7');
  });

  it('darkColors background matches spec', () => {
    expect(darkColors.background).toBe('#1A1D24');
  });
});

// ---------------------------------------------------------------------------
// Reply depth colors
// ---------------------------------------------------------------------------

describe('getReplyDepthColors', () => {
  it('returns exactly 5 entries', () => {
    const depths = getReplyDepthColors(lightColors);
    expect(depths).toHaveLength(5);
  });

  it('level 0 uses surfaceElevated background and transparent border', () => {
    const depths = getReplyDepthColors(lightColors);
    expect(depths[0].background).toBe(lightColors.surfaceElevated);
    expect(depths[0].border).toBe('transparent');
  });

  it('level 1 uses blueTintLight background and blue border', () => {
    const depths = getReplyDepthColors(lightColors);
    expect(depths[1].background).toBe(lightColors.blueTintLight);
    expect(depths[1].border).toBe(lightColors.blue);
  });

  it('level 2 uses purpleTintLight background and purple border', () => {
    const depths = getReplyDepthColors(lightColors);
    expect(depths[2].background).toBe(lightColors.purpleTintLight);
    expect(depths[2].border).toBe(lightColors.purple);
  });

  it('all depth background and border values are valid color strings', () => {
    const depths = getReplyDepthColors(lightColors);
    for (const depth of depths) {
      expect(isValidColorString(depth.background)).toBe(true);
      expect(isValidColorString(depth.border)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// ThemeProvider — renders children
// ---------------------------------------------------------------------------

describe('ThemeProvider', () => {
  it('renders its children without throwing', () => {
    const TestChild = (): React.JSX.Element =>
      React.createElement('View', null);

    act(() => {
      create(
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(TestChild, null),
        ),
      );
    });
    // If we reach here without throwing, the test passes.
  });
});

// ---------------------------------------------------------------------------
// useTheme — returns theme within provider
// ---------------------------------------------------------------------------

describe('useTheme', () => {
  it('returns the theme object inside a ThemeProvider', () => {
    let capturedTheme: Theme | null = null;

    function Consumer(): React.JSX.Element {
      capturedTheme = useTheme();
      return React.createElement('View', null);
    }

    act(() => {
      create(
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(Consumer, null),
        ),
      );
    });

    expect(capturedTheme).not.toBeNull();
    expect((capturedTheme as unknown as Theme).colorScheme).toMatch(
      /^(light|dark)$/,
    );
    expect((capturedTheme as unknown as Theme).colors).toBeDefined();
    expect((capturedTheme as unknown as Theme).typography).toBeDefined();
  });

  it('throws when used outside ThemeProvider', () => {
    function BareConsumer(): React.JSX.Element {
      useTheme(); // should throw
      return React.createElement('View', null);
    }

    const originalError = console.error;
    // Suppress React error boundary noise during this test
    console.error = (): void => {};
    try {
      expect(() => {
        act(() => {
          create(React.createElement(BareConsumer, null));
        });
      }).toThrow('useTheme must be used within a ThemeProvider');
    } finally {
      console.error = originalError;
    }
  });
});
