/**
 * Thread data service — orchestrates fetch, decrypt, and store operations.
 *
 * This is the single entry point for thread and reply data loading.
 * Components call these functions; they never call API or crypto directly.
 *
 * Flow: API fetch -> crypto decrypt -> store upsert
 *
 * SECURITY: Decrypted content is only held in the store (in-memory).
 * Plaintext never appears in logs or error messages.
 */

import { getThread, getThreadReplies, createReply } from './api/threads';
import {
  decryptContent,
  encryptContent,
  getOrFetchGroupKey,
} from './crypto/contentCrypto';
import { useAppStore } from '../stores/useAppStore';
import { generateUUID } from '../utils/uuid';
import type { Thread, Reply } from '../types/store';
import type { ThreadResponse, ReplyResponse } from '../types/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the store's action methods without subscribing to state changes.
 * Safe for use outside of React components.
 */
function getStoreActions() {
  return useAppStore.getState();
}

/**
 * Map a ThreadResponse (API) to a Thread (store), decrypting content fields.
 * groupId on the API maps to conversationId in the store.
 */
async function mapThreadResponse(
  response: ThreadResponse,
  groupKey: Uint8Array,
): Promise<Thread> {
  // Decrypt title and body — only if present (can be null)
  const [title, body] = await Promise.all([
    response.encryptedTitle && response.titleIv
      ? decryptContent(
          response.encryptedTitle,
          response.titleIv,
          groupKey,
          response.groupId,
        )
      : Promise.resolve(null),
    response.encryptedBody && response.bodyIv
      ? decryptContent(
          response.encryptedBody,
          response.bodyIv,
          groupKey,
          response.groupId,
        )
      : Promise.resolve(null),
  ]);

  return {
    id: response.id,
    conversationId: response.groupId,
    authorId: response.authorId,
    authorUsername: response.authorUsername,
    title,
    body,
    contentType: response.contentType,
    pinned: response.pinned,
    replyCount: response.replyCount,
    lastReplyAt: response.lastReplyAt
      ? new Date(response.lastReplyAt).getTime()
      : null,
    createdAt: new Date(response.createdAt).getTime(),
    updatedAt: new Date(response.updatedAt).getTime(),
    syncStatus: 'synced',
  };
}

/**
 * Map a ReplyResponse (API) to a Reply (store), decrypting the body.
 */
async function mapReplyResponse(
  response: ReplyResponse,
  groupKey: Uint8Array,
  groupId: string,
): Promise<Reply> {
  const body = await decryptContent(
    response.encryptedBody,
    response.bodyIv,
    groupKey,
    groupId,
  );

  return {
    id: response.id,
    threadId: response.threadId,
    authorId: response.authorId,
    authorUsername: response.authorUsername,
    body,
    parentReplyId: response.parentReplyId,
    depth: response.depth,
    createdAt: new Date(response.createdAt).getTime(),
    updatedAt: new Date(response.updatedAt).getTime(),
    syncStatus: 'synced',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a thread from the API, decrypt its content, and upsert into the store.
 *
 * @param threadId - The thread to load.
 * @returns The decrypted Thread object.
 */
export async function loadThread(threadId: string): Promise<Thread> {
  const response = await getThread(threadId);
  const groupKey = await getOrFetchGroupKey(response.groupId);
  const thread = await mapThreadResponse(response, groupKey);

  getStoreActions().upsertThread(thread);
  return thread;
}

/**
 * Fetch replies for a thread (paginated), decrypt content, and load into the store.
 *
 * First page (no cursor): uses setReplies() to replace all replies.
 * Subsequent pages (with cursor): uses appendReplies() to add without wiping.
 *
 * @param threadId - The thread whose replies to load.
 * @param groupId  - The group ID for decryption (AAD).
 * @param cursor   - Pagination cursor from a previous call.
 * @returns Decrypted replies and the next pagination cursor.
 */
export async function loadReplies(
  threadId: string,
  groupId: string,
  cursor?: string,
): Promise<{ replies: Reply[]; nextCursor: string | null; hasMore: boolean }> {
  const response = await getThreadReplies(threadId, cursor);
  const groupKey = await getOrFetchGroupKey(groupId);

  // Batch decrypt all replies in parallel
  const replies = await Promise.all(
    response.items.map((r) => mapReplyResponse(r, groupKey, groupId)),
  );

  const store = getStoreActions();
  if (!cursor) {
    // First page — replace all replies for this thread
    store.setReplies(threadId, replies);
  } else {
    // Subsequent page — append without replacing
    store.appendReplies(threadId, replies);
  }

  return {
    replies,
    nextCursor: response.cursor,
    hasMore: response.hasMore,
  };
}

/**
 * Encrypt and post a reply with optimistic UI.
 *
 * 1. Encrypts the body with the group key.
 * 2. Adds an optimistic reply to the store immediately.
 * 3. Sends the encrypted reply to the API.
 * 4. Updates sync status on success or failure.
 *
 * @param threadId      - The thread to reply to.
 * @param groupId       - The group ID for encryption (AAD).
 * @param body          - Plaintext reply body.
 * @param parentReplyId - Parent reply ID for nested replies, or null for top-level.
 * @param depth         - The depth of the new reply (0 for top-level, parent.depth + 1 for nested).
 * @param authorId      - The current user's ID.
 * @param authorUsername - The current user's username.
 * @returns The finalized Reply object.
 */
export async function postReply(
  threadId: string,
  groupId: string,
  body: string,
  parentReplyId: string | null,
  depth: number,
  authorId: string,
  authorUsername: string,
): Promise<Reply> {
  const groupKey = await getOrFetchGroupKey(groupId);
  const encrypted = await encryptContent(body, groupKey, groupId);

  // Generate client-side UUID for offline-first
  const clientId = generateUUID();
  const now = Date.now();

  // Optimistic reply — added to store immediately
  const optimisticReply: Reply = {
    id: clientId,
    threadId,
    authorId,
    authorUsername,
    body,
    parentReplyId,
    depth,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'pending',
  };

  const store = getStoreActions();
  store.addOptimisticReply(optimisticReply);

  try {
    const response = await createReply(threadId, {
      id: clientId,
      encryptedBody: encrypted.ciphertext,
      bodyIv: encrypted.iv,
      parentReplyId,
    });

    // Update with server-confirmed data
    store.updateReplySyncStatus(clientId, 'synced');

    return {
      ...optimisticReply,
      // Server may return a different ID if it doesn't honour client IDs
      id: response.id !== clientId ? response.id : clientId,
      createdAt: new Date(response.createdAt).getTime(),
      updatedAt: new Date(response.updatedAt).getTime(),
      syncStatus: 'synced',
    };
  } catch {
    store.updateReplySyncStatus(clientId, 'failed');
    throw new Error('Failed to post reply');
  }
}
