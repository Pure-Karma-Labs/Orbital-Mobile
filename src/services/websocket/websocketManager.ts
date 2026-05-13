/**
 * WebSocket connection manager — singleton factory.
 *
 * Manages the lifecycle of a single WebSocket connection to the Orbital backend:
 * connect, disconnect, reconnect, heartbeat, and conversation subscriptions.
 *
 * Security:
 * - JWT passed via Authorization header (WS-01), never as query param.
 * - wss:// enforced (WS-04).
 * - Token refresh triggers reconnect (WS-02).
 *
 * Testability: Accepts an optional `createSocket` parameter (TD-05) so tests
 * can inject a mock WebSocket without patching globals.
 */

import { AppState as RNAppState } from 'react-native';
import { tokenManager } from '../api/tokenManager';
import { useAppStore } from '../../stores/useAppStore';
import { camelToSnake } from '../api/client';
import { handleServerMessage } from './messageHandler';
import { calculateBackoff, shouldReconnect } from './reconnect';
import { WS_CLOSE_NORMAL } from './types';
import type { ClientMessage } from './types';

// ============================================================
// React Native WebSocket event types (DOM types are not in the RN TS lib)
// ============================================================

interface WSMessageEvent {
  data: string;
}

interface WSCloseEvent {
  code: number;
  reason?: string;
}

// ============================================================
// Constants
// ============================================================

const WS_URL = 'wss://api.orbitl.org/v1/websocket';
const PING_INTERVAL_MS = 25_000;
const WATCHDOG_TIMEOUT_MS = 45_000;
const BACKGROUND_GRACE_MS = 30_000;
const TYPING_THROTTLE_MS = 3_000;

// ============================================================
// Socket factory type (TD-05)
// ============================================================

type SocketFactory = (
  url: string,
  protocols: undefined,
  options: { headers: Record<string, string> },
) => WebSocket;

// ============================================================
// Manager factory
// ============================================================

