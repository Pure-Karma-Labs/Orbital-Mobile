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

import { exists } from '@dr.pogodin/react-native-fs';
import { getThread, getGroupThreads, getThreadReplies, createReply, createThread } from './api/threads';
import {
  decryptContent,
  encryptContent,
  getOrFetchGroupKey,

} from './crypto/contentCrypto';
import { useAppStore } from '../stores/useAppStore';
import { generateUUID } from '../utils/uuid';
import { base64ToArrayBuffer } from './crypto/utils';
import { getMedia, saveMedia } from '../database/repositories/mediaRepository';
import { saveThread as dbSaveThread, saveThreadBatch, getThreadsForConversation } from '../database/repositories/threadRepository';
import { saveReply as dbSaveReply, saveReplyBatch, getRepliesForThread } from '../database/repositories/replyRepository';
import { mediaRowToItem } from '../database/repositories/mediaMapper';
import { isDatabaseInitialized } from '../database/connection';
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

// normalizeAttachmentKey and mediaRowToItem are now imported from
// ../database/repositories/mediaMapper to allow reuse without pulling
// in the full crypto/API dependency chain.

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
  attachmentKey?: string;
  duration?: number;
  thumbnailMediaId?: string;
  thumbnailKey?: string;
  thumbnailDigest?: string;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  thumbnailSizeBytes?: number;
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

const processedMediaIds = new Set<string>();

/** Clear the session-level dedup set. Call on logout to prevent stale entries. */
export function clearProcessedMediaIds(): void {
  processedMediaIds.clear();
}

/**
 * Materialize a thumbnail child row from the parent envelope's thumbnail fields.
 *
 * Validates thumbnailKey (base64 -> 64 bytes) and thumbnailDigest (base64 -> 32 bytes)
 * strictly. On any validation failure, logs a warning and returns null -- the parent
 * is still processed; a malformed key must never persist to a row where it permanently
 * blocks decrypt.
 *
 * When valid and the ID is unseen: creates a DB row + store item for the thumbnail
 * child, marked with is_thumbnail=1 so library queries exclude it.
 *
 * @param parsed - Decrypted envelope fields
 * @param parentRef - Parent thread/reply reference (used for context only; thumbnail rows are unassociated)
 * @param groupKey - Group key (unused here but kept for signature consistency)
 * @param groupId - Group ID (unused here but kept for signature consistency)
 * @param expiresAt - Parent's expires_at timestamp (thumbnails share parent TTL)
 * @returns The created MediaItem, or null if validation fails or ID already seen
 */
