/**
 * WebSocket protocol types for Orbital-Mobile ↔ Orbital-Backend communication.
 *
 * Wire format: Backend sends snake_case JSON. The message handler applies
 * snakeToCamel before dispatching, so all field names here are camelCase.
 *
 * Protocol summary:
 * - Server→Client: connection_ack, pong, subscribed, error, new_message (broadcast envelope)
 * - Client→Server: ping, subscribe, typing
 * - Broadcasts are always wrapped in a BroadcastEnvelope (outer type = 'new_message')
 */

// ============================================================
// Connection status
// ============================================================

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

// ============================================================
// Typing entry
// ============================================================

export interface TypingEntry {
  userId: string;
  expiresAt: number;
}

// ============================================================
// WebSocket close codes
// ============================================================

/** Normal closure — server or client cleanly shut down */
export const WS_CLOSE_NORMAL = 1000;

/** Auth failure — JWT expired or invalid; do NOT reconnect */
export const WS_CLOSE_AUTH_FAILURE = 4401;

// ============================================================
// Server → Client messages
// ============================================================

export interface ConnectionAckMessage {
  type: 'connection_ack';
  timestamp: number;
}

export interface PongMessage {
  type: 'pong';
  timestamp: number;
}

export interface SubscribedMessage {
  type: 'subscribed';
  conversationId: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

// ============================================================
// Broadcast payloads (inside BroadcastEnvelope.data)
// ============================================================

export interface NewThreadPayload {
  type: 'new_thread';
  threadId: string;
  groupId: string;
  authorId: string;
  /** WS uses author_name (not author_username like REST) */
  authorName: string;
  encryptedTitle: string | null;
  encryptedBody: string | null;
  titleIv: string | null;
  bodyIv: string | null;
  createdAt: string;
  media: unknown[];
}

export interface NewReplyPayload {
  type: 'new_reply';
  replyId: string;
  threadId: string;
  groupId: string;
  authorId: string;
  /** WS uses author_name (not author_username like REST) */
  authorName: string;
  encryptedBody: string;
  bodyIv: string | null;
  parentReplyId: string | null;
  createdAt: string;
  media: unknown[];
}

export interface NewSignalMessagePayload {
  type: 'new_message';
  messageId: string;
  conversationId: string;
  senderId: string;
  encryptedEnvelope: string;
  serverTimestamp: number;
}

export interface DisplayNameChangedPayload {
  type: 'display_name_changed';
  userId: string;
  displayName: string;
  timestamp: number;
}

export interface TypingPayload {
  type: 'typing';
  userId: string;
  conversationId: string;
}

export type BroadcastPayload =
  | NewThreadPayload
  | NewReplyPayload
  | NewSignalMessagePayload
  | DisplayNameChangedPayload
  | TypingPayload;

// ============================================================
// Broadcast envelope (wraps all broadcast payloads)
// ============================================================

export interface BroadcastEnvelope {
  type: 'new_message';
  conversationId: string;
  timestamp: number;
  data: BroadcastPayload;
}

// ============================================================
// Combined server message union
// ============================================================

export type ServerMessage =
  | ConnectionAckMessage
  | PongMessage
  | SubscribedMessage
  | BroadcastEnvelope
  | ErrorMessage;

// ============================================================
// Client → Server messages
// ============================================================

export interface PingMessage {
  type: 'ping';
}

export interface SubscribeMessage {
  type: 'subscribe';
  data: {
    conversationId: string;
  };
}

export interface TypingMessage {
  type: 'typing';
  data: {
    conversationId: string;
  };
}

export type ClientMessage = PingMessage | SubscribeMessage | TypingMessage;
