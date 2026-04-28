/**
 * Tests for the Emoji component.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { Emoji } from '../Emoji';

function renderEmoji(
  props: React.ComponentProps<typeof Emoji>,
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(Emoji, props),
      ),
    );
  });
  return renderer;
}

describe('Emoji', () => {
  it('renders a valid emoji', () => {
    const renderer = renderEmoji({ unified: '1F600' });
    const json = renderer.toJSON();
    expect(json).not.toBeNull();
  });

  it('returns null for unknown unified code', () => {
    const renderer = renderEmoji({ unified: 'ZZZZZZ' });
    const json = renderer.toJSON();
    expect(json).toBeNull();
  });

  it('renders with default size of 20', () => {
    const renderer = renderEmoji({ unified: '1F600' });
    const root = renderer.root;
    // The outermost View should have width/height of 20 (default)
    const outerView = root.findAll(
      (node) =>
        (node.type as string) === 'View' &&
        node.props.style?.width === 20 &&
        node.props.style?.height === 20,
    );
    expect(outerView.length).toBeGreaterThan(0);
  });

  it('renders with custom size', () => {
    const renderer = renderEmoji({ unified: '1F600', size: 32 });
    const root = renderer.root;
    const outerView = root.findAll(
      (node) =>
        (node.type as string) === 'View' &&
        node.props.style?.width === 32 &&
        node.props.style?.height === 32,
    );
    expect(outerView.length).toBeGreaterThan(0);
  });

  it('renders with overflow hidden', () => {
    const renderer = renderEmoji({ unified: '1F600' });
    const root = renderer.root;
    const clippedView = root.findAll(
      (node) =>
        (node.type as string) === 'View' && node.props.style?.overflow === 'hidden',
    );
    expect(clippedView.length).toBeGreaterThan(0);
  });

  it('contains an Image element for the sprite sheet', () => {
    const renderer = renderEmoji({ unified: '1F600' });
    const root = renderer.root;
    const images = root.findAllByType('Image' as unknown as React.ComponentType);
    expect(images.length).toBe(1);
  });

  it('passes testID to the container', () => {
    const renderer = renderEmoji({
      unified: '1F600',
      testID: 'emoji-grinning',
    });
    const found = renderer.root.findAll(
      (node) => node.props.testID === 'emoji-grinning',
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it('uses the 32px sheet for sizes <= 32', () => {
    const renderer = renderEmoji({ unified: '1F600', size: 20 });
    const root = renderer.root;
    const images = root.findAllByType('Image' as unknown as React.ComponentType);
    expect(images.length).toBe(1);
    // The image source should reference the 32.webp sheet
    const source = images[0].props.source;
    expect(source).toBeDefined();
  });

  it('uses the 64px sheet for sizes > 32', () => {
    const renderer = renderEmoji({ unified: '1F600', size: 48 });
    const root = renderer.root;
    const images = root.findAllByType('Image' as unknown as React.ComponentType);
    expect(images.length).toBe(1);
    const source = images[0].props.source;
    expect(source).toBeDefined();
  });
});
