/**
 * Tests for the Header component.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { Header } from '../Header';

function renderHeader(
  props: Partial<React.ComponentProps<typeof Header>> = {},
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(Header, props),
      ),
    );
  });
  return renderer;
}

describe('Header', () => {
  it('renders title text', () => {
    const renderer = renderHeader({ title: 'Thread Detail' });
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const titleNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'Thread Detail',
    );
    expect(titleNode).toBeDefined();
  });

  it('renders back button text when onBack is provided', () => {
    const onBack = jest.fn();
    const renderer = renderHeader({ onBack, backLabel: 'Inbox' });
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const backNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === '‹ Inbox',
    );
    expect(backNode).toBeDefined();
  });

  it('does not render a back button when onBack is not provided', () => {
    const renderer = renderHeader({ title: 'Inbox' });
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const backNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        String(node.props.children).startsWith('‹'),
    );
    expect(backNode).toBeUndefined();
  });

  it('renders right slot content', () => {
    const rightContent = React.createElement(
      'Text' as unknown as React.ComponentType,
      {},
      '+',
    );
    const renderer = renderHeader({ right: rightContent });
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const plusNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === '+',
    );
    expect(plusNode).toBeDefined();
  });

  it('calls onBack when back button is pressed', () => {
    const onBack = jest.fn();
    const renderer = renderHeader({ onBack, backLabel: 'Back' });
    const touchables = renderer.root.findAllByType(
      'TouchableOpacity' as unknown as React.ComponentType,
    );
    expect(touchables.length).toBeGreaterThan(0);
    act(() => {
      touchables[0]?.props.onPress?.();
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
