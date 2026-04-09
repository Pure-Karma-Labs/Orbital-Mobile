/**
 * Tests for ChatsScreen — placeholder screen rendering.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { ChatsScreen } from '../ChatsScreen';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('../../stores', () => ({
  useAuth: () => ({
    isAuthenticated: false,
    userId: null,
    username: null,
    displayName: null,
    avatarPath: null,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderChatsScreen(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(ChatsScreen, null),
      ),
    );
  });
  return renderer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatsScreen', () => {
  it('renders "Chats" text', () => {
    const renderer = renderChatsScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const chatsText = allText.find(
      (node) => typeof node.props.children === 'string' && node.props.children === 'Chats',
    );
    expect(chatsText).toBeDefined();
  });

  it('renders "Coming soon" text', () => {
    const renderer = renderChatsScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const comingSoonText = allText.find(
      (node) => typeof node.props.children === 'string' && node.props.children === 'Coming soon',
    );
    expect(comingSoonText).toBeDefined();
  });

  it('has testID "chats-screen"', () => {
    const renderer = renderChatsScreen();
    const found = renderer.root.findAll((node) => node.props.testID === 'chats-screen');
    expect(found.length).toBeGreaterThan(0);
  });
});
