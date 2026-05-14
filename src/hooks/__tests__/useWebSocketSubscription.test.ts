import React from 'react';
import { create, act } from 'react-test-renderer';
import { useWebSocketSubscription } from '../useWebSocketSubscription';

const mockSubscribe = jest.fn();
const mockUnsubscribe = jest.fn();

jest.mock('../../services/websocket', () => ({
  websocketManager: {
    subscribe: (...args: unknown[]) => mockSubscribe(...args),
    unsubscribe: (...args: unknown[]) => mockUnsubscribe(...args),
  },
}));

function TestComponent({ conversationId }: { conversationId: string | null }) {
  useWebSocketSubscription(conversationId);
  return null;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useWebSocketSubscription', () => {
  it('subscribes on mount and unsubscribes on unmount', () => {
    let root: ReturnType<typeof create>;
    act(() => {
      root = create(React.createElement(TestComponent, { conversationId: 'conv-1' }));
    });
    expect(mockSubscribe).toHaveBeenCalledWith('conv-1');

    act(() => {
      root.unmount();
    });
    expect(mockUnsubscribe).toHaveBeenCalledWith('conv-1');
  });

  it('does nothing when conversationId is null', () => {
    let root: ReturnType<typeof create>;
    act(() => {
      root = create(React.createElement(TestComponent, { conversationId: null }));
    });
    expect(mockSubscribe).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it('resubscribes when conversationId changes', () => {
    let root: ReturnType<typeof create>;
    act(() => {
      root = create(React.createElement(TestComponent, { conversationId: 'conv-1' }));
    });
    expect(mockSubscribe).toHaveBeenCalledWith('conv-1');

    act(() => {
      root.update(React.createElement(TestComponent, { conversationId: 'conv-2' }));
    });
    expect(mockUnsubscribe).toHaveBeenCalledWith('conv-1');
    expect(mockSubscribe).toHaveBeenCalledWith('conv-2');
  });
});
