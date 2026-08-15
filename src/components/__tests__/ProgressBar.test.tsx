/**
 * Tests for ProgressBar — clamping, a11y toggling, and theme-driven fill color.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { ProgressBar, type ProgressBarProps } from '../ProgressBar';

// ---------------------------------------------------------------------------
// Helpers (follows MediaThumbnailStrip.test.tsx's isHost/render/ThemeProvider pattern)
// ---------------------------------------------------------------------------

function renderBar(
  props: Partial<ProgressBarProps> & { progress: number },
  colorSchemeOverride: 'light' | 'dark' = 'light',
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride },
        React.createElement(ProgressBar, { testID: 'bar', ...props }),
      ),
    );
  });
  return renderer;
}

function isHost(node: ReactTestInstance): boolean {
  return typeof node.type === 'string';
}

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((node) => isHost(node) && node.props.testID === testID);
  if (found.length === 0) throw new Error(`No element with testID "${testID}"`);
  return found[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProgressBar — clamping', () => {
  it('clamps a value above 1 to a 100% fill', () => {
    const renderer = renderBar({ progress: 1.5 });
    const fill = findByTestId(renderer.root, 'bar-fill');
    expect(fill.props.style.width).toBe('100%');
  });

  it('clamps a negative value to a 0% fill', () => {
    const renderer = renderBar({ progress: -0.5 });
    const fill = findByTestId(renderer.root, 'bar-fill');
    expect(fill.props.style.width).toBe('0%');
  });

  it('renders NaN as a 0% fill rather than a broken width', () => {
    const renderer = renderBar({ progress: Number.NaN });
    const fill = findByTestId(renderer.root, 'bar-fill');
    expect(fill.props.style.width).toBe('0%');
  });

  it('renders Infinity as a 0% fill rather than a broken width', () => {
    const renderer = renderBar({ progress: Number.POSITIVE_INFINITY });
    const fill = findByTestId(renderer.root, 'bar-fill');
    expect(fill.props.style.width).toBe('0%');
  });
});

describe('ProgressBar — announceProgress', () => {
  it('exposes accessibilityRole and accessibilityValue when announceProgress is true', () => {
    const renderer = renderBar({ progress: 0.42, announceProgress: true });
    const track = findByTestId(renderer.root, 'bar');
    expect(track.props.accessibilityRole).toBe('progressbar');
    expect(track.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 42 });
  });

  it('omits accessibilityRole and accessibilityValue when announceProgress is false (default)', () => {
    const renderer = renderBar({ progress: 0.42 });
    const track = findByTestId(renderer.root, 'bar');
    expect(track.props.accessibilityRole).toBeUndefined();
    expect(track.props.accessibilityValue).toBeUndefined();
  });
});

describe('ProgressBar — theme-driven fill color', () => {
  it('resolves a different fill color in dark mode than in light mode', () => {
    const lightRenderer = renderBar({ progress: 0.5 }, 'light');
    const darkRenderer = renderBar({ progress: 0.5 }, 'dark');

    const lightFill = findByTestId(lightRenderer.root, 'bar-fill');
    const darkFill = findByTestId(darkRenderer.root, 'bar-fill');

    expect(lightFill.props.style.backgroundColor).toBeDefined();
    expect(darkFill.props.style.backgroundColor).toBeDefined();
    expect(darkFill.props.style.backgroundColor).not.toBe(lightFill.props.style.backgroundColor);
  });
});
