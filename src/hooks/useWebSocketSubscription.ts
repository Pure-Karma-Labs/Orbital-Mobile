/**
 * Hook to subscribe/unsubscribe a conversation for real-time WebSocket updates.
 *
 * Subscribes on mount (or when conversationId changes), unsubscribes on
 * unmount or when the conversationId changes. No-op when conversationId is null.
 */

import { useEffect } from 'react';
import { websocketManager } from '../services/websocket';

export function useWebSocketSubscription(
  conversationId: string | null,
): void {
  useEffect(() => {
    if (!conversationId) return;
    websocketManager.subscribe(conversationId);
    return () => {
      websocketManager.unsubscribe(conversationId);
    };
  }, [conversationId]);
}
