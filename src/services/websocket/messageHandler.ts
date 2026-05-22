/**
 * WebSocket incoming message dispatcher.
 *
 * Parses raw JSON, applies snakeToCamel, and dispatches based on message type.
 * Broadcast envelopes (type: 'new_message') are further dispatched on data.type.
 *
 * SECURITY: Never log ciphertext, IV, key material, or groupId outside __DEV__.
 * On decrypt failure, invalidate the cached group key and retry once (WS-03).
 */

import { snakeToCamel } from '../api/client';
import {
  getOrFetchGroupKey,
  invalidateGroupKey,
} from '../crypto/contentCrypto';
import { decryptThreadFields, decryptReplyBody, processMediaMetadata } from '../threadService';
import { useAppStore } from '../../stores/useAppStore';
import { LRUSet } from './lruSet';
import type {
  BroadcastEnvelope,
  BroadcastPayload,
  NewThreadPayload,
  NewReplyPayload,
  DisplayNameChangedPayload,
  TypingPayload,
} from './types';
import type { Thread, Reply } from '../../types/store';

// ============================================================
// Deduplication
// ============================================================

const dedupSet = new LRUSet(500);

// ============================================================
// Allowed broadcast data.type values (WS-05)
// ============================================================

const KNOWN_BROADCAST_TYPES = new Set([
  'new_thread',
  'new_reply',
  'new_message',
  'display_name_changed',
  'typing',
  'wrap_key_request',
  'wrapped_key_delivered',
]);

// ============================================================
// Main handler
// ============================================================

/**
 * Process a raw WebSocket message string from the server.
 *
 * Parse → snakeToCamel → dispatch by type.
 */
export async function handleServerMessage(raw: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (__DEV__) {
      console.warn('[WS] Failed to parse message as JSON');
    }
    return;
  }

  const message = snakeToCamel(parsed) as Record<string, unknown>;
  const type = message.type as string | undefined;

  if (!type) {
    if (__DEV__) {
      console.warn('[WS] Message missing type field');
    }
    return;
  }

  switch (type) {
    case 'connection_ack':
      handleConnectionAck(message);
      break;

    case 'subscribed':
      if (__DEV__) {
        console.log('[WS] Subscribed to', message.conversationId);
      }
      break;

    case 'error':
      if (__DEV__) {
        console.warn('[WS] Server error:', message.message);
      }
      break;

    case 'pong':
      // No-op — watchdog reset happens in the manager's _onMessage
      break;

    case 'new_message':
      await handleBroadcast(message as unknown as BroadcastEnvelope);
      break;

    default:
      if (__DEV__) {
        console.warn('[WS] Unknown message type:', type);
      }
      break;
  }
}

// ============================================================
// connection_ack handler (TD-02: this is where 'connected' is set)
// ============================================================

function handleConnectionAck(_message: Record<string, unknown>): void {
  const store = useAppStore.getState();
  store.setConnectionStatus('connected');
  store.setLastConnectedAt(Date.now());
  store.setReconnectAttempt(0);
}

// ============================================================
// Broadcast envelope dispatcher
// ============================================================

async function handleBroadcast(envelope: BroadcastEnvelope): Promise<void> {
  const data = envelope.data as BroadcastPayload;

  if (!data || typeof data.type !== 'string') {
    if (__DEV__) {
      console.warn('[WS] Broadcast missing data.type');
    }
    return;
  }

  // WS-05: allow-list guard
  if (!KNOWN_BROADCAST_TYPES.has(data.type)) {
    if (__DEV__) {
      console.warn('[WS] Unknown broadcast data.type:', data.type);
    }
    return;
  }

  switch (data.type) {
    case 'new_thread':
      await handleNewThread(data as NewThreadPayload);
      break;

    case 'new_reply':
      await handleNewReply(data as NewReplyPayload);
      break;

    case 'new_message':
      // Signal Protocol DM — future feature, skip for now
      if (__DEV__) {
        console.log('[WS] Signal DM message received (not yet implemented)');
      }
      break;

    case 'display_name_changed':
      handleDisplayNameChanged(data as DisplayNameChangedPayload);
      break;

    case 'typing':
      handleTyping(data as TypingPayload);
      break;

    case 'wrap_key_request':
      // Handled by conversationService — import is deferred to avoid circular deps
      break;

    case 'wrapped_key_delivered':
      // Handled by conversationService — import is deferred to avoid circular deps
      break;
  }
}

// ============================================================
// new_thread handler
// ============================================================

