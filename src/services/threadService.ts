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

import { getThread, getGroupThreads, getThreadReplies, createReply, createThread } from './api/threads';
import {
  decryptContent,
  encryptContent,
  getOrFetchGroupKey,
} from './crypto/contentCrypto';
import { useAppStore } from '../stores/useAppStore';
import { generateUUID } from '../utils/uuid';
import type { Thread, Reply } from '../types/store';
import type { ThreadResponse, ThreadListItem, ReplyResponse } from '../types/api';

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
 * Decrypt title and body fields using the group key.
 * Shared by REST mappers and WebSocket message handler.
 *
 * @param encTitle  - Base64-encoded encrypted title (null if no title).
 * @param titleIv   - Base64-encoded IV for the title (null if no title).
 * @param encBody   - Base64-encoded encrypted body (null if no body).
 * @param bodyIv    - Base64-encoded IV for the body (null if no body).
 * @param groupKey  - 32-byte AES-256 group key.
 * @param groupId   - Group identifier (AAD for AES-GCM).
 * @returns Decrypted { title, body } — either or both may be null.
 */
export async function decryptThreadFields(
  encTitle: string | null,
  titleIv: string | null,
  encBody: string | null,
  bodyIv: string | null,
  groupKey: Uint8Array,
  groupId: string,
): Promise<{ title: string | null; body: string | null }> {
  const [title, body] = await Promise.all([
    encTitle && titleIv
      ? decryptContent(encTitle, titleIv, groupKey, groupId)
      : Promise.resolve(null),
    encBody && bodyIv
      ? decryptContent(encBody, bodyIv, groupKey, groupId)
      : Promise.resolve(null),
  ]);
  return { title, body };
}

/**
 * Decrypt a reply body using the group key.
 * Shared by REST mappers and WebSocket message handler.
 *
 * @param encBody  - Base64-encoded encrypted body.
 * @param bodyIv   - Base64-encoded IV for the body (null if unencrypted).
 * @param groupKey - 32-byte AES-256 group key.
 * @param groupId  - Group identifier (AAD for AES-GCM).
 * @returns Decrypted body string, or the raw encBody if no IV present.
 */
export async function decryptReplyBody(
  encBody: string,
  bodyIv: string | null,
  groupKey: Uint8Array,
  groupId: string,
): Promise<string | null> {
  if (bodyIv) {
    return decryptContent(encBody, bodyIv, groupKey, groupId);
  }
  return encBody;
}

/**
 * Map a ThreadResponse (API) to a Thread (store), decrypting content fields.
 * groupId on the API maps to conversationId in the store.
 */
