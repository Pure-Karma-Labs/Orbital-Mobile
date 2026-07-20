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
  it('renders a single Image for a valid unified code', () => {
    const renderer = renderEmoji({ unified: '1F600' });
    const root = renderer.root;
    const images = root.findAllByType('Image' as unknown as React.ComponentType);
    expect(images.length).toBe(1);
  });

  it('returns null for unknown unified code', () => {
    const renderer = renderEmoji({ unified: 'ZZZZZZ' });
    const json = renderer.toJSON();
    expect(json).toBeNull();
  });

  it('renders with default size of 20', () => {
    const renderer = renderEmoji({ unified: '1F600' });
    const root = renderer.root;
    const images = root.findAllByType('Image' as unknown as React.ComponentType);
    expect(images.length).toBe(1);
    const style = images[0].props.style;
    expect(style.width).toBe(20);
    expect(style.height).toBe(20);
  });

  it('renders with custom size 32', () => {
    const renderer = renderEmoji({ unified: '1F600', size: 32 });
    const root = renderer.root;
    const images = root.findAllByType('Image' as unknown as React.ComponentType);
    expect(images.length).toBe(1);
    const style = images[0].props.style;
    expect(style.width).toBe(32);
    expect(style.height).toBe(32);
  });

  it('renders with custom size 48', () => {
    const renderer = renderEmoji({ unified: '1F600', size: 48 });
    const root = renderer.root;
    const images = root.findAllByType('Image' as unknown as React.ComponentType);
    expect(images.length).toBe(1);
    const style = images[0].props.style;
    expect(style.width).toBe(48);
    expect(style.height).toBe(48);
  });

  it('has a defined source for valid emoji', () => {
    const renderer = renderEmoji({ unified: '1F600' });
    const root = renderer.root;
    const images = root.findAllByType('Image' as unknown as React.ComponentType);
    expect(images[0].props.source).toBeDefined();
  });

  it('source is reference-stable across re-renders of the same unified', () => {
    const renderer = renderEmoji({ unified: '1F600' });
    const root = renderer.root;
    const images1 = root.findAllByType('Image' as unknown as React.ComponentType);
    const source1 = images1[0].props.source;

    // Re-render with same props
    act(() => {
      renderer.update(
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(Emoji, { unified: '1F600' }),
        ),
      );
    });

    const images2 = renderer.root.findAllByType('Image' as unknown as React.ComponentType);
    const source2 = images2[0].props.source;
    expect(source1).toBe(source2);
  });

  it('resolves non-qualified code (e.g. 2764) and renders', () => {
    // 2764 is the non-qualified form of 2764-FE0F (red heart)
    const renderer = renderEmoji({ unified: '2764' });
    const root = renderer.root;
    const images = root.findAllByType('Image' as unknown as React.ComponentType);
    expect(images.length).toBe(1);
    expect(images[0].props.source).toBeDefined();
  });

  it('passes testID to the Image', () => {
    const renderer = renderEmoji({
      unified: '1F600',
      testID: 'emoji-grinning',
    });
    const found = renderer.root.findAll(
      (node) => node.props.testID === 'emoji-grinning',
    );
    expect(found.length).toBeGreaterThan(0);
    // Verify it's on the Image element
    const image = found.find(
      (node) => (node.type as string) === 'Image',
    );
    expect(image).toBeDefined();
  });
});
