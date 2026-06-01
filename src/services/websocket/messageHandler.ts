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
  wrapGroupKey,
  evictPendingCache,
} from '../crypto/contentCrypto';
import { resolveRemoteIdentityKey } from '../crypto/identityKeyAccess';
import { submitWrappedKey } from '../api/groups';
import { decryptThreadFields, decryptReplyBody, processMediaMetadata } from '../threadService';
import { ensureDmConversation } from '../conversationService';
import { useAppStore } from '../../stores/useAppStore';
import { LRUSet } from './lruSet';
import type {
  BroadcastEnvelope,
  BroadcastPayload,
  NewThreadPayload,
  NewReplyPayload,
  DisplayNameChangedPayload,
  WrapKeyRequestPayload,
  WrappedKeyDeliveredPayload,
  MediaUploadedPayload,
} from './types';
import type { Thread, Reply } from '../../types/store';

// ============================================================
// Deduplication
// ============================================================

const dedupSet = new LRUSet(500);

const wrapDedup = new Map<string, number>();
const deliveryDedup = new Map<string, number>();
const WRAP_DEDUP_TTL_MS = 30_000;
const MAX_DEDUP_SIZE = 200;

function sweepExpired(map: Map<string, number>): void {
  if (map.size <= MAX_DEDUP_SIZE) return;
  const now = Date.now();
  for (const [key, expiry] of map) {
    if (now >= expiry) map.delete(key);
  }
}

export function clearMessageHandlerState(): void {
  dedupSet.clear();
  wrapDedup.clear();
  deliveryDedup.clear();
}

// ============================================================
// Allowed broadcast data.type values (WS-05)
// ============================================================

export const KNOWN_BROADCAST_TYPES = new Set([
  'new_thread',
  'new_reply',
  'new_message',
  'display_name_changed',
  'media_uploaded',
]);

export const KNOWN_UNICAST_TYPES = new Set([
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
    console.error('[WS:parse_failure]');
    if (__DEV__) {
      console.warn('[WS] Failed to parse message as JSON');
    }
    return;
  }

  const message = snakeToCamel(parsed) as Record<string, unknown>;
  const type = message.type as string | undefined;

  if (!type) {
    console.error('[WS:missing_type]');
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

    case 'wrap_key_request':
      await handleWrapKeyRequest(message as unknown as WrapKeyRequestPayload);
      break;

    case 'wrapped_key_delivered':
      await handleWrappedKeyDelivered(message as unknown as WrappedKeyDeliveredPayload);
      break;

    default:
      console.error('[WS:unknown_type]');
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
    console.error('[WS:unknown_broadcast]');
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

    case 'media_uploaded':
      handleMediaUploaded(data as MediaUploadedPayload);
      break;
  }
}

// ============================================================
// new_thread handler
// ============================================================

async function handleNewThread(data: NewThreadPayload): Promise<void> {
  if (dedupSet.has(data.threadId)) {
    return;
  }
  dedupSet.add(data.threadId);

  try {
    await ensureDmConversation(data.groupId);

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
    useAppStore.getState().bumpLastMessageAt(
      data.groupId,
      new Date(data.createdAt).getTime(),
    );

    const storeAfterBump = useAppStore.getState();
    if (data.groupId !== storeAfterBump.viewingConversationId) {
      storeAfterBump.incrementUnreadCount(data.groupId);
    }

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
  } catch (e) {
    dedupSet.delete(data.threadId);
    console.error('[WS:new_thread_failed]');
    if (__DEV__) {
      console.warn('[WS handleNewThread] failed:', e instanceof Error ? e.message : e);
    }
  }
}

// ============================================================
// new_reply handler
// ============================================================