async function mapThreadResponse(
  response: ThreadResponse,
  groupKey: Uint8Array,
): Promise<Thread> {
  const { title, body } = await decryptThreadFields(
    response.encryptedTitle,
    response.titleIv,
    response.encryptedBody,
    response.bodyIv,
    groupKey,
    response.groupId,
  );

  return {
    id: response.threadId,
    conversationId: response.groupId,
    authorId: response.authorId,
    authorUsername: response.authorUsername,
    title,
    body,
    contentType: 'text',
    pinned: false,
    replyCount: response.replyCount,
    lastReplyAt: null,
    createdAt: new Date(response.createdAt).getTime(),
    updatedAt: new Date(response.createdAt).getTime(),
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
  const body = await decryptReplyBody(
    response.encryptedBody,
    response.bodyIv,
    groupKey,
    groupId,
  );

  return {
    id: response.replyId,
    threadId: response.threadId,
    authorId: response.authorId,
    authorUsername: response.authorUsername,
    body,
    parentReplyId: response.parentReplyId,
    depth: Math.max(0, Math.trunc(response.level) || 0),
    createdAt: new Date(response.createdAt).getTime(),
    updatedAt: new Date(response.createdAt).getTime(),
    syncStatus: 'synced',
  };
}

async function mapThreadListItem(
  item: ThreadListItem,
  groupKey: Uint8Array,
): Promise<Thread> {
  const { title, body } = await decryptThreadFields(
    item.encryptedTitle,
    item.titleIv,
    item.encryptedBody,
    item.bodyIv,
    groupKey,
    item.groupId,
  );

  return {
    id: item.threadId,
    conversationId: item.groupId,
    authorId: item.authorId,
    authorUsername: item.authorUsername,
    title,
    body,
    contentType: 'text',
    pinned: false,
    replyCount: item.replyCount,
    lastReplyAt: null,
    createdAt: new Date(item.createdAt).getTime(),
    updatedAt: new Date(item.createdAt).getTime(),
    syncStatus: 'synced',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all threads for a group from the API, decrypt, and populate the store.
 */
export async function loadThreadsForGroup(groupId: string): Promise<Thread[]> {
  const response = await getGroupThreads(groupId);

  const groupKey = await getOrFetchGroupKey(groupId);

  const threads = await Promise.all(
    response.threads.map((item) => mapThreadListItem(item, groupKey)),
  );

  const store = getStoreActions();
  store.setThreads(groupId, threads);
  return threads;
}

/**
 * Fetch a thread from the API, decrypt its content, and upsert into the store.
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
  offset?: number,
): Promise<{ replies: Reply[]; hasMore: boolean }> {
  const response = await getThreadReplies(threadId, offset);
  const groupKey = await getOrFetchGroupKey(groupId);

  const results = await Promise.allSettled(
    response.replies.map((r) => mapReplyResponse(r, groupKey, groupId)),
  );
  const replies = results
    .filter((r): r is PromiseFulfilledResult<Reply> => r.status === 'fulfilled')
    .map((r) => r.value);

  const store = getStoreActions();
  if (!offset) {
    store.setReplies(threadId, replies);
  } else {
    store.appendReplies(threadId, replies);
  }

  return {
    replies,
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
 * @param author        - The current user's ID and username.
 * @param options       - Optional parameters (mediaIds for attached media).
 * @returns The finalized Reply object.
 */
export async function postReply(
  threadId: string,
  groupId: string,
  body: string,
  parentReplyId: string | null,
  depth: number,
  author: { authorId: string; authorUsername: string },
  options?: { mediaIds?: string[] },
): Promise<Reply> {
  const clientId = generateUUID();
  const now = Date.now();

  const optimisticReply: Reply = {
    id: clientId,
    threadId,
    authorId: author.authorId,
    authorUsername: author.authorUsername,
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
    const groupKey = await getOrFetchGroupKey(groupId);
    const encrypted = await encryptContent(body, groupKey, groupId);

    const response = await createReply(threadId, {
      encryptedBody: encrypted.ciphertext,
      bodyIv: encrypted.iv,
      parentReplyId,
      mediaIds: options?.mediaIds,
    });

    const confirmedReply: Reply = {
      ...optimisticReply,
      id: response.replyId,
      createdAt: new Date(response.createdAt).getTime(),
      updatedAt: new Date(response.createdAt).getTime(),
      syncStatus: 'synced',
    };

    // Replace the optimistic reply (client ID) with the server-confirmed reply
    // so subsequent replies-to-this-reply use the real server ID.
    store.removeReply(clientId);
    store.upsertReply(confirmedReply);

    return confirmedReply;
  } catch (e) {
    if (__DEV__) {
      console.warn('[postReply]', e instanceof Error ? e.message : e);
    }
    store.updateReplySyncStatus(clientId, 'failed');
    throw new Error('Failed to post reply');
  }
}

/**
 * Encrypt and create a new thread with optimistic UI.
 *
 * 1. Encrypts title and body with the group key.
 * 2. Adds an optimistic thread to the store immediately.
 * 3. Sends the encrypted thread to the API.
 * 4. Updates sync status on success or failure.
 *
 * @param groupId - The group to create the thread in.
 * @param title   - Plaintext thread title.
 * @param body    - Plaintext thread body.
 * @param author  - The current user's ID and username.
 * @param options - Optional parameters (mediaIds for attached media).
 */
export async function createNewThread(
  groupId: string,
  title: string,
  body: string,
  author: { authorId: string; authorUsername: string },
  options?: { mediaIds?: string[] },
): Promise<Thread> {
  const clientId = generateUUID();
  const now = Date.now();

  const optimisticThread: Thread = {
    id: clientId,
    conversationId: groupId,
    authorId: author.authorId,
    authorUsername: author.authorUsername,
    title,
    body,
    contentType: 'text',
    pinned: false,
    replyCount: 0,
    lastReplyAt: null,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'pending',
  };

  const store = getStoreActions();
  store.addOptimisticThread(optimisticThread);

  try {
    const groupKey = await getOrFetchGroupKey(groupId);
    const [encTitle, encBody] = await Promise.all([
      encryptContent(title, groupKey, groupId),
      encryptContent(body, groupKey, groupId),
    ]);

    const response = await createThread({
      groupId,
      encryptedTitle: encTitle.ciphertext,
      titleIv: encTitle.iv,
      encryptedBody: encBody.ciphertext,
      bodyIv: encBody.iv,
      mediaIds: options?.mediaIds,
    });

    const finalThread: Thread = {
      ...optimisticThread,
      id: response.threadId,
      createdAt: new Date(response.createdAt).getTime(),
      updatedAt: new Date(response.createdAt).getTime(),
      syncStatus: 'synced',
    };

    store.removeThread(clientId);
    store.upsertThread(finalThread);
    return finalThread;
  } catch (e) {
    if (__DEV__) {
      console.warn('[createNewThread]', e instanceof Error ? e.message : e);
    }
    store.updateThreadSyncStatus(clientId, 'failed');
    throw new Error('Failed to create thread');
  }
}
