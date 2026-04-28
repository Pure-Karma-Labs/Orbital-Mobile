/**
 * Tests for the Badge component.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { Badge } from '../Badge';

function renderBadge(
  props: React.ComponentProps<typeof Badge>,
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(Badge, props),
      ),
    );
  });
  return renderer;
}

describe('Badge', () => {
  it('renders the count text', () => {
    const renderer = renderBadge({ count: 3 });
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const countNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === '3',
    );
    expect(countNode).toBeDefined();
  });

  it('renders "99+" for counts above 99', () => {
    const renderer = renderBadge({ count: 150 });
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const countNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === '99+',
    );
    expect(countNode).toBeDefined();
  });

  it('renders null when count is 0', () => {
    const renderer = renderBadge({ count: 0 });
    // Badge returns null for count <= 0, so JSON should be empty
    expect(renderer.toJSON()).toBeNull();
  });

  it('renders null when count is negative', () => {
    const renderer = renderBadge({ count: -1 });
    expect(renderer.toJSON()).toBeNull();
  });

  it('renders with testID', () => {
    const renderer = renderBadge({ count: 5, testID: 'unread-badge' });
    const found = renderer.root.findAll((node) => node.props.testID === 'unread-badge');
    expect(found.length).toBeGreaterThan(0);
  });
});