async function handleNewReply(data: NewReplyPayload): Promise<void> {
  if (dedupSet.has(data.replyId)) {
    return;
  }
  dedupSet.add(data.replyId);

  try {
    await ensureDmConversation(data.groupId);

    const body = await decryptWithRetry(
      data.groupId,
      async (groupKey) =>
        decryptReplyBody(data.encryptedBody, data.bodyIv, groupKey, data.groupId),
    );

    const depth = data.parentReplyId === null ? 0 : 1;

    const reply: Reply = {
      id: data.replyId,
      threadId: data.threadId,
      authorId: data.authorId,
      authorUsername: data.authorName,
      body,
      parentReplyId: data.parentReplyId,
      depth,
      createdAt: new Date(data.createdAt).getTime(),
      updatedAt: new Date(data.createdAt).getTime(),
      syncStatus: 'synced',
    };

    useAppStore.getState().upsertReply(reply);
    useAppStore.getState().bumpLastMessageAt(
      data.groupId,
      new Date(data.createdAt).getTime(),
    );

    const storeAfterBump = useAppStore.getState();
    if (data.groupId !== storeAfterBump.viewingConversationId) {
      storeAfterBump.incrementUnreadCount(data.groupId);
    }

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
  } catch (e) {
    dedupSet.delete(data.replyId);
    console.error('[WS:new_reply_failed]');
    if (__DEV__) {
      console.warn('[WS handleNewReply] failed:', e instanceof Error ? e.message : e);
    }
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
    username: existing?.username ?? null,
    displayName: data.displayName,
    avatarPath: existing?.avatarPath ?? null,
    conversationIds: existing?.conversationIds ?? [],
  });
}

// ============================================================
// ============================================================
// media_uploaded handler
// ============================================================

/**
 * Handle media_uploaded broadcast.
 *
 * This fires when another member completes a media upload. The media will
 * be associated with a thread/reply when the corresponding new_thread or
 * new_reply broadcast arrives (which calls processMediaMetadata). For now
 * we log in __DEV__ to confirm receipt — the actual processing is deferred
 * to the thread/reply handler that provides the parent context.
 */
function handleMediaUploaded(_data: MediaUploadedPayload): void {
  if (__DEV__) {
    console.log('[WS] media_uploaded received');
  }
}

// ============================================================
// wrap_key_request handler
// ============================================================

async function handleWrapKeyRequest(data: WrapKeyRequestPayload): Promise<void> {
  const dedupKey = `${data.groupId}:${data.targetUserId}`;
  const dedupUntil = wrapDedup.get(dedupKey);
  if (dedupUntil && Date.now() < dedupUntil) return;
  wrapDedup.set(dedupKey, Date.now() + WRAP_DEDUP_TTL_MS);
  sweepExpired(wrapDedup);

  try {
    const groupKey = await getOrFetchGroupKey(data.groupId);
    const currentUserId = useAppStore.getState().userId;
    if (!currentUserId) return;
    const targetPubKey = await resolveRemoteIdentityKey(data.targetUserId, currentUserId);
    const wrapped = wrapGroupKey(groupKey, targetPubKey, data.groupId);
    await submitWrappedKey(data.groupId, data.targetUserId, wrapped);
  } catch (e) {
    wrapDedup.delete(dedupKey);
    if (__DEV__) {
      console.warn('[WS] wrap_key_request failed:', e instanceof Error ? e.message : e);
    }
  }
}

// ============================================================
// wrapped_key_delivered handler
// ============================================================

async function handleWrappedKeyDelivered(data: WrappedKeyDeliveredPayload): Promise<void> {
  const dedupUntil = deliveryDedup.get(data.groupId);
  if (dedupUntil && Date.now() < dedupUntil) return;
  deliveryDedup.set(data.groupId, Date.now() + WRAP_DEDUP_TTL_MS);
  sweepExpired(deliveryDedup);

  try {
    evictPendingCache(data.groupId);
    // When group key rotation lands, must invalidateGroupKey before getOrFetchGroupKey
    // to avoid the cache short-circuit.
    await getOrFetchGroupKey(data.groupId);
  } catch (e) {
    if (__DEV__) {
      console.warn('[WS] wrapped_key_delivered failed:', e instanceof Error ? e.message : e);
    }
  }
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
    console.error('[WS:decrypt_retry]');
    if (__DEV__) {
      console.warn('[WS] Decrypt failed, invalidating key and retrying');
    }
    // Invalidate cached key and re-fetch from API
    invalidateGroupKey(groupId);
    groupKey = await getOrFetchGroupKey(groupId);
    return decryptFn(groupKey);
  }
}
