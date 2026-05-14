/**
 * Tests for the WebSocket manager — connect, disconnect, subscribe,
 * reconnect, AppState lifecycle, and token refresh handling.
 */

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Capture AppState listener callback for lifecycle tests
let appStateCallback: ((state: string) => void) | null = null;
const mockAppStateRemove = jest.fn();

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn((_event: string, callback: (state: string) => void) => {
      appStateCallback = callback;
      return { remove: mockAppStateRemove };
    }),
  },
}));

// Capture token refresh listener callback for WS-02 tests
let tokenRefreshCallback: (() => void) | null = null;

jest.mock('../../api/tokenManager', () => ({
  tokenManager: {
    getAccessToken: jest.fn(),
    onTokenRefresh: jest.fn((cb: () => void) => {
      tokenRefreshCallback = cb;
      return jest.fn(() => { tokenRefreshCallback = null; });
    }),
    onTokensCleared: jest.fn((_cb: () => void) => jest.fn()),
  },
}));

jest.mock('../../api/client', () => ({
  camelToSnake: jest.fn((v: unknown) => v),
}));

jest.mock('../messageHandler', () => ({
  handleServerMessage: jest.fn().mockResolvedValue(undefined),
}));

const mockSetConnectionStatus = jest.fn();
const mockSetReconnectAttempt = jest.fn();
const mockClearTypingUsers = jest.fn();

jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      connectionStatus: 'disconnected',
      isAuthenticated: true,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: jest.fn(),
      setReconnectAttempt: mockSetReconnectAttempt,
      clearTypingUsers: mockClearTypingUsers,
    })),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createWebSocketManager } from '../websocketManager';
import { tokenManager } from '../../api/tokenManager';
import { handleServerMessage } from '../messageHandler';

const mockGetAccessToken = tokenManager.getAccessToken as jest.MockedFunction<
  typeof tokenManager.getAccessToken
>;

// ---------------------------------------------------------------------------
// Mock WebSocket factory (TD-05)
// ---------------------------------------------------------------------------

interface WSMessageEvent {
  data: string;
}

interface WSCloseEvent {
  code: number;
  reason?: string;
}

