/**
 * Tests for ChatMessageItem — unread indicator (#329).
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../../theme';
import { ChatMessageItem } from '../ChatMessageItem';

jest.mock('../../../hooks/useDisplayName', () => ({
  useDisplayName: (_authorId: string, fallback: string) => fallback,
}));

function renderItem(
  props: Partial<React.ComponentProps<typeof ChatMessageItem>> = {},
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(ChatMessageItem, {
          threadId: 't-1',
          authorId: 'u-bob',
          body: 'hello',
          author: 'bob',
          time: '11:00 AM',
          isOwn: false,
          onPress: jest.fn(),
          ...props,
        }),
      ),
    );
  });
  return renderer;
}

describe('ChatMessageItem — unread indicator', () => {
  it('shows the unread dot and accessibility label when unread', () => {
    const renderer = renderItem({ unread: true });
    const dot = renderer.root.findAll((n) => n.props.testID === 'chat-unread-dot-t-1');
    expect(dot.length).toBeGreaterThan(0);
    const labelled = renderer.root.findAll(
      (n) => n.props.accessibilityLabel === 'Unread message from bob',
    );
    expect(labelled.length).toBeGreaterThan(0);
  });

  it('hides the dot when read', () => {
    const renderer = renderItem({ unread: false });
    expect(
      renderer.root.findAll((n) => n.props.testID === 'chat-unread-dot-t-1'),
    ).toHaveLength(0);
  });

  it('shows the dot on own-authored thread rows too (other party replied)', () => {
    // In DMs a row is a thread; replies from the other person make it
    // unread regardless of who created the thread (#333 follow-up).
    const renderer = renderItem({ isOwn: true, unread: true });
    expect(
      renderer.root.findAll((n) => n.props.testID === 'chat-unread-dot-t-1').length,
    ).toBeGreaterThan(0);
  });

  it('hides the dot by default (prop omitted)', () => {
    const renderer = renderItem();
    expect(
      renderer.root.findAll((n) => n.props.testID === 'chat-unread-dot-t-1'),
    ).toHaveLength(0);
  });
});
