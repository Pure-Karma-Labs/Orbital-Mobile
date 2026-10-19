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
import { setWrapDeliveryDedupClearer } from '../crypto/wrapDeliveryHook';
import { refreshAndCompareIdentityKey, compareAndPersistIdentityKey, normalizeIdentityKey } from '../crypto/identityKeyAccess';
import { base64ToArrayBuffer } from '../crypto/utils';
import { VerifiedStatus } from '../../types/database';
import { submitWrappedKey } from '../api/groups';
import { decryptThreadFields, decryptReplyBody, processMediaMetadata, applyReplyToParentThread, getKnownThreadAuthorId } from '../threadService';
import { ensureDmConversation, hydrateContactsFromOrbits, refreshContactAvatar, retryPendingNameDecrypt, retryAllPendingNameDecrypts, markConversationReadEverywhere } from '../conversationService';
import { isDatabaseInitialized } from '../../database/connection';
import { saveThread as dbSaveThread } from '../../database/repositories/threadRepository';
import { saveReply as dbSaveReply } from '../../database/repositories/replyRepository';
import { invalidateAvatarCache } from '../avatarService';
import { useAppStore } from '../../stores/useAppStore';
import { isValidUUIDv4 } from '../../utils/uuid';
import { LRUSet } from './lruSet';
import type {
  BroadcastEnvelope,
  BroadcastPayload,
  NewThreadPayload,
  NewReplyPayload,
  DisplayNameChangedPayload,
  AvatarChangedPayload,
  OwnerChangedPayload,
  WrapKeyRequestPayload,
  WrappedKeyDeliveredPayload,
  MediaUploadedPayload,
} from './types';
import type { Thread, Reply } from '../../types/store';

// ============================================================
// Deduplication
// ============================================================

const dedupSet = new LRUSet(500);

/**
 * Threads whose `new_thread` was dropped because their author is blocked, and
 * WHICH author that was (#897).
 *
 * A post-block thread by a blocked author is never written to the store or to
 * SQLite, so `getKnownThreadAuthorId` cannot resolve its author — and without
 * that, a NON-blocked member's reply on it would still badge the orbit and bump
 * a thread the app refuses to show. Remembering the dropped threads is the only
 * local way to recognise those replies.
 *
 * It maps threadId -> authorId rather than being a bare Set (#906 review) so
 * the guard re-asks the CURRENT blocked set instead of trusting a past
 * decision: an unblock — local or hydrated from another device — self-corrects
 * on the next reply with no teardown hook of its own, because the recorded
 * author is simply no longer in `blockedSet`. A Set would have gone on dropping
 * that thread's replies for the rest of the session.
 *
 * Bounded like `dedupSet` (an unbounded map would grow for the whole session),
 * evicting oldest-first, and cleared by `clearMessageHandlerState` on logout.
 */
const MAX_DROPPED_BLOCKED_THREADS = 500;
const droppedBlockedThreadAuthors = new Map<string, string>();

function recordDroppedBlockedThread(threadId: string, authorId: string): void {
  droppedBlockedThreadAuthors.delete(threadId);
  droppedBlockedThreadAuthors.set(threadId, authorId);
  if (droppedBlockedThreadAuthors.size > MAX_DROPPED_BLOCKED_THREADS) {
    // Map iterates in insertion order, so the first key is the oldest entry.
    const oldest = droppedBlockedThreadAuthors.keys().next();
    if (!oldest.done) droppedBlockedThreadAuthors.delete(oldest.value);
  }
}

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
  droppedBlockedThreadAuthors.clear();
  wrapDedup.clear();
  deliveryDedup.clear();
}

/**
 * Let the crypto layer drop this group's delivery-dedup entry (#912).
 *
 * After a self-heal demote, the next `wrapped_key_delivered` is the heal
 * landing — but the event that exposed the dead envelope has usually already
 * claimed the group's 30-second dedup slot, so without this the re-wrap would
 * be ignored until the TTL expired.
 *
 * Registered through `crypto/wrapDeliveryHook` rather than imported by
 * `contentCrypto`, because this module already imports `contentCrypto` (an
 * import cycle) and the crypto layer is fenced off from `websocket/`.
 * Module scope, per the #677 rule for subscriptions and registrations.
 */
