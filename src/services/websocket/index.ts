/**
 * WebSocket module — barrel exports.
 */

export { websocketManager, createWebSocketManager } from './websocketManager';
export { handleServerMessage } from './messageHandler';
export { LRUSet } from './lruSet';
export { calculateBackoff, shouldReconnect } from './reconnect';
export type {
  ConnectionStatus,
  TypingEntry,
  ServerMessage,
  ClientMessage,
  BroadcastEnvelope,
  BroadcastPayload,
  NewThreadPayload,
  NewReplyPayload,
  NewSignalMessagePayload,
  DisplayNameChangedPayload,
  TypingPayload,
} from './types';
export {
  WS_CLOSE_NORMAL,
  WS_CLOSE_AUTH_FAILURE,
} from './types';
