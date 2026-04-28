/**
 * Tests for the EmojiText component.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { EmojiText } from '../EmojiText';

function renderEmojiText(
  props: React.ComponentProps<typeof EmojiText>,
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(EmojiText, props),
      ),
    );
  });
  return renderer;
}

describe('EmojiText', () => {
  it('renders plain text without emoji', () => {
    const renderer = renderEmojiText({ children: 'hello world' });
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const textNode = allText.find(
      (node) => node.props.children === 'hello world',
    );
    expect(textNode).toBeDefined();
  });

  it('renders text with emoji', () => {
    const renderer = renderEmojiText({
      children: 'hello \u{1F600} world',
    });
    const root = renderer.root;

    // Should contain an Image (from the Emoji component) for the emoji
    const images = root.findAllByType('Image' as unknown as React.ComponentType);
    expect(images.length).toBe(1);

    // Should still contain text segments
    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    expect(allText.length).toBeGreaterThan(0);
  });

  it('renders multiple emoji in text', () => {
    const renderer = renderEmojiText({
      children: '\u{1F600} hi \u{1F601}',
    });
    const root = renderer.root;
    const images = root.findAllByType('Image' as unknown as React.ComponentType);
    expect(images.length).toBe(2);
  });

  it('passes testID to root Text', () => {
    const renderer = renderEmojiText({
      children: 'test',
      testID: 'emoji-text',
    });
    const found = renderer.root.findAll(
      (node) => node.props.testID === 'emoji-text',
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it('passes numberOfLines to root Text', () => {
    const renderer = renderEmojiText({
      children: 'hello',
      numberOfLines: 1,
    });
    const root = renderer.root;
    const textNodes = root.findAllByType('Text' as unknown as React.ComponentType);
    const withNumberOfLines = textNodes.find(
      (node) => node.props.numberOfLines === 1,
    );
    expect(withNumberOfLines).toBeDefined();
  });

  it('applies style to root Text', () => {
    const style = { fontSize: 16, color: 'red' };
    const renderer = renderEmojiText({
      children: 'styled text',
      style,
    });
    const root = renderer.root;
    const textNodes = root.findAllByType('Text' as unknown as React.ComponentType);
    const styledText = textNodes.find(
      (node) => node.props.style?.fontSize === 16,
    );
    expect(styledText).toBeDefined();
  });

  it('renders emoji-only text', () => {
    const renderer = renderEmojiText({
      children: '\u{1F600}',
    });
    const root = renderer.root;
    const images = root.findAllByType('Image' as unknown as React.ComponentType);
    expect(images.length).toBe(1);
  });
});