setWrapDeliveryDedupClearer((groupId) => {
  deliveryDedup.delete(groupId);
});

// ============================================================
// Allowed broadcast data.type values (WS-05)
// ============================================================

export const KNOWN_BROADCAST_TYPES = new Set([
  'new_thread',
  'new_reply',
  'new_message',
  'display_name_changed',
  'media_uploaded',
  'avatar_changed',
  'owner_changed',
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
      hydrateContactsFromOrbits().catch(() => {});
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

  // #327: On (re)connect, retry any stranded pending orbit name decrypts.
  // Fire-and-forget — failures are logged inside retryAllPendingNameDecrypts.
  retryAllPendingNameDecrypts().catch(() => {});
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

    case 'avatar_changed':
      handleAvatarChanged(data as AvatarChangedPayload);
      break;

    case 'owner_changed':
      handleOwnerChanged(data as OwnerChangedPayload);
      break;
  }
}

// ============================================================
// new_thread handler
// ============================================================

async function handleNewThread(data: NewThreadPayload): Promise<void> {
  if (!isValidUUIDv4(data.groupId) || !isValidUUIDv4(data.threadId) || !isValidUUIDv4(data.authorId)) {
    console.error('[WS:invalid_uuid]');
    return;
  }

  // Block guard: silently drop content from blocked users before any processing
  const blockedSet = new Set(useAppStore.getState().blockedUserIds);
  if (blockedSet.has(data.authorId)) {
    if (__DEV__) console.log('[WS] dropped thread from blocked user', data.authorId);
    // Remembered WITH its author so replies on this thread can be dropped too
    // (#897): nothing about it is persisted, so its author is otherwise
    // unknowable locally. Keeping the author is what lets a later unblock
    // release the thread (#906 review).
    recordDroppedBlockedThread(data.threadId, data.authorId);
    return;
  }

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
      contentType: data.media && data.media.length > 0 ? 'media' : 'text',
      pinned: false,
      replyCount: 0,
      lastReplyAt: null,
      createdAt: new Date(data.createdAt).getTime(),
      updatedAt: new Date(data.createdAt).getTime(),
      syncStatus: 'synced',
    };

    // Write-through: persist decrypted thread to SQLCipher
    if (isDatabaseInitialized()) {
      try {
        dbSaveThread(thread);
      } catch (e) {
        if (__DEV__) console.warn('[WS handleNewThread] DB write failed:', e instanceof Error ? e.message : e);
      }
    }

    useAppStore.getState().upsertThread(thread);
    useAppStore.getState().bumpLastMessageAt(
      data.groupId,
      new Date(data.createdAt).getTime(),
    );

    const storeAfterBump = useAppStore.getState();
    if (data.groupId !== storeAfterBump.viewingConversationId) {
      storeAfterBump.incrementUnreadCount(data.groupId);
    } else {
      // User is viewing this conversation — advance the server watermark
      markConversationReadEverywhere(data.groupId);
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
  if (!isValidUUIDv4(data.groupId) || !isValidUUIDv4(data.replyId) || !isValidUUIDv4(data.threadId) || !isValidUUIDv4(data.authorId)) {
    console.error('[WS:invalid_uuid]');
    return;
  }

  // Block guard: silently drop content from blocked users before any processing
  const blockedSet = new Set(useAppStore.getState().blockedUserIds);
  if (blockedSet.has(data.authorId)) {
    if (__DEV__) console.log('[WS] dropped reply from blocked user', data.authorId);
    return;
  }

  // Parent guard (#897): a NOT-blocked member's reply on a BLOCKED author's
  // thread must not reach `applyReplyToParentThread` (replyCount + 1, recency
  // bump) or `incrementUnreadCount` — it would badge activity on a thread the
  // app hides. WS fan-out is not block-filtered server-side, so this is the
  // enforcement point. Before the dedup add, so a dropped id is not burned.
  //
  // The parent's author comes from what is known locally, else from the
  // dropped-thread map, and the decision is ALWAYS re-asked against the
  // current `blockedSet` (#906 review) — so an unblock releases the thread and
  // an unknown parent that was never dropped fails OPEN.
  const parentAuthorId =
    getKnownThreadAuthorId(data.threadId)
    ?? droppedBlockedThreadAuthors.get(data.threadId)
    ?? null;
  const parentBlocked = parentAuthorId !== null && blockedSet.has(parentAuthorId);
  if (parentBlocked) {
    if (__DEV__) console.log("[WS] dropped reply on a blocked author's thread");
    return;
  }

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

    // Write-through: persist decrypted reply to SQLCipher
    if (isDatabaseInitialized()) {
      try {
        dbSaveReply(reply);
      } catch (e) {
        if (__DEV__) console.warn('[WS handleNewReply] DB write failed:', e instanceof Error ? e.message : e);
      }
    }

    const storeBeforeReply = useAppStore.getState();
    storeBeforeReply.upsertReply(reply);

    // Bump the parent thread's replyCount/lastReplyAt, persist it, and lift the
    // conversation. One shared implementation with postReply since #883 — the
    // two cloned copies had drifted (this one never persisted the parent, so a
    // reply-driven bump was lost on the next cold start).
    const replyCreatedAt = new Date(data.createdAt).getTime();
    applyReplyToParentThread(data.groupId, data.threadId, replyCreatedAt);

    const storeAfterBump = useAppStore.getState();
    if (data.groupId !== storeAfterBump.viewingConversationId) {
      storeAfterBump.incrementUnreadCount(data.groupId);
    } else {
      // User is viewing this conversation — advance the server watermark
      markConversationReadEverywhere(data.groupId);
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
  if (!isValidUUIDv4(data.userId)) {
    console.error('[WS:invalid_uuid]');
    return;
  }

  const sanitized = typeof data.displayName === 'string'
    ? data.displayName.replace(/[\p{Cc}\p{Cf}\u200B-\u200F\u2028-\u202F\uFEFF]/gu, '').trim().slice(0, 15)
    : null;
  const displayName = sanitized && sanitized.length > 0 ? sanitized : null;

  const store = useAppStore.getState();
  const existing = store.contacts[data.userId];

  store.upsertContact({
    id: data.userId,
    username: existing?.username ?? null,
    displayName,
    avatarPath: existing?.avatarPath ?? null,
    avatarEncryptedKey: existing?.avatarEncryptedKey ?? null,
    avatarKeyIv: existing?.avatarKeyIv ?? null,
    avatarDigest: existing?.avatarDigest ?? null,
    localAvatarUri: existing?.localAvatarUri ?? null,
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
// avatar_changed handler
// ============================================================

function handleAvatarChanged(data: AvatarChangedPayload): void {
  if (!isValidUUIDv4(data.userId)) {
    console.error('[WS:invalid_uuid]');
    return;
  }

  const store = useAppStore.getState();
  const existing = store.contacts[data.userId];

  if (existing) {
    store.upsertContact({
      ...existing,
      avatarDigest: data.avatarDigest ?? null,
      localAvatarUri: null,
    });
    refreshContactAvatar(data.userId).catch(() => {
      if (__DEV__) console.error('[WS:avatar_refresh_failed]');
    });
  }

  if (data.userId !== store.userId) {
    invalidateAvatarCache(data.userId).catch(() => {});
  }
}

// ============================================================
// owner_changed handler (#471)
// ============================================================

/**
 * Handle owner_changed broadcast — orbit ownership was transferred.
 *
 * Updates the cached isCreator flag on the affected conversation so
 * admin-gated UI (ManageOrbits, OrbitAdminActions) reflects the transfer
 * immediately without requiring an app restart or manual resync.
 *
 * The previous owner does NOT receive this event (they refresh via the
 * HTTP success path). The new owner IS included in the broadcast.
 */
function handleOwnerChanged(data: OwnerChangedPayload): void {
  if (!isValidUUIDv4(data.groupId) || !isValidUUIDv4(data.newOwnerId) || !isValidUUIDv4(data.previousOwnerId)) {
    console.error('[WS:invalid_uuid]');
    return;
  }

  const store = useAppStore.getState();
  const conversation = store.conversations[data.groupId];

  if (!conversation) {
    // Unknown group — possibly left or dissolved; ignore gracefully
    if (__DEV__) {
      console.warn('[WS] owner_changed for unknown group', data.groupId);
    }
    return;
  }

  // Defense-in-depth: backend rejects DM ownership transfers (CANNOT_TRANSFER_DM),
  // so ignore owner_changed for non-group conversations.
  if (conversation.type !== 'group') return;

  // Flip isCreator: true if this user is the new owner, false otherwise
  const isCreator = data.newOwnerId === store.userId;

  store.upsertConversation({
    ...conversation,
    isCreator,
  });
}

// ============================================================
// wrap_key_request handler
// ============================================================

async function handleWrapKeyRequest(data: WrapKeyRequestPayload): Promise<void> {
  if (!isValidUUIDv4(data.groupId) || !isValidUUIDv4(data.targetUserId)) {
    console.error('[WS:invalid_uuid]');
    return;
  }

  const dedupKey = `${data.groupId}:${data.targetUserId}`;
  const dedupUntil = wrapDedup.get(dedupKey);
  if (dedupUntil && Date.now() < dedupUntil) return;
  wrapDedup.set(dedupKey, Date.now() + WRAP_DEDUP_TTL_MS);
  sweepExpired(wrapDedup);

  try {
    const groupKey = await getOrFetchGroupKey(data.groupId);
    const currentUserId = useAppStore.getState().userId;
    if (!currentUserId) return;

    let targetPubKey: ArrayBuffer;
    let identityChanged: boolean;

    // Prefer the server-carried target identity key (avoids an extra
    // fetchRemoteIdentityKeyBundle round-trip).  The server is already the
    // key directory — both reviewers confirmed no trust-model delta.
    //
    // BOUNDED RACE NOTE (crypto plan-review M-4): a WS event queued
    // across a key reset carries the pre-reset key.  This is a bounded
    // race no worse than the old always-fetch path; wraps produced from
    // it are dead-on-arrival and the recipient's next reset/pending cycle
    // re-covers all groups.
    if (
      typeof data.targetIdentityPublicKey === 'string' &&
      data.targetIdentityPublicKey.length > 0
    ) {
      try {
        const decoded = new Uint8Array(base64ToArrayBuffer(data.targetIdentityPublicKey));
        const keyBytes = normalizeIdentityKey(decoded);
        const result = compareAndPersistIdentityKey(data.targetUserId, keyBytes);
        targetPubKey = result.publicKey;
        identityChanged = result.identityChanged;
      } catch {
        // Malformed/wrong-length key — fall back to always-fetch
        const result = await refreshAndCompareIdentityKey(data.targetUserId, currentUserId);
        targetPubKey = result.publicKey;
        identityChanged = result.identityChanged;
      }
    } else {
      // Field absent or empty — defensive fallback to always-fetch
      const result = await refreshAndCompareIdentityKey(data.targetUserId, currentUserId);
      targetPubKey = result.publicKey;
      identityChanged = result.identityChanged;
    }

    if (identityChanged) {
      useAppStore.getState().setContactVerifiedStatus(
        data.targetUserId,
        VerifiedStatus.Unverified,
      );
    }
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
  if (!isValidUUIDv4(data.groupId)) {
    console.error('[WS:invalid_uuid]');
    return;
  }

  const dedupUntil = deliveryDedup.get(data.groupId);
  if (dedupUntil && Date.now() < dedupUntil) return;
  deliveryDedup.set(data.groupId, Date.now() + WRAP_DEDUP_TTL_MS);
  sweepExpired(deliveryDedup);

  try {
    evictPendingCache(data.groupId);
    // When group key rotation lands, must invalidateGroupKey before getOrFetchGroupKey
    // to avoid the cache short-circuit.
    await getOrFetchGroupKey(data.groupId);

    // #912 heal reload. AFTER the fetch resolves, deliberately: the counter
    // means "content for this group can decrypt now", and the open screen's
    // load effect re-runs on it. Bumping before the await would reload the
    // screen against the same dead envelope and put it straight back into the
    // pending state. The 30s pending cache is why the order matters at all —
    // `evictPendingCache` above is what lets this fetch reach the server.
    useAppStore.getState().bumpGroupKeyGeneration(data.groupId);

    // Key obtained — re-decrypt any orbit name that was pending (#325)
    await retryPendingNameDecrypt(data.groupId);
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
