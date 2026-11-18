/**
 * Tests for the EmojiText component.
 */

import React from 'react';
import { Linking } from 'react-native';
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

function findLinkNodes(root: ReactTestRenderer['root']) {
  return root.findAllByProps({ testID: 'emoji-text-link' });
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

  // --- Link rendering tests ---

  it('renders URL as tappable link', () => {
    const renderer = renderEmojiText({
      children: 'visit https://example.com',
    });
    const linkNodes = findLinkNodes(renderer.root);
    expect(linkNodes.length).toBeGreaterThanOrEqual(1);
    const linkNode = linkNodes[0];
    expect(linkNode.props.onPress).toBeDefined();
    expect(linkNode.props.children).toBe('https://example.com');
    expect(linkNode.props.accessibilityRole).toBe('link');
  });

  it('calls Linking.openURL on link press', () => {
    const openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as unknown as boolean);

    const renderer = renderEmojiText({
      children: 'visit https://example.com',
    });
    const linkNodes = findLinkNodes(renderer.root);
    expect(linkNodes.length).toBeGreaterThanOrEqual(1);

    act(() => {
      linkNodes[0].props.onPress();
    });

    expect(openURLSpy).toHaveBeenCalledWith('https://example.com');
    openURLSpy.mockRestore();
  });

  it('URL and emoji render together', () => {
    const renderer = renderEmojiText({
      children: 'check https://example.com \u{1F600}',
    });
    const root = renderer.root;

    const linkNodes = findLinkNodes(root);
    expect(linkNodes.length).toBeGreaterThanOrEqual(1);

    const images = root.findAllByType('Image' as unknown as React.ComponentType);
    expect(images.length).toBe(1);
  });

  it('autocapitalized URL scheme still opens on tap', () => {
    const openURLSpy = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    const renderer = renderEmojiText({
      children: 'Https://example.com',
    });
    const linkNodes = findLinkNodes(renderer.root);
    expect(linkNodes.length).toBeGreaterThanOrEqual(1);

    act(() => {
      linkNodes[0].props.onPress();
    });

    expect(openURLSpy).toHaveBeenCalledWith('Https://example.com');
    openURLSpy.mockRestore();
  });

  it('URL without emoji still renders as link (fast-path test)', () => {
    const renderer = renderEmojiText({
      children: 'visit https://example.com',
    });
    const root = renderer.root;

    // Should NOT take the plain text fast path — should render the link
    const linkNodes = findLinkNodes(root);
    expect(linkNodes.length).toBeGreaterThanOrEqual(1);
    expect(linkNodes[0].props.accessibilityRole).toBe('link');
  });

  it('numberOfLines works with links', () => {
    const renderer = renderEmojiText({
      children: 'visit https://example.com for more',
      numberOfLines: 1,
    });
    const root = renderer.root;
    const textNodes = root.findAllByType('Text' as unknown as React.ComponentType);
    const withNumberOfLines = textNodes.find(
      (node) => node.props.numberOfLines === 1,
    );
    expect(withNumberOfLines).toBeDefined();
  });

  // --- linkify={false} (#927) ---

  it('renders a URL as plain text when linkify is false', () => {
    const renderer = renderEmojiText({
      children: 'visit https://example.com',
      linkify: false,
    });
    const root = renderer.root;

    expect(findLinkNodes(root)).toHaveLength(0);
    // No tap target of any kind: nothing in the tree has an onPress or a link
    // role, so the row underneath keeps the whole surface.
    expect(root.findAll((node) => typeof node.props.onPress === 'function')).toHaveLength(0);
    expect(root.findAll((node) => node.props.accessibilityRole === 'link')).toHaveLength(0);

    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    const withUrl = allText.find(
      (node) => node.props.children === 'visit https://example.com',
    );
    expect(withUrl).toBeDefined();
  });

  it('still renders emoji alongside an un-linkified URL', () => {
    const renderer = renderEmojiText({
      children: 'check https://example.com \u{1F600}',
      linkify: false,
    });
    const root = renderer.root;

    expect(findLinkNodes(root)).toHaveLength(0);
    const images = root.findAllByType('Image' as unknown as React.ComponentType);
    expect(images).toHaveLength(1);
    // The URL's own text survives — it is unstyled, not removed.
    const allText = root.findAllByType('Text' as unknown as React.ComponentType);
    expect(
      allText.some(
        (node) =>
          typeof node.props.children === 'string' &&
          /https:\/\/example\.com/.test(node.props.children),
      ),
    ).toBe(true);
  });

  it('linkifies by default, with no prop passed', () => {
    const renderer = renderEmojiText({ children: 'visit https://example.com' });
    expect(findLinkNodes(renderer.root).length).toBeGreaterThanOrEqual(1);
    const explicit = renderEmojiText({
      children: 'visit https://example.com',
      linkify: true,
    });
    expect(findLinkNodes(explicit.root).length).toBeGreaterThanOrEqual(1);
  });

  it('passes selectable prop to Text when set', () => {
    const renderer = renderEmojiText({
      children: 'selectable text',
      selectable: true,
    });
    const root = renderer.root;
    const textNodes = root.findAllByType('Text' as unknown as React.ComponentType);
    const selectableText = textNodes.find(
      (node) => node.props.selectable === true,
    );
    expect(selectableText).toBeDefined();
  });

  it('does not set selectable by default', () => {
    const renderer = renderEmojiText({
      children: 'non-selectable text',
    });
    const root = renderer.root;
    const textNodes = root.findAllByType('Text' as unknown as React.ComponentType);
    const selectableText = textNodes.find(
      (node) => node.props.selectable === true,
    );
    expect(selectableText).toBeUndefined();
  });

  it('passes selectable to outer Text on mixed emoji+text content', () => {
    const renderer = renderEmojiText({
      children: 'hello \u{1F600} world',
      selectable: true,
    });
    const root = renderer.root;
    const textNodes = root.findAllByType('Text' as unknown as React.ComponentType);
    const selectableText = textNodes.find(
      (node) => node.props.selectable === true,
    );
    expect(selectableText).toBeDefined();
  });
});
