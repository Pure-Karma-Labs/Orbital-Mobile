/**
 * Tests for the imported-thread badge pieces (#927 §8).
 *
 * Not mounted anywhere yet — the row and the detail caption are wired up in
 * the screen pass that follows — so this suite is what holds the two
 * invariants that matter: neither piece is touchable, and neither carries a
 * Meta mark.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../../theme';
import { ImportedCaption, ImportedIndicator } from '../ImportedBadge';
import { IMPORT_GLYPH } from '../importCopy';

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(ThemeProvider, { colorSchemeOverride: 'light' }, element),
    );
  });
  return renderer;
}

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as unknown as React.ComponentType)
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

describe('ImportedIndicator', () => {
  it('renders the glyph under its testID', () => {
    const renderer = render(<ImportedIndicator />);
    const badge = renderer.root.findByProps({ testID: 'thread-imported-indicator' });
    expect(badge).toBeDefined();
    expect(renderer.root.findAllByType('Image' as unknown as React.ComponentType)).toHaveLength(1);
  });

  it('is hidden from screen readers, because the row says it in words', () => {
    const renderer = render(<ImportedIndicator />);
    const badge = renderer.root.findByProps({ testID: 'thread-imported-indicator' });
    expect(badge.props.accessibilityElementsHidden).toBe(true);
    expect(badge.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('takes a size, and defaults to one without being told', () => {
    const image = (renderer: ReactTestRenderer) =>
      renderer.root.findAllByType('Image' as unknown as React.ComponentType)[0];
    expect(image(render(<ImportedIndicator size={22} />)).props.style.width).toBe(22);
    expect(image(render(<ImportedIndicator />)).props.style.width).toBeGreaterThan(0);
  });

  it('lets the row position it without owning the layout', () => {
    const renderer = render(<ImportedIndicator style={{ marginRight: 4 }} />);
    const badge = renderer.root.findByProps({ testID: 'thread-imported-indicator' });
    expect(badge.props.style).toEqual({ marginRight: 4 });
    // And with no style at all, it adds none of its own.
    const bare = render(<ImportedIndicator />);
    expect(
      bare.root.findByProps({ testID: 'thread-imported-indicator' }).props.style,
    ).toBeUndefined();
  });

  it('is not touchable', () => {
    const renderer = render(<ImportedIndicator />);
    expect(renderer.root.findAll((node) => typeof node.props.onPress === 'function')).toHaveLength(
      0,
    );
  });
});

describe('ImportedCaption', () => {
  it('names the source when there is one', () => {
    expect(texts(render(<ImportedCaption source="facebook" />))).toContain(
      'Imported from Facebook',
    );
    expect(texts(render(<ImportedCaption source="instagram" />))).toContain(
      'Imported from Instagram',
    );
  });

  it('falls back to "Imported post" when the source is unknown', () => {
    expect(texts(render(<ImportedCaption source={null} />))).toContain('Imported post');
  });

  it('reads as one element, labelled with the words rather than the glyph', () => {
    const renderer = render(<ImportedCaption source="facebook" />);
    const caption = renderer.root.findByProps({ testID: 'thread-imported-caption' });
    expect(caption.props.accessible).toBe(true);
    expect(caption.props.accessibilityLabel).toBe('Imported from Facebook');
  });

  it('is not touchable and has no link role', () => {
    const renderer = render(<ImportedCaption source="facebook" />);
    expect(renderer.root.findAll((node) => typeof node.props.onPress === 'function')).toHaveLength(
      0,
    );
    expect(renderer.root.findAll((node) => node.props.accessibilityRole === 'link')).toHaveLength(
      0,
    );
  });

  it('renders the same neutral glyph for both sources', () => {
    const unified = (source: 'facebook' | 'instagram') =>
      render(<ImportedCaption source={source} />).root.findAllByProps({ unified: IMPORT_GLYPH })
        .length;
    expect(unified('facebook')).toBeGreaterThan(0);
    expect(unified('instagram')).toBeGreaterThan(0);
  });

  it('lets the parent position it without owning the layout', () => {
    const renderer = render(<ImportedCaption source="facebook" style={{ marginTop: 7 }} />);
    const caption = renderer.root.findByProps({ testID: 'thread-imported-caption' });
    expect(caption.props.style.marginTop).toBe(7);
    expect(caption.props.style.flexDirection).toBe('row');
  });
});
