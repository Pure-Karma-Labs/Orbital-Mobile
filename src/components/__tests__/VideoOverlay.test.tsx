/**
 * Unit tests for the VideoOverlay primitives (PlayIconOverlay, DurationBadge).
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import { PlayIconOverlay, DurationBadge } from '../VideoOverlay';
import { ThemeProvider } from '../../theme';

function renderWithTheme(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(ThemeProvider, { colorSchemeOverride: 'light' }, element),
    );
  });
  return renderer;
}

describe('PlayIconOverlay', () => {
  it('renders the play glyph inside the circle overlay', () => {
    const renderer = renderWithTheme(<PlayIconOverlay />);

    const overlay = renderer.root.findAll(
      (node) =>
        node.props.testID === 'play-icon-overlay' &&
        typeof node.type === 'string',
    );
    expect(overlay).toHaveLength(1);

    const glyphs = renderer.root
      .findAllByType(Text)
      .filter((t) => t.props.children === '▶');
    expect(glyphs).toHaveLength(1);
  });

  it('scales the glyph with the size prop', () => {
    const renderer = renderWithTheme(<PlayIconOverlay size={64} />);

    const glyph = renderer.root
      .findAllByType(Text)
      .find((t) => t.props.children === '▶');
    expect(glyph?.props.style.fontSize).toBe(Math.round(64 * 0.45));
  });
});

describe('DurationBadge', () => {
  it('renders formatted duration from milliseconds', () => {
    const renderer = renderWithTheme(<DurationBadge durationMs={90_000} />);

    const texts = renderer.root
      .findAllByType(Text)
      .filter((t) => t.props.children === '1:30');
    expect(texts).toHaveLength(1);
  });

  it('renders H:MM:SS for durations of an hour or more', () => {
    const renderer = renderWithTheme(<DurationBadge durationMs={3_661_000} />);

    const texts = renderer.root
      .findAllByType(Text)
      .filter((t) => t.props.children === '1:01:01');
    expect(texts).toHaveLength(1);
  });
});