export function createWebSocketManager(createSocket?: SocketFactory) {
  // Private state
  let socket: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backgroundGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  const subscriptions = new Set<string>();
  const typingThrottles = new Map<string, number>();

  // AppState listener subscription
  let appStateSubscription: { remove: () => void } | null = null;

  // ------------------------------------------------------------------
  // Timer helpers
  // ------------------------------------------------------------------

  function clearAllTimers(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (backgroundGraceTimer !== null) {
      clearTimeout(backgroundGraceTimer);
      backgroundGraceTimer = null;
    }
  }

  // ------------------------------------------------------------------
  // Send helper
  // ------------------------------------------------------------------

  function send(msg: ClientMessage): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
      const transformed = camelToSnake(msg);
      socket.send(JSON.stringify(transformed));
    }
  }

  // ------------------------------------------------------------------
  // Ping / Watchdog
  // ------------------------------------------------------------------

  function startPingInterval(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
    }
    pingTimer = setInterval(() => {
      send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  function resetWatchdog(): void {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
    }
    watchdogTimer = setTimeout(() => {
      // No message received within timeout — connection is dead
      if (__DEV__) {
        console.warn('[WS] Watchdog timeout — forcing reconnect');
      }
      if (socket) {
        try {
          socket.close();
        } catch {
          // Ignore — may already be closed
        }
      }
    }, WATCHDOG_TIMEOUT_MS);
  }

  // ------------------------------------------------------------------
  // Subscription replay
  // ------------------------------------------------------------------

  function replaySubscriptions(): void {
    for (const id of subscriptions) {
      send({ type: 'subscribe', data: { conversationId: id } });
    }
  }

  // ------------------------------------------------------------------
  // Reconnect logic
  // ------------------------------------------------------------------

  function scheduleReconnect(): void {
    const delay = calculateBackoff(reconnectAttempt);
    reconnectAttempt++;
    useAppStore.getState().setReconnectAttempt(reconnectAttempt);
    useAppStore.getState().setConnectionStatus('reconnecting');

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      manager.connect();
    }, delay);
  }

  // ------------------------------------------------------------------
  // WebSocket event handlers
  // ------------------------------------------------------------------

  function onOpen(): void {
    // TD-02: Status stays 'connecting' — only connection_ack sets 'connected'
    replaySubscriptions();
    startPingInterval();
    resetWatchdog();
  }

  function onMessage(event: WSMessageEvent): void {
    resetWatchdog();
    handleServerMessage(event.data as string).catch((e) => {
      if (__DEV__) {
        console.warn('[WS] Handler error:', e instanceof Error ? e.message : e);
      }
    });
  }

  function onClose(event: WSCloseEvent): void {
    cleanupSocket();

    const isAuthenticated = useAppStore.getState().isAuthenticated;

    if (shouldReconnect(event.code) && isAuthenticated) {
      scheduleReconnect();
    } else {
      useAppStore.getState().setConnectionStatus('disconnected');
      reconnectAttempt = 0;
    }
  }

  function onError(): void {
    // Error events are always followed by a close event.
    // Let onClose handle reconnection logic.
  }

  function cleanupSocket(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    socket = null;
  }

  // ------------------------------------------------------------------
  // AppState listener (foreground/background)
  // ------------------------------------------------------------------

  function registerAppStateListener(): void {
    if (appStateSubscription) return;

    appStateSubscription = RNAppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        // Returning to foreground
        if (backgroundGraceTimer !== null) {
          clearTimeout(backgroundGraceTimer);
          backgroundGraceTimer = null;
        }
        const status = useAppStore.getState().connectionStatus;
        if (status === 'disconnected' && useAppStore.getState().isAuthenticated) {
          manager.connect();
        }
      } else {
        // Going to background or inactive
        backgroundGraceTimer = setTimeout(() => {
          backgroundGraceTimer = null;
          manager.disconnect();
        }, BACKGROUND_GRACE_MS);
      }
    });
  }

  function removeAppStateListener(): void {
    if (appStateSubscription) {
      appStateSubscription.remove();
      appStateSubscription = null;
    }
  }

  // ------------------------------------------------------------------
  // Token refresh listener (WS-02)
  // ------------------------------------------------------------------

  function registerTokenRefreshListener(): void {
    tokenManager.onTokenRefresh = () => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        if (__DEV__) {
          console.log('[WS] Token refreshed — reconnecting with new JWT');
        }
        // Close cleanly and reconnect with fresh token
        try {
          socket.close(WS_CLOSE_NORMAL);
        } catch {
          // Ignore
        }
        cleanupSocket();
        // Reconnect immediately with new token
        reconnectAttempt = 0;
        manager.connect();
      }
    };
  }

  function removeTokenRefreshListener(): void {
    tokenManager.onTokenRefresh = undefined;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  const manager = {
    /**
     * Open a WebSocket connection to the backend.
     * No-op if already connected or connecting.
     */
    async connect(): Promise<void> {
      const currentStatus = useAppStore.getState().connectionStatus;
      if (
        currentStatus === 'connected' ||
        currentStatus === 'connecting'
      ) {
        return;
      }

      const token = await tokenManager.getAccessToken();
      if (token === null) {
        if (__DEV__) {
          console.warn('[WS] No access token — cannot connect');
        }
        return;
      }

      // WS-04: Enforce wss://
      if (!WS_URL.startsWith('wss://')) {
        throw new Error('[WS] URL must use wss://');
      }

      useAppStore.getState().setConnectionStatus('connecting');

      const factory = createSocket ?? defaultCreateSocket;
      socket = factory(WS_URL, undefined, {
        headers: { Authorization: `Bearer ${token}` },
      });

      socket.onopen = onOpen as () => void;
      socket.onmessage = onMessage as (ev: unknown) => void;
      socket.onclose = onClose as (ev: unknown) => void;
      socket.onerror = onError;

      registerAppStateListener();
      registerTokenRefreshListener();
    },

    /**
     * Cleanly close the WebSocket connection.
     * Clears all timers and subscriptions.
     */
    disconnect(): void {
      clearAllTimers();
      removeAppStateListener();
      removeTokenRefreshListener();

      if (socket) {
        try {
          socket.close(WS_CLOSE_NORMAL);
        } catch {
          // Ignore — may already be closed
        }
        socket = null;
      }

      subscriptions.clear();
      typingThrottles.clear();
      reconnectAttempt = 0;

      useAppStore.getState().setConnectionStatus('disconnected');
      useAppStore.getState().clearTypingUsers();
    },

    /**
     * Subscribe to a conversation for real-time broadcasts.
     * If connected, sends the subscribe message immediately.
     * Always tracked in the subscriptions set for replay on reconnect.
     */
    subscribe(conversationId: string): void {
      subscriptions.add(conversationId);
      if (socket && socket.readyState === WebSocket.OPEN) {
        send({ type: 'subscribe', data: { conversationId } });
      }
    },

    /**
     * Unsubscribe from a conversation.
     * Removes from local tracking (no server-side unsubscribe exists).
     */
    unsubscribe(conversationId: string): void {
      subscriptions.delete(conversationId);
    },

    /**
     * Send a typing indicator for a conversation.
     * Throttled to 1 event per 3 seconds per conversation.
     */
    sendTyping(conversationId: string): void {
      const now = Date.now();
      const lastSent = typingThrottles.get(conversationId) ?? 0;
      if (now - lastSent < TYPING_THROTTLE_MS) {
        return;
      }
      typingThrottles.set(conversationId, now);
      send({ type: 'typing', data: { conversationId } });
    },

    /** Whether the WebSocket is currently in the 'connected' state. */
    isConnected(): boolean {
      return useAppStore.getState().connectionStatus === 'connected';
    },
  };

  return manager;
}

// ============================================================
// Default socket factory (uses native WebSocket)
// ============================================================

function defaultCreateSocket(
  url: string,
  protocols: undefined,
  options: { headers: Record<string, string> },
): WebSocket {
  // React Native WebSocket constructor accepts a third arg for headers
  return new (WebSocket as unknown as new (
    url: string,
    protocols: undefined,
    options: { headers: Record<string, string> },
  ) => WebSocket)(url, protocols, options);
}

// ============================================================
// Singleton instance
// ============================================================

export const websocketManager = createWebSocketManager();
