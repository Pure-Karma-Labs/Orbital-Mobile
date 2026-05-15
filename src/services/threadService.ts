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
  invalidateGroupKey,
} from './crypto/contentCrypto';
import { useAppStore } from '../stores/useAppStore';
import { generateUUID } from '../utils/uuid';
import { getMedia, saveMedia } from '../database/repositories/mediaRepository';
import type { Thread, Reply, MediaItem } from '../types/store';
import type { MediaRow } from '../database/repositories/mediaRepository';
import type { ThreadResponse, ThreadListItem, ReplyResponse, MediaMetadata } from '../types/api';

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

// ---------------------------------------------------------------------------
// Media metadata helpers
// ---------------------------------------------------------------------------

/** Convert a MediaRow (DB) to a MediaItem (store). */
function mediaRowToItem(row: MediaRow): MediaItem {
  return {
    id: row.id,
    threadId: row.thread_id,
    replyId: row.reply_id,
    contentType: row.content_type,
    fileName: row.file_name,
    fileSize: row.file_size,
    width: row.width,
    height: row.height,
    duration: row.duration,
    blurHash: null,
    localPath: row.local_path,
    thumbnailPath: row.thumbnail_path,
    downloadState: (row.download_state as MediaItem['downloadState']) ?? 'pending',
    uploadState: (row.upload_state as MediaItem['uploadState']) ?? 'pending',
    expiresAt: null,
    hasKeys: row.attachment_key != null,
  };
}

/**
 * Decrypt encrypted metadata envelope and extract inner fields.
 * Returns parsed fields or null if decryption/parsing fails.
 */
async function decryptMediaMetadataEnvelope(
  encryptedMetadata: string,
  groupKey: Uint8Array,
  groupId: string,
): Promise<{
  contentType?: string;
  fileName?: string;
  width?: number;
  height?: number;
  digest?: string;
} | null> {
  // The metadata envelope is a JSON string with { ciphertext, iv }
  let envelope: { ciphertext: string; iv: string };
  try {
    envelope = JSON.parse(encryptedMetadata);
  } catch {
    return null;
  }
  if (!envelope.ciphertext || !envelope.iv) return null;

  const plainJson = decryptContent(envelope.ciphertext, envelope.iv, groupKey, groupId);
  return JSON.parse(plainJson);
}

/**
 * Process a batch of MediaMetadata items received from the API or WebSocket.
 *
 * Per-item try/catch — one corrupt item must not drop siblings.
 * For existing DB rows (e.g. own uploads), we skip the DB write to avoid
 * clobbering attachment_key / local_path / download_state.
 *
 * @param mediaList   - Raw MediaMetadata from API/WS.
 * @param groupKey    - 32-byte AES-256 group key.
 * @param groupId     - Group identifier (AAD for AES-GCM).
 * @param parentRef   - { threadId } or { replyId } to index the media.
 */