function materializeThumbnailRow(
  parsed: {
    thumbnailMediaId?: string;
    thumbnailKey?: string;
    thumbnailDigest?: string;
    thumbnailWidth?: number;
    thumbnailHeight?: number;
    thumbnailSizeBytes?: number;
  },
  expiresAt: number | null,
): MediaItem | null {
  const {
    thumbnailMediaId,
    thumbnailKey,
    thumbnailDigest,
    thumbnailWidth,
    thumbnailHeight,
    thumbnailSizeBytes,
  } = parsed;

  // All three required fields must be present
  if (
    typeof thumbnailMediaId !== 'string' ||
    typeof thumbnailKey !== 'string' ||
    typeof thumbnailDigest !== 'string'
  ) {
    return null;
  }

  // Already processed this session
  if (processedMediaIds.has(thumbnailMediaId)) {
    return null;
  }

  // Validate key length: base64 -> must decode to exactly 64 bytes
  let keyBytes: Uint8Array;
  try {
    keyBytes = new Uint8Array(base64ToArrayBuffer(thumbnailKey));
    if (keyBytes.byteLength !== 64) {
      if (__DEV__) {
        console.warn('[materializeThumbnailRow] invalid thumbnailKey length:', keyBytes.byteLength);
      }
      return null;
    }
  } catch {
    if (__DEV__) {
      console.warn('[materializeThumbnailRow] thumbnailKey decode failed');
    }
    return null;
  }

  // Validate digest length: base64 -> must decode to exactly 32 bytes
  let digestBytes: Uint8Array;
  try {
    digestBytes = new Uint8Array(base64ToArrayBuffer(thumbnailDigest));
    if (digestBytes.byteLength !== 32) {
      if (__DEV__) {
        console.warn('[materializeThumbnailRow] invalid thumbnailDigest length:', digestBytes.byteLength);
      }
      return null;
    }
  } catch {
    if (__DEV__) {
      console.warn('[materializeThumbnailRow] thumbnailDigest decode failed');
    }
    return null;
  }

  // Check store and DB first (store-first / no-clobber)
  const store = getStoreActions();
  const existingStoreItem = (store.media ?? {})[thumbnailMediaId];
  if (existingStoreItem) {
    processedMediaIds.add(thumbnailMediaId);
    return existingStoreItem;
  }

  const dbReady = isDatabaseInitialized();
  if (dbReady) {
    try {
      const existingRow = getMedia(thumbnailMediaId);
      if (existingRow) {
        const item = mediaRowToItem(existingRow);
        processedMediaIds.add(thumbnailMediaId);
        return item;
      }
    } catch {
      // DB query failed — proceed to create
    }
  }

  // Build and persist the thumbnail child row
  const row: MediaRow = {
    id: thumbnailMediaId,
    thread_id: null,
    reply_id: null,
    message_id: null,
    content_type: 'image/jpeg',
    file_name: null,
    file_size: thumbnailSizeBytes ?? 0,
    width: typeof thumbnailWidth === 'number' ? thumbnailWidth : null,
    height: typeof thumbnailHeight === 'number' ? thumbnailHeight : null,
    duration: null,
    attachment_key: keyBytes,
    attachment_digest: digestBytes,
    cdn_number: null,
    cdn_key: null,
    local_path: null,
    thumbnail_path: null,
    blur_hash: null,
    expires_at: expiresAt,
    download_state: 'pending',
    upload_state: 'done',
    created_at: Date.now(),
    thumbnail_media_id: null,
    is_thumbnail: 1,
  };

  if (dbReady) {
    try {
      saveMedia(row);
    } catch (e) {
      if (__DEV__) {
        console.warn('[materializeThumbnailRow] saveMedia failed:', e instanceof Error ? e.message : e);
      }
    }
  }

  const item: MediaItem = {
    id: thumbnailMediaId,
    threadId: null,
    replyId: null,
    contentType: 'image/jpeg',
    fileName: null,
    fileSize: thumbnailSizeBytes ?? 0,
    width: typeof thumbnailWidth === 'number' ? thumbnailWidth : null,
    height: typeof thumbnailHeight === 'number' ? thumbnailHeight : null,
    duration: null,
    blurHash: null,
    localPath: null,
    thumbnailPath: null,
    downloadState: 'pending',
    uploadState: 'done',
    expiresAt,
    hasKeys: true,
    thumbnailMediaId: null,
    isThumbnail: true,
  };

  store.upsertMedia(item);
  processedMediaIds.add(thumbnailMediaId);

  return item;
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

  const dbReady = isDatabaseInitialized();

  // Filter out media already processed this session (7 call sites fire for same media)
  const unprocessed = mediaList.filter(m => !processedMediaIds.has(m.mediaId));
  if (unprocessed.length === 0) {
    // Still need to populate the store index for this parent
    const store = getStoreActions();
    const existingItems = mediaList
      .map(m => (store.media ?? {})[m.mediaId])
      .filter(Boolean) as MediaItem[];
    if (existingItems.length > 0) {
      if ('threadId' in parentRef) {
        store.setMediaForThread(parentRef.threadId, existingItems);
      } else {
        store.setMediaForReply(parentRef.replyId, existingItems);
      }
    }
    return;
  }

  const store = getStoreActions();
  const items: MediaItem[] = [];

  for (const meta of unprocessed) {
    try {
      // Check in-memory store first — it's authoritative during runtime
      // and avoids overwriting hasKeys/localPath from a successful upload
      const storeItem = (store.media ?? {})[meta.mediaId];
      if (storeItem) {
        items.push(storeItem);
        continue;
      }

      // Check DB for persisted media (e.g. own upload from a prior session)
      let existingRow: MediaRow | null = null;
      if (dbReady) {
        try {
          existingRow = getMedia(meta.mediaId);
        } catch {
          // DB query failed — treat as new
        }
      }

      if (existingRow) {
        // If DB says downloaded but the file is gone (simulator switch, cache clear),
        // reset to pending so the download re-triggers.
        if (existingRow.download_state === 'downloaded' && existingRow.local_path) {
          const fileExists = await exists(existingRow.local_path).catch(() => false);
          if (!fileExists) {
            existingRow = { ...existingRow, download_state: 'pending', local_path: null };
            if (dbReady) {
              try {
                saveMedia(existingRow);
              } catch {
                // Best-effort DB update
              }
            }
          }
        }

        // Row exists — try to recover attachment key from envelope if missing
        if (existingRow.attachment_key == null && meta.encryptedMetadata) {
          try {
            const parsed = await decryptMediaMetadataEnvelope(
              meta.encryptedMetadata,
              groupKey,
              groupId,
            );
            if (typeof parsed?.attachmentKey === 'string') {
              const decoded = new Uint8Array(base64ToArrayBuffer(parsed.attachmentKey));
              if (decoded.byteLength === 64) {
                const updatedRow: MediaRow = { ...existingRow, attachment_key: decoded };
                // Backfill thumbnail if present
                if (parsed.thumbnailMediaId) {
                  const envelopeExpiresAt = meta.expiresAt ? new Date(meta.expiresAt).getTime() : null;
                  const thumbItem = materializeThumbnailRow(parsed, envelopeExpiresAt);
                  if (thumbItem) {
                    updatedRow.thumbnail_media_id = parsed.thumbnailMediaId;
                  }
                }
                if (dbReady) {
                  try {
                    saveMedia(updatedRow);
                  } catch (e) {
                    if (__DEV__) {
                      console.warn('[processMediaMetadata] saveMedia (key recovery) failed:', e instanceof Error ? e.message : e);
                    }
                  }
                }
                items.push(mediaRowToItem(updatedRow));
                continue;
              }
            }
          } catch (e) {
            if (__DEV__) {
              console.warn('[processMediaMetadata] key recovery failed:', e instanceof Error ? e.message : e);
            }
          }
        }
        // Row exists with key, or key recovery failed — don't clobber
        items.push(mediaRowToItem(existingRow));
        continue;
      }

      // Determine thread/reply association from parentRef
      const threadId = 'threadId' in parentRef ? parentRef.threadId : null;
      const replyId = 'replyId' in parentRef ? parentRef.replyId : null;

      // Decrypt metadata to extract contentType, fileName, dimensions, digest, attachmentKey
      let contentType = meta.contentType ?? 'application/octet-stream';
      let fileName = meta.fileName ?? null;
      let width = meta.width ?? null;
      let height = meta.height ?? null;
      let digest: string | null = null;
      let attachmentKey: Uint8Array | null = null;

      // Duration and thumbnail fields from envelope (additive, backward-compatible)
      let durationMs: number | null = null;
      let thumbnailMediaId: string | null = null;

      if (meta.encryptedMetadata) {
        // Try to decrypt metadata — no key retry to avoid API call cascade
        // (multiple call sites fire processMediaMetadata for the same media)
        const parsed = await decryptMediaMetadataEnvelope(
          meta.encryptedMetadata,
          groupKey,
          groupId,
        );

        if (parsed) {
          contentType = parsed.contentType ?? contentType;
          fileName = parsed.fileName ?? fileName;
          width = parsed.width ?? width;
          height = parsed.height ?? height;
          digest = parsed.digest ?? null;

          // Duration: seconds (float) on the wire -> milliseconds in DB
          if (typeof parsed.duration === 'number') {
            durationMs = Math.round(parsed.duration * 1000);
          }

          // Extract attachment key from v1+ metadata envelope
          if (typeof parsed.attachmentKey === 'string') {
            try {
              const decoded = new Uint8Array(base64ToArrayBuffer(parsed.attachmentKey));
              attachmentKey = decoded.byteLength === 64 ? decoded : null;
            } catch {
              attachmentKey = null;
            }
          }

          // Materialize thumbnail child row (strict validation, skip on failure)
          if (parsed.thumbnailMediaId) {
            const envelopeExpiresAt = meta.expiresAt ? new Date(meta.expiresAt).getTime() : null;
            const thumbItem = materializeThumbnailRow(parsed, envelopeExpiresAt);
            if (thumbItem) {
              thumbnailMediaId = parsed.thumbnailMediaId;
            }
          }
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
        duration: durationMs ?? (meta.duration ?? null),
        attachment_key: attachmentKey,
        attachment_digest: digest ? new Uint8Array(base64ToArrayBuffer(digest)) : null,
        cdn_number: null,
        cdn_key: null,
        local_path: null,
        thumbnail_path: null,
        blur_hash: meta.blurHash ?? null,
        expires_at: meta.expiresAt ? new Date(meta.expiresAt).getTime() : null,
        download_state: 'pending',
        upload_state: 'done',
        created_at: meta.uploadedAt
          ? new Date(meta.uploadedAt).getTime()
          : Date.now(),
        thumbnail_media_id: thumbnailMediaId,
        is_thumbnail: 0,
      };

      if (dbReady) {
        try {
          saveMedia(row);
        } catch (e) {
          if (__DEV__) {
            console.warn('[processMediaMetadata] saveMedia failed:', e instanceof Error ? e.message : e);
          }
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
        duration: durationMs ?? (meta.duration ?? null),
        blurHash: meta.blurHash ?? null,
        localPath: null,
        thumbnailPath: null,
        downloadState: 'pending',
        uploadState: 'done',
        expiresAt: meta.expiresAt ? new Date(meta.expiresAt).getTime() : null,
        hasKeys: attachmentKey != null,
        thumbnailMediaId,
        isThumbnail: false,
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

  // Mark as processed to prevent redundant work from other call sites
  for (const item of items) {
    processedMediaIds.add(item.id);
  }

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
    lastReplyAt: item.lastReplyAt ? Date.parse(item.lastReplyAt) : null,
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

  // Write-through: persist decrypted threads to SQLCipher
  if (isDatabaseInitialized()) {
    try {
      saveThreadBatch(groupId, threads);
    } catch (e) {
      if (__DEV__) console.warn('[loadThreadsForGroup] DB write failed:', e instanceof Error ? e.message : e);
    }
  }

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

  // Write-through: persist decrypted thread to SQLCipher
  if (isDatabaseInitialized()) {
    try {
      dbSaveThread(thread);
    } catch (e) {
      if (__DEV__) console.warn('[loadThread] DB write failed:', e instanceof Error ? e.message : e);
    }
  }

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

  // Write-through: persist decrypted replies to SQLCipher
  if (isDatabaseInitialized()) {
    try {
      saveReplyBatch(threadId, replies);
    } catch (e) {
      if (__DEV__) console.warn('[loadReplies] DB write failed:', e instanceof Error ? e.message : e);
    }
  }

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

    // Write-through: persist confirmed reply to SQLCipher
    if (isDatabaseInitialized()) {
      try {
        dbSaveReply(confirmedReply);
      } catch (e) {
        if (__DEV__) console.warn('[postReply] DB write failed:', e instanceof Error ? e.message : e);
      }
    }

    // Replace the optimistic reply (client ID) with the server-confirmed reply
    // so subsequent replies-to-this-reply use the real server ID.
    store.removeReply(clientId);
    store.upsertReply(confirmedReply);

    // Bump the parent thread so list rows stay live without a refetch (#329).
    // Mirrors the WS new_reply handler; without this the posting device's
    // thread list shows a stale reply count until the next server load.
    const parentThread = getStoreActions().threads[threadId];
    if (parentThread) {
      getStoreActions().upsertThread({
        ...parentThread,
        replyCount: parentThread.replyCount + 1,
        lastReplyAt: Math.max(parentThread.lastReplyAt ?? 0, confirmedReply.createdAt),
      });
    }
    // Own reply must not flag the author's own thread as unread
    getStoreActions().markThreadViewed(threadId);

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

    // Write-through: persist confirmed thread to SQLCipher
    if (isDatabaseInitialized()) {
      try {
        dbSaveThread(finalThread);
      } catch (e) {
        if (__DEV__) console.warn('[createNewThread] DB write failed:', e instanceof Error ? e.message : e);
      }
    }

    store.removeThread(clientId);
    store.upsertThread(finalThread);
    // A thread you just created is not unread for you
    store.markThreadViewed(finalThread.id);

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

// ---------------------------------------------------------------------------
// Local hydration — instant screen loads from SQLCipher cache
// ---------------------------------------------------------------------------

/**
 * Hydrate the store with threads from the local database.
 * Called synchronously before async API fetch for instant UI.
 */
export function hydrateThreadsFromLocal(conversationId: string): void {
  if (!isDatabaseInitialized()) return;
  try {
    const threads = getThreadsForConversation(conversationId);
    if (threads.length > 0) {
      const store = useAppStore.getState();
      store.setThreads(conversationId, threads);
    }
  } catch (e) {
    if (__DEV__) console.warn('[hydrateThreadsFromLocal] failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * Hydrate the store with replies from the local database.
 * Called synchronously before async API fetch for instant UI.
 */
export function hydrateRepliesFromLocal(threadId: string): void {
  if (!isDatabaseInitialized()) return;
  try {
    const replies = getRepliesForThread(threadId);
    if (replies.length > 0) {
      const store = useAppStore.getState();
      store.setReplies(threadId, replies);
    }
  } catch (e) {
    if (__DEV__) console.warn('[hydrateRepliesFromLocal] failed:', e instanceof Error ? e.message : e);
  }
}
