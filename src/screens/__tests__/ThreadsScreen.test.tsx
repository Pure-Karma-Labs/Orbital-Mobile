/**
 * Tests for ThreadsScreen — placeholder screen rendering.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { ThreadsScreen } from '../ThreadsScreen';

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

function renderThreadsScreen(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(ThreadsScreen, null),
      ),
    );
  });
  return renderer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThreadsScreen', () => {
  it('renders "Threads" text', () => {
    const renderer = renderThreadsScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const threadText = allText.find(
      (node) => typeof node.props.children === 'string' && node.props.children === 'Threads',
    );
    expect(threadText).toBeDefined();
  });

  it('renders "Coming soon" text', () => {
    const renderer = renderThreadsScreen();
    const allText = renderer.root.findAllByType('Text' as unknown as React.ComponentType);
    const comingSoonText = allText.find(
      (node) => typeof node.props.children === 'string' && node.props.children === 'Coming soon',
    );
    expect(comingSoonText).toBeDefined();
  });

  it('has testID "threads-screen"', () => {
    const renderer = renderThreadsScreen();
    const found = renderer.root.findAll((node) => node.props.testID === 'threads-screen');
    expect(found.length).toBeGreaterThan(0);
  });
});