export async function processMediaMetadata(
  mediaList: MediaMetadata[],
  groupKey: Uint8Array,
  groupId: string,
  parentRef: { threadId: string } | { replyId: string },
): Promise<void> {
  if (!mediaList || mediaList.length === 0) return;

  const store = getStoreActions();
  const items: MediaItem[] = [];

  for (const meta of mediaList) {
    try {
      // Check if we already have this media in the DB (e.g. own upload)
      let existingRow: MediaRow | null = null;
      try {
        existingRow = getMedia(meta.mediaId);
      } catch {
        // DB may not be initialized — treat as new
      }

      if (existingRow) {
        // Row exists — don't clobber attachment_key, local_path, download_state
        items.push(mediaRowToItem(existingRow));
        continue;
      }

      // Determine thread/reply association from parentRef
      const threadId = 'threadId' in parentRef ? parentRef.threadId : null;
      const replyId = 'replyId' in parentRef ? parentRef.replyId : null;

      // Decrypt metadata to extract contentType, fileName, dimensions, digest
      let contentType = meta.contentType ?? 'application/octet-stream';
      let fileName = meta.fileName ?? null;
      let width = meta.width ?? null;
      let height = meta.height ?? null;
      let digest: string | null = null;

      if (meta.encryptedMetadata) {
        // Try to decrypt metadata with retry on failure (key rotation)
        let parsed = await decryptMediaMetadataEnvelope(
          meta.encryptedMetadata,
          groupKey,
          groupId,
        );

        if (!parsed) {
          // Retry with fresh key
          invalidateGroupKey(groupId);
          const freshKey = await getOrFetchGroupKey(groupId);
          parsed = await decryptMediaMetadataEnvelope(
            meta.encryptedMetadata,
            freshKey,
            groupId,
          );
        }

        if (parsed) {
          contentType = parsed.contentType ?? contentType;
          fileName = parsed.fileName ?? fileName;
          width = parsed.width ?? width;
          height = parsed.height ?? height;
          digest = parsed.digest ?? null;
        }
      }

      // Build and persist DB row
      const row: MediaRow = {
        id: meta.mediaId,
        thread_id: threadId,
        reply_id: replyId,
        message_id: null,
        content_type: contentType,
        file_name: fileName,
        file_size: meta.sizeBytes,
        width,
        height,
        duration: meta.duration ?? null,
        attachment_key: null, // Receiver doesn't have keys in v1
        attachment_digest: digest,
        cdn_number: null,
        cdn_key: null,
        local_path: null,
        thumbnail_path: null,
        download_state: 'pending',
        upload_state: 'done',
        created_at: meta.uploadedAt
          ? new Date(meta.uploadedAt).getTime()
          : Date.now(),
      };

      try {
        saveMedia(row);
      } catch (e) {
        if (__DEV__) {
          console.warn('[processMediaMetadata] saveMedia failed:', e instanceof Error ? e.message : e);
        }
      }

      const item: MediaItem = {
        id: meta.mediaId,
        threadId,
        replyId,
        contentType,
        fileName,
        fileSize: meta.sizeBytes,
        width,
        height,
        duration: meta.duration ?? null,
        blurHash: meta.blurHash ?? null,
        localPath: null,
        thumbnailPath: null,
        downloadState: 'pending',
        uploadState: 'done',
        expiresAt: meta.expiresAt ? new Date(meta.expiresAt).getTime() : null,
        hasKeys: false,
      };

      items.push(item);
    } catch (e) {
      // Per-item resilience — skip this item, continue with siblings
      if (__DEV__) {
        console.warn(
          '[processMediaMetadata] Failed to process media item:',
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  if (items.length === 0) return;

  // Populate the store index maps
  if ('threadId' in parentRef) {
    store.setMediaForThread(parentRef.threadId, items);
  } else {
    store.setMediaForReply(parentRef.replyId, items);
  }
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

  // Process thread-level media (non-blocking — reply rendering must not be blocked)
  if (response.media && response.media.length > 0) {
    processMediaMetadata(
      response.media,
      groupKey,
      response.groupId,
      { threadId: response.threadId },
    ).catch((e) => {
      if (__DEV__) {
        console.warn('[mapThreadResponse] media processing failed:', e instanceof Error ? e.message : e);
      }
    });
  }

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

  // Process per-reply media (non-blocking — reply rendering must not be blocked)
  if (response.media && response.media.length > 0) {
    try {
      processMediaMetadata(
        response.media,
        groupKey,
        groupId,
        { replyId: response.replyId },
      ).catch((e) => {
        if (__DEV__) {
          console.warn('[mapReplyResponse] media processing failed:', e instanceof Error ? e.message : e);
        }
      });
    } catch {
      // Protect reply rendering from any media-pipeline bug
    }
  }

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

  // Process thread-level media from the replies response (TD-T7: both levels exist)
  if (response.media && response.media.length > 0) {
    processMediaMetadata(response.media, groupKey, groupId, { threadId }).catch(
      (e) => {
        if (__DEV__) {
          console.warn('[loadReplies] thread-level media processing failed:', e instanceof Error ? e.message : e);
        }
      },
    );
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

    // Process server-confirmed media (updates expiresAt, server-set fields)
    // Uses existing-row check to avoid overwriting local attachment_key/localPath
    if (response.media && response.media.length > 0) {
      processMediaMetadata(
        response.media,
        groupKey,
        groupId,
        { replyId: response.replyId },
      ).catch((e) => {
        if (__DEV__) {
          console.warn('[postReply] media processing failed:', e instanceof Error ? e.message : e);
        }
      });
    }

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

    // Process server-confirmed media (updates expiresAt, server-set fields)
    // Uses existing-row check to avoid overwriting local attachment_key/localPath
    if (response.media && response.media.length > 0) {
      processMediaMetadata(
        response.media,
        groupKey,
        groupId,
        { threadId: response.threadId },
      ).catch((e) => {
        if (__DEV__) {
          console.warn('[createNewThread] media processing failed:', e instanceof Error ? e.message : e);
        }
      });
    }

    return finalThread;
  } catch (e) {
    if (__DEV__) {
      console.warn('[createNewThread]', e instanceof Error ? e.message : e);
    }
    store.updateThreadSyncStatus(clientId, 'failed');
    throw new Error('Failed to create thread');
  }
}
