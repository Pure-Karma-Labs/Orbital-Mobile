/**
 * Tests for the Avatar component.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { Avatar } from '../Avatar';

function renderAvatar(
  props: React.ComponentProps<typeof Avatar>,
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(Avatar, props),
      ),
    );
  });
  return renderer;
}

describe('Avatar', () => {
  it('renders the first initial of the name', () => {
    const renderer = renderAvatar({ name: 'Sarah' });
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const initialNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'S',
    );
    expect(initialNode).toBeDefined();
  });

  it('uppercases the initial', () => {
    const renderer = renderAvatar({ name: 'mom' });
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const initialNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === 'M',
    );
    expect(initialNode).toBeDefined();
  });

  it('renders ? initial when name is empty', () => {
    const renderer = renderAvatar({ name: '' });
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const initialNode = allText.find(
      (node) =>
        typeof node.props.children === 'string' &&
        node.props.children === '?',
    );
    expect(initialNode).toBeDefined();
  });

  it('renders a presence dot when online is true', () => {
    const renderer = renderAvatar({ name: 'Alex', online: true });
    // Presence dot is a View with specific positioning styles
    const views = renderer.root.findAllByType('View' as unknown as React.ComponentType);
    const dotViews = views.filter((v) => {
      const s = v.props.style as Record<string, unknown> | undefined;
      return s?.position === 'absolute';
    });
    expect(dotViews.length).toBeGreaterThan(0);
  });

  it('renders a presence dot when online is false', () => {
    const renderer = renderAvatar({ name: 'Alex', online: false });
    const views = renderer.root.findAllByType('View' as unknown as React.ComponentType);
    const dotViews = views.filter((v) => {
      const s = v.props.style as Record<string, unknown> | undefined;
      return s?.position === 'absolute';
    });
    expect(dotViews.length).toBeGreaterThan(0);
  });

  it('does not render a presence dot when online is not provided', () => {
    const renderer = renderAvatar({ name: 'Alex' });
    const views = renderer.root.findAllByType('View' as unknown as React.ComponentType);
    const dotViews = views.filter((v) => {
      const s = v.props.style as Record<string, unknown> | undefined;
      return s?.position === 'absolute';
    });
    expect(dotViews.length).toBe(0);
  });
});