async function handleNewThread(data: NewThreadPayload): Promise<void> {
  // Dedup check
  if (dedupSet.has(data.threadId)) {
    return;
  }
  dedupSet.add(data.threadId);

  const { title, body } = await decryptWithRetry(
    data.groupId,
    async (groupKey) =>
      decryptThreadFields(
        data.encryptedTitle,
        data.titleIv,
        data.encryptedBody,
        data.bodyIv,
        groupKey,
        data.groupId,
      ),
  );

  const thread: Thread = {
    id: data.threadId,
    conversationId: data.groupId,
    authorId: data.authorId,
    // WS uses authorName, store expects authorUsername
    authorUsername: data.authorName,
    title,
    body,
    contentType: 'text',
    pinned: false,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: new Date(data.createdAt).getTime(),
    updatedAt: new Date(data.createdAt).getTime(),
    syncStatus: 'synced',
  };

  useAppStore.getState().upsertThread(thread);

  // Process thread media (non-blocking)
  if (data.media && data.media.length > 0) {
    const groupKey = await getOrFetchGroupKey(data.groupId);
    processMediaMetadata(
      data.media,
      groupKey,
      data.groupId,
      { threadId: data.threadId },
    ).catch((e) => {
      if (__DEV__) {
        console.warn('[WS handleNewThread] media processing failed:', e instanceof Error ? e.message : e);
      }
    });
  }
}

// ============================================================
// new_reply handler
// ============================================================

async function handleNewReply(data: NewReplyPayload): Promise<void> {
  // Dedup check
  if (dedupSet.has(data.replyId)) {
    return;
  }
  dedupSet.add(data.replyId);

  const body = await decryptWithRetry(
    data.groupId,
    async (groupKey) =>
      decryptReplyBody(data.encryptedBody, data.bodyIv, groupKey, data.groupId),
  );

  // WS payload has no `level` field — compute depth from parentReplyId
  const depth = data.parentReplyId === null ? 0 : 1;

  const reply: Reply = {
    id: data.replyId,
    threadId: data.threadId,
    authorId: data.authorId,
    // WS uses authorName, store expects authorUsername
    authorUsername: data.authorName,
    body,
    parentReplyId: data.parentReplyId,
    depth,
    createdAt: new Date(data.createdAt).getTime(),
    updatedAt: new Date(data.createdAt).getTime(),
    syncStatus: 'synced',
  };

  useAppStore.getState().upsertReply(reply);

  // Process reply media (non-blocking)
  if (data.media && data.media.length > 0) {
    const groupKey = await getOrFetchGroupKey(data.groupId);
    processMediaMetadata(
      data.media,
      groupKey,
      data.groupId,
      { replyId: data.replyId },
    ).catch((e) => {
      if (__DEV__) {
        console.warn('[WS handleNewReply] media processing failed:', e instanceof Error ? e.message : e);
      }
    });
  }
}

// ============================================================
// display_name_changed handler
// ============================================================

function handleDisplayNameChanged(data: DisplayNameChangedPayload): void {
  const store = useAppStore.getState();
  const existing = store.contacts[data.userId];

  store.upsertContact({
    id: data.userId,
    displayName: data.displayName,
    avatarPath: existing?.avatarPath ?? null,
    conversationIds: existing?.conversationIds ?? [],
  });
}

// ============================================================
// typing handler (stub — backend doesn't broadcast yet)
// ============================================================

function handleTyping(data: TypingPayload): void {
  const store = useAppStore.getState();
  store.addTypingUser(data.conversationId, {
    userId: data.userId,
    expiresAt: Date.now() + 5_000,
  });
}

// ============================================================
// Decrypt-with-retry (WS-03)
// ============================================================

/**
 * Attempt decryption. On failure, invalidate the group key cache and retry
 * once with a freshly fetched key. This handles group key rotation.
 *
 * SECURITY: Never log ciphertext, IV, keys, or groupId in production.
 */
async function decryptWithRetry<T>(
  groupId: string,
  decryptFn: (groupKey: Uint8Array) => Promise<T>,
): Promise<T> {
  let groupKey = await getOrFetchGroupKey(groupId);
  try {
    return await decryptFn(groupKey);
  } catch {
    if (__DEV__) {
      console.warn('[WS] Decrypt failed, invalidating key and retrying');
    }
    // Invalidate cached key and re-fetch from API
    invalidateGroupKey(groupId);
    groupKey = await getOrFetchGroupKey(groupId);
    return decryptFn(groupKey);
  }
}
