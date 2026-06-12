/**
 * Tests for OrbitListItem — unread badge rendering (#329).
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../../theme';
import { OrbitListItem } from '../OrbitListItem';
import { Badge } from '../../../components/Badge';

function renderItem(
  props: Partial<React.ComponentProps<typeof OrbitListItem>> = {},
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(OrbitListItem, {
          conversationId: 'g-1',
          name: 'Family Orbit',
          memberCount: 4,
          isActive: false,
          onPress: jest.fn(),
          ...props,
        }),
      ),
    );
  });
  return renderer;
}

describe('OrbitListItem — unread badge', () => {
  it('renders a Badge with the unread count when unreadCount > 0', () => {
    const renderer = renderItem({ unreadCount: 7 });
    const badges = renderer.root.findAllByType(Badge);
    expect(badges).toHaveLength(1);
    expect(badges[0].props.count).toBe(7);
  });

  it('renders no Badge when unreadCount is 0', () => {
    const renderer = renderItem({ unreadCount: 0 });
    expect(renderer.root.findAllByType(Badge)).toHaveLength(0);
  });

  it('renders no Badge when unreadCount is omitted (defaults to 0)', () => {
    const renderer = renderItem();
    expect(renderer.root.findAllByType(Badge)).toHaveLength(0);
  });

  it('includes the unread count in the accessibility label when > 0', () => {
    const renderer = renderItem({ unreadCount: 3 });
    const labelled = renderer.root.findAll(
      (node) =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.includes('3 unread'),
    );
    expect(labelled.length).toBeGreaterThan(0);
  });
});