interface MockSocket {
  onopen: (() => void) | null;
  onmessage: ((ev: WSMessageEvent) => void) | null;
  onclose: ((ev: WSCloseEvent) => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  close: jest.Mock;
  send: jest.Mock;
}

function createMockSocket(): MockSocket {
  return {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    readyState: 1, // OPEN
    close: jest.fn(),
    send: jest.fn(),
  };
}

let lastSocket: MockSocket | null = null;

const mockSocketFactory = jest.fn((_url: string, _protocols: undefined, _options: { headers: Record<string, string> }) => {
  const socket = createMockSocket();
  lastSocket = socket;
  return socket as unknown as WebSocket;
});

// ---------------------------------------------------------------------------
// WebSocket global (Node 20 doesn't have it; Node 22+ does)
// ---------------------------------------------------------------------------

if (typeof globalThis.WebSocket === 'undefined') {
  (globalThis as Record<string, unknown>).WebSocket = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  lastSocket = null;
  appStateCallback = null;
  tokenRefreshCallback = null;
  mockGetAccessToken.mockResolvedValue('test-jwt-token');
  // Re-wire the tokenManager mock after clearAllMocks wiped it
  (tokenManager as unknown as { onTokenRefresh: jest.Mock }).onTokenRefresh = jest.fn((cb: () => void) => {
    tokenRefreshCallback = cb;
    return jest.fn(() => { tokenRefreshCallback = null; });
  });
  // Reset the store mock to disconnected state
  const { useAppStore } = require('../../../stores/useAppStore');
  useAppStore.getState.mockReturnValue({
    connectionStatus: 'disconnected',
    isAuthenticated: true,
    setConnectionStatus: mockSetConnectionStatus,
    setLastConnectedAt: jest.fn(),
    setReconnectAttempt: mockSetReconnectAttempt,
    clearTypingUsers: mockClearTypingUsers,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

describe('connect', () => {
  it('creates a WebSocket with auth header and sets status to connecting', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();

    expect(mockSocketFactory).toHaveBeenCalledWith(
      'wss://api.orbitl.org/v1/websocket',
      undefined,
      { headers: { Authorization: 'Bearer test-jwt-token' } },
    );
    expect(mockSetConnectionStatus).toHaveBeenCalledWith('connecting');
  });

  it('does not connect if no access token is available', async () => {
    mockGetAccessToken.mockResolvedValue(null);
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();

    expect(mockSocketFactory).not.toHaveBeenCalled();
  });

  it('is a no-op if already connected', async () => {
    const { useAppStore } = require('../../../stores/useAppStore');
    useAppStore.getState.mockReturnValue({
      connectionStatus: 'connected',
      isAuthenticated: true,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: jest.fn(),
      setReconnectAttempt: mockSetReconnectAttempt,
      clearTypingUsers: mockClearTypingUsers,
    });

    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();

    expect(mockSocketFactory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

describe('disconnect', () => {
  it('closes socket with 1000 and sets status to disconnected', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();

    manager.disconnect();

    expect(lastSocket!.close).toHaveBeenCalledWith(1000);
    expect(mockSetConnectionStatus).toHaveBeenCalledWith('disconnected');
    expect(mockClearTypingUsers).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// subscribe / unsubscribe
// ---------------------------------------------------------------------------

describe('subscribe', () => {
  it('sends subscribe message when socket is open', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();

    manager.subscribe('conv-1');

    expect(lastSocket!.send).toHaveBeenCalledWith(
      expect.stringContaining('subscribe'),
    );
  });

  it('replays subscriptions on reconnect (onOpen)', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();

    manager.subscribe('conv-1');
    manager.subscribe('conv-2');

    // Reset send call count
    lastSocket!.send.mockClear();

    // Simulate onopen (reconnect)
    lastSocket!.onopen!();

    // Should replay both subscriptions
    expect(lastSocket!.send).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe removes from set', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();

    manager.subscribe('conv-1');
    manager.unsubscribe('conv-1');

    lastSocket!.send.mockClear();
    lastSocket!.onopen!();

    // No subscriptions to replay
    expect(lastSocket!.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// onMessage
// ---------------------------------------------------------------------------

describe('onMessage', () => {
  it('passes message data to handleServerMessage', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();

    const messageData = JSON.stringify({ type: 'pong', timestamp: 123 });
    lastSocket!.onmessage!({ data: messageData });

    // handleServerMessage is async; let microtasks flush
    await Promise.resolve();

    expect(handleServerMessage).toHaveBeenCalledWith(messageData);
  });
});

// ---------------------------------------------------------------------------
// onClose / reconnect
// ---------------------------------------------------------------------------

describe('onClose and reconnect', () => {
  it('schedules reconnect on abnormal close when authenticated', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();

    // Simulate abnormal close
    lastSocket!.onclose!({ code: 1006 });

    expect(mockSetConnectionStatus).toHaveBeenCalledWith('reconnecting');
    expect(mockSetReconnectAttempt).toHaveBeenCalledWith(1);
  });

  it('does not reconnect on normal close (1000)', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();

    lastSocket!.onclose!({ code: 1000 });

    expect(mockSetConnectionStatus).toHaveBeenCalledWith('disconnected');
  });

  it('does not reconnect on auth failure (4401)', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();

    lastSocket!.onclose!({ code: 4401 });

    expect(mockSetConnectionStatus).toHaveBeenCalledWith('disconnected');
  });

  it('does not reconnect if user is no longer authenticated', async () => {
    const { useAppStore } = require('../../../stores/useAppStore');
    const manager = createWebSocketManager(mockSocketFactory);

    // Start connected
    await manager.connect();

    // Simulate logout — isAuthenticated becomes false
    useAppStore.getState.mockReturnValue({
      connectionStatus: 'connecting',
      isAuthenticated: false,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: jest.fn(),
      setReconnectAttempt: mockSetReconnectAttempt,
      clearTypingUsers: mockClearTypingUsers,
    });

    lastSocket!.onclose!({ code: 1006 });

    expect(mockSetConnectionStatus).toHaveBeenCalledWith('disconnected');
  });
});

// ---------------------------------------------------------------------------
// sendTyping throttle
// ---------------------------------------------------------------------------

describe('sendTyping', () => {
  it('throttles typing events per conversation', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();
    lastSocket!.send.mockClear();

    manager.sendTyping('conv-1');
    manager.sendTyping('conv-1'); // Should be throttled
    manager.sendTyping('conv-1'); // Should be throttled

    // Only one send call for conv-1
    const typingCalls = lastSocket!.send.mock.calls.filter(
      (call: [string]) => call[0].includes('typing'),
    );
    expect(typingCalls).toHaveLength(1);
  });

  it('allows typing to different conversations', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();
    lastSocket!.send.mockClear();

    manager.sendTyping('conv-1');
    manager.sendTyping('conv-2'); // Different conversation — allowed

    const typingCalls = lastSocket!.send.mock.calls.filter(
      (call: [string]) => call[0].includes('typing'),
    );
    expect(typingCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// isConnected
// ---------------------------------------------------------------------------

describe('isConnected', () => {
  it('returns true when status is connected', () => {
    const { useAppStore } = require('../../../stores/useAppStore');
    useAppStore.getState.mockReturnValue({
      connectionStatus: 'connected',
      isAuthenticated: true,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: jest.fn(),
      setReconnectAttempt: mockSetReconnectAttempt,
      clearTypingUsers: mockClearTypingUsers,
    });

    const manager = createWebSocketManager(mockSocketFactory);
    expect(manager.isConnected()).toBe(true);
  });

  it('returns false when disconnected', () => {
    const manager = createWebSocketManager(mockSocketFactory);
    expect(manager.isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Watchdog timeout (#109)
// ---------------------------------------------------------------------------

describe('watchdog timeout', () => {
  it('closes socket after WATCHDOG_TIMEOUT_MS (45s) of no messages', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();

    // Simulate onopen — this starts the watchdog timer
    lastSocket!.onopen!();

    // Advance past the 45s watchdog timeout
    jest.advanceTimersByTime(45_001);

    expect(lastSocket!.close).toHaveBeenCalled();
  });

  it('does not close socket if a message resets the watchdog', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();
    lastSocket!.onopen!();

    // Advance 40s (under the 45s threshold)
    jest.advanceTimersByTime(40_000);

    // A message resets the watchdog
    lastSocket!.onmessage!({ data: JSON.stringify({ type: 'pong', timestamp: 1 }) });

    // Advance another 40s (total 80s from start, but only 40s since last message)
    jest.advanceTimersByTime(40_000);

    // Socket should still be open because the watchdog was reset
    expect(lastSocket!.close).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AppState transitions (#109)
// ---------------------------------------------------------------------------

describe('AppState transitions', () => {
  it('disconnects after background grace timer expires (30s)', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();
    lastSocket!.onopen!();

    expect(appStateCallback).not.toBeNull();

    // Go to background
    appStateCallback!('background');

    // Advance past the 30s grace period
    jest.advanceTimersByTime(30_001);

    // disconnect() should have been called, closing the socket
    expect(lastSocket!.close).toHaveBeenCalledWith(1000);
    expect(mockSetConnectionStatus).toHaveBeenCalledWith('disconnected');
  });

  it('cancels grace timer when returning to active before 30s', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();
    lastSocket!.onopen!();

    // Go to background
    appStateCallback!('background');

    // Advance 15s (less than 30s grace period)
    jest.advanceTimersByTime(15_000);

    // Return to foreground — this should cancel the grace timer
    appStateCallback!('active');

    // Advance just enough to pass where the 30s grace timer WOULD have fired
    // (15s already elapsed + 16s = 31s total, but not enough to hit 45s watchdog)
    jest.advanceTimersByTime(16_000);

    // Socket should NOT have been closed — grace timer was cancelled,
    // and we haven't reached the 45s watchdog threshold yet
    expect(lastSocket!.close).not.toHaveBeenCalled();
  });

  it('reconnects on active when status is disconnected and authenticated', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();
    lastSocket!.onopen!();

    // Normal close — does NOT auto-reconnect (code 1000), and the AppState
    // listener stays registered because onClose doesn't call disconnect().
    lastSocket!.onclose!({ code: 1000 });

    // Store now reflects disconnected
    const { useAppStore } = require('../../../stores/useAppStore');
    useAppStore.getState.mockReturnValue({
      connectionStatus: 'disconnected',
      isAuthenticated: true,
      setConnectionStatus: mockSetConnectionStatus,
      setLastConnectedAt: jest.fn(),
      setReconnectAttempt: mockSetReconnectAttempt,
      clearTypingUsers: mockClearTypingUsers,
    });

    mockSocketFactory.mockClear();

    // AppState 'active' should trigger reconnect via the captured listener
    appStateCallback!('active');
    await Promise.resolve(); // let getAccessToken resolve

    expect(mockSocketFactory).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Token refresh reconnect (#109)
// ---------------------------------------------------------------------------

describe('token refresh reconnect', () => {
  it('closes socket and reconnects when token is refreshed', async () => {
    const manager = createWebSocketManager(mockSocketFactory);
    await manager.connect();
    lastSocket!.onopen!();

    expect(tokenRefreshCallback).not.toBeNull();

    const firstSocket = lastSocket!;

    // Simulate token refresh
    tokenRefreshCallback!();

    // The existing socket should be closed cleanly
    expect(firstSocket.close).toHaveBeenCalledWith(1000);

    // A new connect() should have been triggered — await it
    await Promise.resolve();

    // A new socket should have been created
    expect(mockSocketFactory).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Subscribe before connect (#109)
// ---------------------------------------------------------------------------

describe('subscribe before connect', () => {
  it('replays pending subscriptions on first onopen', async () => {
    const manager = createWebSocketManager(mockSocketFactory);

    // Subscribe before connecting
    manager.subscribe('conv-1');
    manager.subscribe('conv-2');

    // Now connect
    await manager.connect();

    // Clear any sends from connect itself
    lastSocket!.send.mockClear();

    // Trigger onopen
    lastSocket!.onopen!();

    // Both subscriptions should be replayed
    expect(lastSocket!.send).toHaveBeenCalledTimes(2);
    const sentMessages = lastSocket!.send.mock.calls.map(
      (call: [string]) => JSON.parse(call[0]),
    );
    expect(sentMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'subscribe' }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Disconnect race guard (#110)
// ---------------------------------------------------------------------------

describe('connect/disconnect race guard', () => {
  it('does not create socket if disconnect() called during token fetch', async () => {
    // Make getAccessToken resolve asynchronously
    let resolveToken: ((value: string) => void) | null = null;
    mockGetAccessToken.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveToken = resolve;
      }),
    );

    const manager = createWebSocketManager(mockSocketFactory);
    const connectPromise = manager.connect();

    // Call disconnect while connect is awaiting the token
    manager.disconnect();

    // Now resolve the token
    resolveToken!('late-token');
    await connectPromise;

    // Socket factory should NOT have been called — the guard prevented it
    expect(mockSocketFactory).not.toHaveBeenCalled();
  });
});
