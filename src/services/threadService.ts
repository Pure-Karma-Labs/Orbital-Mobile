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
import { openImportMetaWithKey } from './crypto/importCrypto';
import { useAppStore } from '../stores/useAppStore';
import { generateUUID } from '../utils/uuid';
import { isValidTimestamp, maxTimestamp } from '../utils/threadActivity';
import { base64ToArrayBuffer } from './crypto/utils';
import { getMedia, saveMedia, getThreadLevelMedia, getMediaForReply, getMediaForThreadReplies, updateMediaParent } from '../database/repositories/mediaRepository';
import { saveThread as dbSaveThread, saveThreadBatch, getRecentThreadsForConversation, getThreadsByIds, getThread as dbGetThread } from '../database/repositories/threadRepository';
import { saveReply as dbSaveReply, saveReplyBatch, getRepliesForThread, deleteReply as dbDeleteReply } from '../database/repositories/replyRepository';
import { mediaRowToItem } from '../database/repositories/mediaMapper';
import { isDatabaseInitialized } from '../database/connection';
import { isBlockedAuthor } from './media/exportAccess';
import { ApiError, BlockedRecipientError, ValidationError } from './api/errors';
import {
  applyWalkPage,
  beginWalkPage,
  discardWalkPage,
  failWalkPage,
  getWalkInflight,
  hasWalkedTail,
  leaveWalk,
  noteInvalidCursor,
  openWalk,
  refreshWalk,
  reopenWalk,
  setWalkInflight,
  walkHasMore,
} from './threadListWalk';
import { deriveBlockedDmPeer } from '../utils/dmPeer';
import { resolveMediaPath } from './media/mediaPaths';
import { teardownLocalMedia } from './media/mediaTeardown';
import type { ImportSource } from './metaImport/types';
import type { LoadMoreResult } from './threadListWalk';
import type { Thread, Reply, MediaItem } from '../types/store';
import type { MediaRow } from '../database/repositories/mediaRepository';
import type { ThreadResponse, ThreadListItem, ReplyResponse, MediaMetadata, GetGroupThreadsRequest } from '../types/api';

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
 * Read one thread from SQLCipher without ever rejecting or throwing (#883).
 *
 * The recency merges need the row that is already on disk when the store is
 * empty — a cold open from a push notification, or a WS reply that arrives
 * before any list load. Both callers run inside success paths that must not be
 * turned into failures by a closed or Fast-Refresh-reset database, so every
 * outcome collapses to `null`.
 */
function safeDbGetThread(threadId: string): Thread | null {
  if (!isDatabaseInitialized()) return null;
  try {
    return dbGetThread(threadId);
  } catch (e) {
    if (__DEV__) console.warn('[safeDbGetThread] DB read failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * The same guarded read, for a SET of ids (#923).
 *
 * One query per list page instead of one per row that is not already in the
 * store: a 100-row walk page in a cold-started orbit used to mean 100
 * `safeDbGetThread` calls, each its own statement, inside the page's recency
 * reconcile. Same failure contract — every outcome collapses to "no rows".
 */
function safeDbGetThreadsByIds(ids: readonly string[]): Map<string, Thread> {
  if (ids.length === 0 || !isDatabaseInitialized()) return new Map();
  try {
    return new Map(getThreadsByIds(ids).map((t) => [t.id, t]));
  } catch (e) {
    if (__DEV__) console.warn('[safeDbGetThreadsByIds] DB read failed:', e instanceof Error ? e.message : e);
    return new Map();
  }
}

/**
 * The author of a thread as far as THIS DEVICE knows: store first, then the
 * guarded SQLite read, else `null` (#897).
 *
 * Exists for the WebSocket `new_reply` guard, which has to drop a reply posted
 * on a BLOCKED author's thread — the broadcast carries only the reply's own
 * author, and the server does not block-filter WS fan-out, so `messageHandler`
 * is the enforcement point. `null` means "unknown here", and the caller fails
 * open on it: the alternative would drop legitimate replies on any thread this
 * device has not loaded yet.
 */
export function getKnownThreadAuthorId(threadId: string): string | null {
  const known = getStoreActions().threads[threadId] ?? safeDbGetThread(threadId);
  return known?.authorId ?? null;
}

/**
 * Apply a new reply to its parent thread and the owning conversation (#883).
 *
 * The single implementation behind BOTH reply paths — `postReply`'s own
 * confirmed send and the WebSocket `new_reply` handler. They used to carry
 * cloned copies of these steps, which is how `lastReplyAt` ended up maxed at
 * some call sites and overwritten at others.
 *
 * Steps, in order:
 * 1. resolve the parent from the store, falling back to the guarded DB read;
 * 2. upsert it with `replyCount + 1` and `lastReplyAt` via `maxTimestamp`;
 * 3. persist the parent, so the bump survives a cold start;
 * 4. bump the conversation's `lastMessageAt`, which is what lifts the row to
 *    the top of Chats / the orbit selector.
 *
 * An unparseable `replyCreatedAt` (NaN from a malformed payload) is a complete
 * no-op: writing it would poison both stored recency fields, and the reply row
 * itself has already been handled by the caller.
 *
 * The conversation bump runs even when the parent thread is nowhere to be
 * found — the reply is still real activity in that conversation, and this
 * matches the pre-#883 behaviour of both call sites.
 */
export function applyReplyToParentThread(
  groupId: string,
  threadId: string,
  replyCreatedAt: number,
): void {
  const replyAt = maxTimestamp(replyCreatedAt, null);
  if (replyAt === null) {
    if (__DEV__) console.warn('[applyReplyToParentThread] ignored unparseable reply timestamp');
    return;
  }

  const parent = getStoreActions().threads[threadId] ?? safeDbGetThread(threadId);
  if (parent) {
    const updated: Thread = {
      ...parent,
      replyCount: parent.replyCount + 1,
      lastReplyAt: maxTimestamp(parent.lastReplyAt, replyAt),
    };
    getStoreActions().upsertThread(updated);
    if (isDatabaseInitialized()) {
      try {
        dbSaveThread(updated);
      } catch (e) {
        if (__DEV__) console.warn('[applyReplyToParentThread] DB write failed:', e instanceof Error ? e.message : e);
      }
    }
  }

  getStoreActions().bumpLastMessageAt(groupId, replyAt);
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
        store.mergeMediaForThread(parentRef.threadId, existingItems);
      } else {
        store.mergeMediaForReply(parentRef.replyId, existingItems);
        // Backfill reply_id on DB rows that were first created with thread-only context.
        // loadThread processes ALL thread media (including reply-attached) with {threadId},
        // so saveMedia writes reply_id=NULL. When loadReplies later processes the same IDs
        // with {replyId}, the dedup path fires and the DB association is never persisted
        // unless we backfill here.
        if (dbReady) {
          for (const item of existingItems) {
            if (item.replyId == null) {
              try {
                updateMediaParent(item.id, item.threadId ?? '', parentRef.replyId);
              } catch {
                // Best-effort backfill
              }
            }
          }
        }
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
        // Backfill reply_id if this call provides a more specific context
        if ('replyId' in parentRef && storeItem.replyId == null && dbReady) {
          try {
            updateMediaParent(storeItem.id, storeItem.threadId ?? '', parentRef.replyId);
          } catch {
            // Best-effort backfill
          }
        }
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
          const resolvedPath = resolveMediaPath(existingRow.local_path);
          const fileExists = resolvedPath ? await exists(resolvedPath).catch(() => false) : false;
          if (!fileExists) {
            existingRow = { ...existingRow, download_state: 'pending', local_path: null, archive_confirmed: 0 };
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
        // Backfill reply_id if this call provides a more specific context
        if ('replyId' in parentRef && existingRow.reply_id == null && dbReady) {
          try {
            updateMediaParent(existingRow.id, existingRow.thread_id ?? '', parentRef.replyId);
            existingRow = { ...existingRow, reply_id: parentRef.replyId };
          } catch {
            // Best-effort backfill
          }
        }
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
    store.mergeMediaForThread(parentRef.threadId, items);
  } else {
    store.mergeMediaForReply(parentRef.replyId, items);
  }

  // Trigger lazy prefetch drain — covers all 7 call sites (D7)
  import('./mediaPrefetchService').then(({ schedulePendingMediaDrain }) =>
    schedulePendingMediaDrain(),
  ).catch(() => {});
}

/**
 * ISO string -> epoch ms, or null (#883).
 *
 * Routed through `maxTimestamp` so an absent, null, empty or unparseable server
 * value (Date.parse -> NaN) all collapse to the one representation the store
 * and SQLite accept for "no recency known". NaN must never reach `lastReplyAt`:
 * it defeats every later comparison and would freeze the row's sort position.
 */
function parseServerTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  return maxTimestamp(Date.parse(value), null);
}

/**
 * Decide the `lastReplyAt` (and sometimes the `replyCount`) a list/detail
 * response may write, given what the store knew before the request (#897).
 *
 * Since Backend #306 `last_reply_at` and `reply_count` are PER-VIEWER and
 * block-filtered, so a server value may legitimately be LOWER than the one on
 * this device: blocking the member whose reply lifted the thread stops that
 * reply from counting. The never-lower merge (#883) pinned the thread at that
 * slot forever while its count dropped. But the merge still has a job — a WS
 * reply or an own post can land WHILE this request is in flight, and that
 * value is newer than anything the response can carry.
 *
 * This is the only place that can tell those two apart, because it is the only
 * place holding both a PRE-request snapshot and the live store row:
 *
 *  - `serverSent === false` (a 1.7.6-era backend omits the field entirely) ⇒
 *    legacy never-lower against whatever is known locally;
 *  - `blockedSetChanged` ⇒ a block/unblock landed while this request was in
 *    flight, so the response may predate it and must NOT be written as the
 *    authoritative per-viewer answer (#906 review). The LIVE row wins
 *    outright, count included. Demoting to the max-merge instead would
 *    re-latch exactly the stale high value this whole mechanism exists to
 *    lower. With no live row there is nothing to keep, so the legacy
 *    never-lower path applies and the following refresh corrects it;
 *  - the live row's recency moved past the snapshot (or the row appeared
 *    mid-request) ⇒ a reply landed; keep the LIVE `lastReplyAt` **and** the
 *    higher of the two `replyCount`s, which `applyReplyToParentThread` bumped
 *    together — taking one without the other is what made the pair disagree
 *    in the first place, and the server may already count more replies than
 *    the single local bump;
 *  - otherwise the server value is authoritative and may lower, or be `null`.
 *
 * `before` is a plain reference to the `threads` map and is a sound snapshot
 * only because every writer replaces that map immutably (`setThreads`,
 * `upsertThread`, `removeThread` all build a new object), so an in-flight
 * mutation can never be observed through it.
 *
 * Only a STORE row can carry a mid-request bump — `applyReplyToParentThread`
 * upserts the store before it persists — so a DB-only `fallback` row is never
 * treated as bumped. Everything returned still passes through `maxTimestamp`:
 * it stays the only producer of a stored recency value.
 */
function reconcileServerRecency({
  serverSent,
  serverValue,
  serverReplyCount,
  before,
  live,
  fallback,
  blockedSetChanged,
}: {
  serverSent: boolean;
  serverValue: number | null;
  serverReplyCount: number;
  before: Thread | undefined;
  live: Thread | undefined;
  fallback: Thread | null;
  blockedSetChanged: boolean;
}): { lastReplyAt: number | null; replyCount?: number } {
  const existing = live ?? fallback ?? undefined;

  if (!serverSent) {
    return { lastReplyAt: maxTimestamp(existing?.lastReplyAt, serverValue) };
  }

  const liveAt = live?.lastReplyAt;

  if (blockedSetChanged) {
    if (live !== undefined) {
      return { lastReplyAt: maxTimestamp(liveAt, null), replyCount: live.replyCount };
    }
    return { lastReplyAt: maxTimestamp(existing?.lastReplyAt, serverValue) };
  }

  const bumpedMidRequest =
    live !== undefined &&
    isValidTimestamp(liveAt) &&
    (before === undefined ||
      !isValidTimestamp(before.lastReplyAt) ||
      liveAt > before.lastReplyAt);

  if (bumpedMidRequest) {
    return {
      lastReplyAt: maxTimestamp(liveAt, null),
      replyCount: Math.max(live.replyCount, serverReplyCount),
    };
  }

  return { lastReplyAt: maxTimestamp(serverValue, null) };
}

/**
 * Apply a {@link reconcileServerRecency} result to a mapped thread, keeping the
 * identity of `thread` when nothing changed (so the store's reference-equality
 * checks still see an unchanged row).
 */
function applyReconciledRecency(
  thread: Thread,
  resolved: { lastReplyAt: number | null; replyCount?: number },
): Thread {
  if (resolved.lastReplyAt === thread.lastReplyAt && resolved.replyCount === undefined) {
    return thread;
  }
  return {
    ...thread,
    lastReplyAt: resolved.lastReplyAt,
    ...(resolved.replyCount !== undefined ? { replyCount: resolved.replyCount } : {}),
  };
}

/**
 * What happened to a row's sealed import-meta envelope (#927).
 *
 * `'none'` is "this row is not an import at all" — including a row the server
 * flagged in a conversation that is not a known orbit.
 */
type ImportEnvelopeOutcome = 'none' | 'opened' | 'absent' | 'invalid' | 'auth-failed';

interface ImportDisplay {
  isImport: boolean;
  importSource: ImportSource | null;
  envelope: ImportEnvelopeOutcome;
}

const NOT_AN_IMPORT: ImportDisplay = { isImport: false, importSource: null, envelope: 'none' };

/**
 * What the store knows about the conversation a fetched row belongs to (#927).
 *
 * Three cases, not two. `'unknown'` is the one that is easy to get wrong: a
 * cold open straight into thread detail — a push notification or a deep link —
 * reaches `loadThread` before the conversation list has loaded, so the store
 * holds no row and the orbit CANNOT be confirmed. That is not the same fact as
 * "this is not an orbit", and treating it as one would write `isImport: false`
 * over a correctly flagged cached row (`loadThread` write-throughs to both the
 * store and SQLite).
 */
type ConversationGate = 'orbit' | 'not-orbit' | 'unknown';

function conversationGate(groupId: string): ConversationGate {
  const conversation = getStoreActions().conversations[groupId];
  if (conversation === undefined) return 'unknown';
  return conversation.type === 'group' ? 'orbit' : 'not-orbit';
}

/**
 * The import display fields already known for a thread, from the store if it
 * is there and from SQLite otherwise (#927).
 *
 * Only read on the `'unknown'` gate, so the DB hit happens on the cold-open
 * path alone. `safeDbGetThread` never throws.
 *
 * SCOPED TO THE CONVERSATION being mapped: a cached row filed under a
 * different conversation is not evidence about this one. The cached flag
 * passed the orbit gate for the conversation it was written under, so
 * carrying it onto a row the server now serves under another `groupId` (a DM,
 * say) would flag a row that never passed any gate. A legitimate cold open
 * always matches.
 */
function cachedImportDisplay(
  threadId: string,
  groupId: string,
): Pick<Thread, 'isImport' | 'importSource'> | null {
  const cached = getStoreActions().threads[threadId] ?? safeDbGetThread(threadId);
  return cached != null && cached.conversationId === groupId ? cached : null;
}

/**
 * Decide the import DISPLAY fields for one fetched row (#927).
 *
 * TOTAL and synchronous: every outcome, including a tampered envelope, is a
 * return value. The list maps its rows inside a `Promise.all`, so a throw here
 * would reject the whole page and one bad envelope would blank an orbit.
 *
 * Trust boundary, per the Backend #317 hand-off: `isImport` is a server-supplied
 * plaintext flag and is accepted as such — but only for a conversation the store
 * already knows is a group. That gate is what stops a stray flag on a DM row
 * from suppressing that DM's unread dot (`getThreadState` keys read state on
 * `isImport`).
 *
 * On the `'unknown'` gate the payload's flag is WITHHELD and `cached` — what a
 * previous load already wrote for this thread — is carried forward unchanged.
 * Withholding is not the same as denying: writing `false` there would downgrade
 * a correct cached row on every cold open into an orbit whose conversation row
 * has not loaded yet. The trust boundary is unaffected, because anything in
 * `cached` passed through this same gate when it was written; the one thing
 * that cannot happen is a NEW flag arriving unverified.
 *
 * The envelope supplies the source label and NOTHING else. Its AAD binds the
 * orbit, not the thread, so a hostile server can move one imported thread's
 * envelope onto another in the same orbit; `meta.originalCreatedAt` is never
 * read, and the displayed date comes from the served `createdAt`.
 */
function resolveImportDisplay(
  row: Pick<ThreadListItem, 'isImport' | 'encryptedImportMeta' | 'importMetaIv'>,
  groupKey: Uint8Array,
  groupId: string,
  gate: ConversationGate,
  cached: Pick<Thread, 'isImport' | 'importSource'> | null,
): ImportDisplay {
  if (gate === 'unknown') {
    // Carry forward, never write. The envelope is not opened: its outcome is
    // only ever a tamper COUNT, and this row's flag is not being decided here.
    return cached?.isImport === true
      ? { isImport: true, importSource: cached.importSource ?? null, envelope: 'none' }
      : NOT_AN_IMPORT;
  }

  if (row.isImport !== true || gate !== 'orbit') return NOT_AN_IMPORT;

  const sealed = row.encryptedImportMeta;
  const iv = row.importMetaIv;
  // An absent envelope is not a tamper signal: the server serves all four keys
  // unconditionally, so `null` here is simply "nothing sealed for this row".
  // Empty strings are folded in with null rather than being sent through the
  // open path, which would report them as an authentication failure.
  if (typeof sealed !== 'string' || sealed.length === 0 || typeof iv !== 'string' || iv.length === 0) {
    return { isImport: true, importSource: null, envelope: 'absent' };
  }

  let meta;
  try {
    meta = openImportMetaWithKey(sealed, iv, groupKey, groupId);
  } catch {
    // Bare catch, no bound error and no logging: the only values in scope are
    // ciphertext and a crypto failure reason, and neither may be carried
    // anywhere. The caller counts these, nothing more.
    return { isImport: true, importSource: null, envelope: 'auth-failed' };
  }

  if (meta === null) return { isImport: true, importSource: null, envelope: 'invalid' };
  return { isImport: true, importSource: meta.source, envelope: 'opened' };
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

  const detailGate = conversationGate(response.groupId);
  const importDisplay = resolveImportDisplay(
    response,
    groupKey,
    response.groupId,
    detailGate,
    detailGate === 'unknown' ? cachedImportDisplay(response.threadId, response.groupId) : null,
  );

  return {
    id: response.threadId,
    conversationId: response.groupId,
    authorId: response.authorId,
    authorUsername: response.authorUsername,
    title,
    body,
    contentType: response.media && response.media.length > 0 ? 'media' : 'text',
    pinned: false,
    replyCount: response.replyCount,
    // #883: the detail response carries last_reply_at. It used to be hardcoded
    // null here, so opening a post wiped the recency that put it on top.
    lastReplyAt: parseServerTimestamp(response.lastReplyAt),
    // The SERVED value, never the envelope's date (#927).
    createdAt: new Date(response.createdAt).getTime(),
    updatedAt: new Date(response.createdAt).getTime(),
    syncStatus: 'synced',
    isImport: importDisplay.isImport,
    importSource: importDisplay.importSource,
    // The detail payload carries the array the list counts, under the same
    // server predicate — so this is the list's `media_count`, computed here.
    mediaCount: response.media?.length ?? 0,
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

/**
 * Returns the envelope outcome alongside the row so `loadThreadsForGroup` can
 * report ONE count per load (#927) instead of a line per row.
 */
async function mapThreadListItem(
  item: ThreadListItem,
  groupKey: Uint8Array,
  gate: ConversationGate,
): Promise<{ thread: Thread; envelope: ImportEnvelopeOutcome }> {
  const { title, body } = await decryptThreadFields(
    item.encryptedTitle,
    item.titleIv,
    item.encryptedBody,
    item.bodyIv,
    groupKey,
    item.groupId,
  );

  const importDisplay = resolveImportDisplay(
    item,
    groupKey,
    item.groupId,
    gate,
    gate === 'unknown' ? cachedImportDisplay(item.threadId, item.groupId) : null,
  );

  return {
    thread: {
      id: item.threadId,
      conversationId: item.groupId,
      authorId: item.authorId,
      authorUsername: item.authorUsername,
      title,
      body,
      contentType: item.mediaCount > 0 ? 'media' : 'text',
      pinned: false,
      replyCount: item.replyCount,
      // An unparseable value must land as null, not NaN (#883).
      lastReplyAt: parseServerTimestamp(item.lastReplyAt),
      // The SERVED value, never the envelope's date (#927).
      createdAt: new Date(item.createdAt).getTime(),
      updatedAt: new Date(item.createdAt).getTime(),
      syncStatus: 'synced',
      isImport: importDisplay.isImport,
      importSource: importDisplay.importSource,
      mediaCount: item.mediaCount,
    },
    envelope: importDisplay.envelope,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Rows one walk page asks for. The server's maximum; its default is 50. */
const WALK_PAGE_LIMIT = 100;

/** Rows `hydrateThreadsFromLocal` paints before the network answers (#923). */
const HYDRATE_THREAD_LIMIT = 200;

/** What one applied list page produced. */
interface ThreadPageResult {
  /** The reconciled rows, as written to the store. */
  threads: Thread[];
  /** RAW server ids on the page — including rows that failed to decrypt. */
  rawIds: string[];
  hasMore: boolean;
  nextCursor?: string;
  totalCount: number;
  /** Ids this page ADDED to the conversation's list. */
  newIdCount: number;
  /** True when nothing was applied because the page went stale (#906). */
  discarded: boolean;
}

/**
 * Fetch ONE page of a conversation's thread list, decrypt it, reconcile it and
 * write it — the single pipeline behind both the head refresh and the cursor
 * walk (#923).
 *
 * The steps are the pre-#923 `loadThreadsForGroup` body in the same order,
 * because that order IS the contract:
 *
 *  1. snapshot `threads` and `blockedUsersGeneration` BEFORE the request —
 *     `reconcileServerRecency` can then tell a per-viewer server lowering
 *     (#897) apart from a reply that landed mid-request (#883), and a block
 *     that landed mid-request invalidates the whole response (#906);
 *  2. request, then VALIDATE the shape before anything is applied;
 *  3. group key, `serverSentById` off the RAW payload, ONE `conversationGate`
 *     for the page (#927), map;
 *  4. reconcile, persist, store write with `authoritativeRecency: true`.
 *
 * Every invariant is per PAGE, never per walk: each load-more takes its own
 * fresh snapshot, so a reply or a block that lands between two pages is
 * handled exactly as one that lands during a refresh.
 *
 * @param apply `'replace'` is an open (`setThreads`); `'merge'` is a refresh
 *   or a walk step (`mergeThreads`, additive).
 */
async function fetchAndApplyThreadPage(
  groupId: string,
  params: GetGroupThreadsRequest,
  apply: 'replace' | 'merge',
  options?: { retryOn429?: boolean; discardOnBlockedChange?: boolean },
): Promise<ThreadPageResult> {
  // Captured BEFORE the request so `reconcileServerRecency` can tell a
  // per-viewer server lowering (#897) apart from a reply that landed while the
  // request was in flight. Sound as a snapshot because every thread writer
  // replaces the map immutably.
  const threadsBefore = getStoreActions().threads;
  // Captured with the snapshot (#906 review): a block that lands while this
  // request is in flight makes the response's per-viewer values stale.
  const blockedGenerationBefore = getStoreActions().blockedUsersGeneration;

  const response = await getGroupThreads(
    groupId,
    params,
    options?.retryOn429 === false ? { retryOn429: false } : undefined,
  );

  // A malformed 200 must NOT read as "this orbit is empty" or "the list ends
  // here": the first would blank a list on a replace, the second would end a
  // walk short of the imports it exists to reach. Throwing puts it on the
  // caller's failure path, where no page is applied. Same guard, same reason
  // as `loadReplies` (#821).
  if (!Array.isArray(response.threads) || typeof response.hasMore !== 'boolean') {
    throw new Error('[threadService] malformed thread list response');
  }
  const totalCount =
    typeof response.totalCount === 'number' && Number.isFinite(response.totalCount)
      ? response.totalCount
      : response.threads.length;

  const groupKey = await getOrFetchGroupKey(groupId);

  // Did the server SEND `last_reply_at` for this row, or omit it (1.7.6-era
  // backend)? Read off the RAW payload and keyed by id, never positionally: a
  // mapped row whose id is missing here degrades to the never-lower path.
  const serverSentById = new Map(
    response.threads.map((item) => [item.threadId, item.lastReplyAt !== undefined]),
  );
  // RAW ids, read once: a row that fails to decrypt is still a row the server
  // served, and the walk's keep-set must not mistake it for a removal.
  const rawIds = [...serverSentById.keys()];

  // Resolved ONCE for the page: every row carries the same groupId, and the
  // gate is a property of the conversation, not of the row (#927).
  const gate = conversationGate(groupId);
  const mappedRows = await Promise.all(
    response.threads.map((item) => mapThreadListItem(item, groupKey, gate)),
  );
  const mapped = mappedRows.map((row) => row.thread);

  // Tamper signal, COUNT ONLY and dev only — no ids, no ciphertext, no values,
  // mirroring the DB-write-failed warn below. Production stays silent on
  // purpose: a group-key rotation makes every envelope in the orbit fail at
  // once, and that must not become a telemetry storm.
  const authFailedCount = mappedRows.filter((row) => row.envelope === 'auth-failed').length;
  if (__DEV__ && authFailedCount > 0) {
    console.warn(
      `[fetchAndApplyThreadPage] import metadata failed to authenticate on ${authFailedCount} row(s)`,
    );
  }

  // Reconcile before persisting: `saveThreadBatch` is INSERT OR REPLACE, so a
  // reply applied while this request was in flight would otherwise reach the
  // store but be overwritten on disk by the pre-reply value, and the thread
  // would sort low again after a cold start. The other direction (#897) is a
  // block that legitimately LOWERS the server's per-viewer value, which the
  // old unconditional max-merge could never let through.
  const storeAfter = getStoreActions();
  const threadsAfter = storeAfter.threads;
  const blockedSetChanged = storeAfter.blockedUsersGeneration !== blockedGenerationBefore;

  // A WALK page straddling a block is thrown away whole rather than merged:
  // the server filtered it for the pre-block viewer, so it may carry rows that
  // are now blocked, and appending them would need a second pass to remove.
  // The head refresh does NOT take this branch — it still applies, with the
  // recency guard below, exactly as it did before #923.
  if (options?.discardOnBlockedChange === true && blockedSetChanged) {
    return {
      threads: [],
      rawIds,
      hasMore: response.hasMore,
      nextCursor: response.nextCursor,
      totalCount,
      newIdCount: 0,
      discarded: true,
    };
  }

  // ONE batched read for every row the store does not already hold, instead of
  // a statement per row inside the loop (#923).
  const fallbackById = safeDbGetThreadsByIds(
    mapped.filter((t) => threadsAfter[t.id] === undefined).map((t) => t.id),
  );

  const threads = mapped.map((t) => {
    const live = threadsAfter[t.id];
    return applyReconciledRecency(
      t,
      reconcileServerRecency({
        serverSent: serverSentById.get(t.id) === true,
        serverValue: t.lastReplyAt,
        serverReplyCount: t.replyCount,
        before: threadsBefore[t.id],
        live,
        fallback: live ? null : (fallbackById.get(t.id) ?? null),
        blockedSetChanged,
      }),
    );
  });

  // Write-through: persist decrypted threads to SQLCipher
  if (isDatabaseInitialized()) {
    try {
      saveThreadBatch(groupId, threads);
    } catch (e) {
      if (__DEV__) console.warn('[fetchAndApplyThreadPage] DB write failed:', e instanceof Error ? e.message : e);
    }
  }

  const store = getStoreActions();
  // The recency decision was made above, against the pre-request snapshot, so
  // the slice must not re-apply its never-lower merge on top of it (#897).
  const newIdCount =
    apply === 'merge'
      ? store.mergeThreads(groupId, threads, { authoritativeRecency: true })
      : (store.setThreads(groupId, threads, { authoritativeRecency: true }), threads.length);

  return {
    threads,
    rawIds,
    hasMore: response.hasMore,
    nextCursor: response.nextCursor,
    totalCount,
    newIdCount,
    discarded: false,
  };
}

/**
 * Fetch the HEAD page of a group's thread list, decrypt, and populate the
 * store.
 *
 * Requests `activity_desc` (#883): both screens order by latest activity, so
 * the server's 50-row page has to be the 50 most ACTIVE threads. With the old
 * `created_desc` default, a reply on message #51 of a DM bumped the Chats row
 * but the thread itself dropped out of the page on the next load — it showed
 * at the top from SQLite hydration and then vanished when this list landed.
 * An older backend ignores the value and returns `created_desc`. The request
 * is exactly `{ sort: 'activity_desc' }`, as it was before #923.
 *
 * `options.tail` says what happens to rows a cursor walk has paged in (#923):
 *
 * - `'keep'` (the default when a walk has a tail) MERGES the head page, so a
 *   pull-to-refresh, a key heal, a block or another member's import does not
 *   throw away the member's scroll position.
 * - `'drop'` is a REOPEN: the tail and the cursor go together and the list
 *   returns to its head, exactly like a first open. Used when rows may have
 *   appeared anywhere in the list rather than only at the head — an unblock,
 *   and this device's own import settling.
 *
 * With no walked tail there is nothing to keep, so both spellings replace, and
 * the existing single-argument callers behave precisely as they did.
 */
export async function loadThreadsForGroup(
  groupId: string,
  options?: { tail?: 'keep' | 'drop' },
): Promise<Thread[]> {
  const keepTail = options?.tail !== 'drop' && hasWalkedTail(groupId);

  if (!keepTail) {
    // Reopen BEFORE the request: the walked tail is dropped from the walk and
    // from the store together, so the list is already at its head while the
    // head page is in flight — and stays there if the request fails.
    const keepIds = reopenWalk(groupId);
    if (keepIds !== null) getStoreActions().trimThreadsToHead(groupId, keepIds);
  }

  const page = await fetchAndApplyThreadPage(
    groupId,
    { sort: 'activity_desc' },
    keepTail ? 'merge' : 'replace',
  );

  if (keepTail) {
    refreshWalk(groupId, { ids: page.rawIds, totalCount: page.totalCount });
  } else {
    openWalk(groupId, {
      ids: page.rawIds,
      hasMore: page.hasMore,
      // The head cursor is a CAPABILITY probe, never a position: it is bound
      // to `activity_desc` and the walk runs on `created_desc`. A server that
      // reports more rows without one cannot be walked.
      hasCursor: typeof page.nextCursor === 'string' && page.nextCursor.length > 0,
      totalCount: page.totalCount,
    });
  }

  return page.threads;
}

/**
 * Walk one page further back in a conversation's list (#923).
 *
 * `created_desc`, 100 rows, `before` once the walk has a cursor. The first
 * page of a walk is deliberately cursorless — see `threadListWalk`.
 *
 * Single-flight per conversation: `onEndReached` fires repeatedly while the
 * list is near its end, and two pages in flight against one cursor would
 * request the same rows twice.
 *
 * Results, in the caller's terms:
 * - `loaded` — a page was applied. `newIdCount` can still be 0 (the walk's
 *   first page overlaps the head by construction); `hasMore` says whether to
 *   offer another.
 * - `exhausted` / `unsupported` — nothing was requested, and nothing will be.
 * - `reopened` — the server rejected the cursor; the list is back at its head.
 * - `rate-limited` — a 429. Nothing was applied, the cursor is intact, and
 *   NOTHING is chained: the member taps to retry.
 * - `skipped` — no walk for this conversation (the list was never opened), a
 *   page is already in flight, or the page went stale (#906).
 *
 * Any other failure rejects, with `loadMoreFailed` already set for the footer.
 */
export function loadMoreThreadsForGroup(groupId: string): Promise<LoadMoreResult> {
  const existing = getWalkInflight(groupId);
  if (existing !== null) return existing;

  const claim = beginWalkPage(groupId);
  if (!claim.ok) {
    return Promise.resolve({
      status: claim.status,
      newIdCount: 0,
      hasMore: walkHasMore(groupId),
    });
  }

  const run = runWalkPage(groupId, claim.cursor).finally(() => {
    setWalkInflight(groupId, null);
  });
  setWalkInflight(groupId, run);
  return run;
}

async function runWalkPage(groupId: string, cursor: string | null): Promise<LoadMoreResult> {
  const params: GetGroupThreadsRequest =
    cursor === null
      ? { sort: 'created_desc', limit: WALK_PAGE_LIMIT }
      : { sort: 'created_desc', limit: WALK_PAGE_LIMIT, before: cursor };

  let page: ThreadPageResult;
  try {
    page = await fetchAndApplyThreadPage(groupId, params, 'merge', {
      retryOn429: false,
      discardOnBlockedChange: true,
    });
  } catch (e) {
    if (e instanceof ValidationError && e.reason === 'INVALID_CURSOR') {
      if (noteInvalidCursor(groupId) === 'stop') {
        return { status: 'unsupported', newIdCount: 0, hasMore: false };
      }
      const keepIds = reopenWalk(groupId);
      if (keepIds !== null) getStoreActions().trimThreadsToHead(groupId, keepIds);
      return { status: 'reopened', newIdCount: 0, hasMore: walkHasMore(groupId) };
    }
    if (e instanceof ApiError && e.statusCode === 429) {
      failWalkPage(groupId, 'rate-limited');
      return { status: 'rate-limited', newIdCount: 0, hasMore: true };
    }
    failWalkPage(groupId, 'error');
    throw e;
  }

  if (page.discarded) {
    discardWalkPage(groupId);
    return { status: 'skipped', newIdCount: 0, hasMore: walkHasMore(groupId) };
  }

  applyWalkPage(groupId, {
    ids: page.rawIds,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    totalCount: page.totalCount,
  });

  return {
    status: 'loaded',
    newIdCount: page.newIdCount,
    hasMore: walkHasMore(groupId),
  };
}

/**
 * A list screen stopped showing this conversation (#923).
 *
 * Drops its walk and trims the walked tail out of the store, so at most one
 * orbit's and one DM's tail is ever resident. SQLite is untouched: the rows
 * come back from the local hydrate and from the next walk.
 */
export function leaveThreadList(groupId: string): void {
  const keepIds = leaveWalk(groupId);
  if (keepIds === null) return;
  getStoreActions().trimThreadsToHead(groupId, keepIds);
}

/**
 * Make sure the store holds an ENTITY for each of these thread ids, reading
 * the missing ones from SQLite (#923).
 *
 * For search: FTS reaches every cached row, but a trimmed tail row no longer
 * has an entity in the store, so its result would render blank. Entities only
 * — `cacheThreadEntities` never re-lists a thread, which would resurrect a
 * trimmed row in the list behind the search overlay.
 *
 * @returns how many entities were loaded.
 */
export function ensureThreadEntitiesCached(threadIds: readonly string[]): number {
  if (threadIds.length === 0) return 0;
  const { threads: known } = getStoreActions();
  const missing = [...new Set(threadIds)].filter((id) => known[id] === undefined);
  if (missing.length === 0) return 0;

  const rows = [...safeDbGetThreadsByIds(missing).values()];
  if (rows.length === 0) return 0;

  getStoreActions().cacheThreadEntities(rows);
  return rows.length;
}

/**
 * Fetch a thread from the API, decrypt its content, and upsert into the store.
 *
 * Recency is reconciled before anything is written (#883, #897). The slice's
 * never-lower merge cannot do this job alone: SQLite has no such guard and
 * `dbSaveThread` runs first, AND the server's `last_reply_at` is per-viewer
 * since Backend #306, so a block must be allowed to lower it. The decision
 * runs here, against the store row captured BEFORE the request OR, when the
 * store is empty (a cold open straight from a push notification), the row
 * already on disk. See {@link reconcileServerRecency}.
 */
export async function loadThread(threadId: string): Promise<Thread> {
  const before = getStoreActions().threads[threadId];
  const blockedGenerationBefore = getStoreActions().blockedUsersGeneration;

  const response = await getThread(threadId);
  const groupKey = await getOrFetchGroupKey(response.groupId);
  const mapped = await mapThreadResponse(response, groupKey);

  const storeAfter = getStoreActions();
  const live = storeAfter.threads[threadId];
  const thread: Thread = applyReconciledRecency(
    mapped,
    reconcileServerRecency({
      serverSent: response.lastReplyAt !== undefined,
      serverValue: mapped.lastReplyAt,
      serverReplyCount: mapped.replyCount,
      before,
      live,
      fallback: live ? null : safeDbGetThread(threadId),
      blockedSetChanged:
        storeAfter.blockedUsersGeneration !== blockedGenerationBefore,
    }),
  );

  // Write-through: persist decrypted thread to SQLCipher
  if (isDatabaseInitialized()) {
    try {
      dbSaveThread(thread);
    } catch (e) {
      if (__DEV__) console.warn('[loadThread] DB write failed:', e instanceof Error ? e.message : e);
    }
  }

  // Already reconciled above (#897) — the slice must not merge again.
  getStoreActions().upsertThread(thread, { authoritativeRecency: true });
  return thread;
}

/**
 * Fetch replies for a thread (paginated), decrypt content, and load into the store.
 *
 * ALWAYS appends (#821). The store list is an unordered set — display order is
 * derived per render by `replyTree.ts` — so page 1 no longer replaces the list.
 * Removal reconciliation, which `setReplies` used to do as a side effect, is
 * now explicit: see {@link reconcileThreadReplies}.
 *
 * @param threadId - The thread whose replies to load.
 * @param groupId  - The group ID for decryption (AAD).
 * @param offset   - Row offset from a previous call, counted in RAW server rows.
 * @returns
 *  - `replies`    — the rows that decrypted.
 *  - `rawCount`   — rows the server returned, decrypted or not. The only sound
 *                   pagination offset increment: counting decrypted rows drifts
 *                   past a failure and silently skips replies.
 *  - `serverIds`  — RAW server ids, including rows that failed to decrypt, so a
 *                   decrypt failure is never mistaken for a server-side removal.
 *  - `newIdCount` — rows this page added to the store. Zero means the list
 *                   length did not change, so `onEndReached` will not re-fire.
 *  - `hasMore`    — the server's flag.
 */
export async function loadReplies(
  threadId: string,
  groupId: string,
  offset?: number,
): Promise<{
  replies: Reply[];
  rawCount: number;
  serverIds: string[];
  newIdCount: number;
  hasMore: boolean;
}> {
  const response = await getThreadReplies(threadId, offset);

  // A malformed 200 must NOT read as "the thread is empty": that would end the
  // pass with an empty keep-set and hand every loaded reply to the reconcile.
  // Throwing puts it on the caller's existing failure path, where no page is
  // applied and no reconcile runs.
  if (!Array.isArray(response.replies) || typeof response.hasMore !== 'boolean') {
    throw new Error('[loadReplies] malformed replies response');
  }

  const groupKey = await getOrFetchGroupKey(groupId);

  const rawReplies = response.replies;
  const rawCount = rawReplies.length;
  const serverIds = rawReplies.map((r) => r.replyId);

  const results = await Promise.allSettled(
    rawReplies.map((r) => mapReplyResponse(r, groupKey, groupId)),
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
  // Counted BEFORE the append, against the ids the store already holds.
  // Counted over the DECRYPTED rows: it answers "did the rendered list grow",
  // so a page that is entirely decrypt failures reports 0 and the caller keeps
  // paging instead of waiting for an onEndReached that will never fire.
  const knownIds = new Set(store.replyIdsByThread[threadId] ?? []);
  let newIdCount = 0;
  for (const reply of replies) {
    if (!knownIds.has(reply.id)) newIdCount++;
  }
  store.appendReplies(threadId, replies);

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
    rawCount,
    serverIds,
    newIdCount,
    hasMore: response.hasMore,
  };
}

/**
 * Drop replies the server no longer returns, from the store AND from SQLite (#821).
 *
 * Call this only after a COMPLETE pagination pass (the page that returned
 * `hasMore === false`), passing every RAW server id seen across that pass and
 * the ids that existed when the pass STARTED. `setReplies` on page 1 used to be
 * the only client path that cleared a reply removed server-side (admin takedowns
 * run `DELETE FROM replies`, and the backend's `parent_reply_id` FK is
 * `ON DELETE CASCADE` per migration 1730000000020 — `schema.sql` still says
 * SET NULL and is stale); now that page 1 appends, this is that path.
 *
 * Three guards, all in `reconcileReplies`: raw ids (a decrypt failure is not a
 * removal), pending rows survive, and only ids present at pass start are
 * candidates (a WebSocket reply or a confirmed send that landed mid-pass
 * postdates the server snapshot and must never be deleted).
 *
 * @returns the dropped ids.
 */
export function reconcileThreadReplies(
  threadId: string,
  serverIdsSeen: ReadonlySet<string> | readonly string[],
  candidateIds: ReadonlySet<string> | readonly string[],
): string[] {
  const store = getStoreActions();
  const dropped = store.reconcileReplies(threadId, serverIdsSeen, candidateIds);
  if (dropped.length === 0) return dropped;

  if (isDatabaseInitialized()) {
    for (const id of dropped) {
      try {
        // Also fires the FTS delete trigger, so the row leaves search too.
        dbDeleteReply(id);
      } catch (e) {
        if (__DEV__) console.warn('[reconcileThreadReplies] DB delete failed:', e instanceof Error ? e.message : e);
      }
    }
    // A takedown of an image reply has to take the image with it, or the
    // plaintext frame stays on disk and in FileLibrary. Detached: teardown is
    // async and best-effort, and the store/DB prune above must not wait on it.
    void teardownMediaForReplies(dropped);
  }
  return dropped;
}

/**
 * Best-effort local media teardown for replies that were just pruned.
 * Uses the shared `teardownLocalMedia` (row -> file -> store, in that order);
 * a video's thumbnail child is torn down with its parent.
 */
async function teardownMediaForReplies(replyIds: readonly string[]): Promise<void> {
  for (const replyId of replyIds) {
    let rows: MediaRow[];
    try {
      rows = getMediaForReply(replyId);
    } catch {
      continue; // one unreadable reply must not stop the sweep
    }
    for (const row of rows) {
      try {
        await teardownLocalMedia(row.id, resolveMediaPath(row.local_path));
        if (row.thumbnail_media_id) {
          const thumb = getMedia(row.thumbnail_media_id);
          await teardownLocalMedia(
            row.thumbnail_media_id,
            resolveMediaPath(thumb?.local_path ?? null),
          );
        }
      } catch {
        // Per-row resilience — the reply rows are already gone either way
      }
    }
  }
}

/**
 * Newest `createdAt` among the replies that would be this reply's siblings
 * (same thread, same parent), or 0. Store-only: an unsaved sibling counts.
 */
function newestSiblingCreatedAt(threadId: string, parentReplyId: string | null): number {
  const state = getStoreActions();
  const ids = state.replyIdsByThread[threadId] ?? [];
  let newest = 0;
  for (const id of ids) {
    const sibling = state.replies[id];
    if (!sibling || sibling.parentReplyId !== parentReplyId) continue;
    const at = sibling.createdAt;
    if (typeof at === 'number' && Number.isFinite(at) && at > newest) newest = at;
  }
  return newest;
}

/**
 * Encrypt and post a reply with optimistic UI.
 *
 * 1. Encrypts the body with the group key.
 * 2. Adds an optimistic reply to the store immediately.
 * 3. Sends the encrypted reply to the API.
 * 4. On success, swaps the optimistic row for the confirmed one. On failure,
 *    REMOVES the optimistic row (#749) and rethrows: the screen raises the
 *    single "Reply Failed" alert, and a row that cannot be retried, dismissed
 *    or used as a reply target is worse than no row. Nothing rehydrates it --
 *    the optimistic reply lives only in the store, since dbSaveReply runs on
 *    the success path only.
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
  // FIRST statement (#908): the enforcement point for "never send into a DM
  // whose peer you blocked". Ahead of generateUUID and addOptimisticReply, so
  // a refused send leaves NO optimistic row behind — those calls sit outside
  // the try whose catch removes it. The screens' own guards are UX only, and
  // any future DM send surface inherits this one. Resolves through the same
  // pure derivation the UI renders from, and returns null for orbit rows.
  const blockedPeer = deriveBlockedDmPeer(useAppStore.getState(), groupId);
  if (blockedPeer) throw new BlockedRecipientError(blockedPeer.peerId);

  const clientId = generateUUID();
  const store = getStoreActions();

  // Clamp past the newest sibling (#821). Siblings sort by createdAt, so a
  // device clock behind the server's would park the optimistic row ABOVE
  // replies that already exist, and it would visibly jump on confirmation.
  const now = Math.max(Date.now(), newestSiblingCreatedAt(threadId, parentReplyId) + 1);

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
    // so subsequent replies-to-this-reply use the real server ID. ONE set():
    // the old remove+upsert pair appended the confirmed row to the end of the
    // list, which is exactly how a nested reply jumped to the bottom (#821).
    store.replaceReply(clientId, confirmedReply);

    // Bump the parent thread AND the conversation so list rows stay live
    // without a refetch (#329, #883). Shared with the WS new_reply handler —
    // see applyReplyToParentThread. Without it the posting device shows a stale
    // reply count, and the sender's own post never moved their Chats row.
    applyReplyToParentThread(groupId, threadId, confirmedReply.createdAt);
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
    // #749: drop the optimistic row rather than marking it 'failed'. The
    // screen's alert is the one failure signal; a dead row would also survive
    // as a tappable (and invalid) parentReplyId and make every retry look like
    // a new lost reply.
    store.removeReply(clientId);
    // #747: rethrow the original so telemetry sees the real class / status.
    // Everything thrown out of this function is reportable free text — never
    // interpolate ids, key material or native payloads into a message.
    throw e;
  }
}

/**
 * Encrypt and create a new thread with optimistic UI.
 *
 * 1. Encrypts title and body with the group key.
 * 2. Adds an optimistic thread to the store immediately.
 * 3. Sends the encrypted thread to the API.
 * 4. On success, swaps the optimistic row for the confirmed one. On failure,
 *    REMOVES the optimistic row (#749) and rethrows; the composer shows the
 *    error banner instead. Nothing rehydrates it -- dbSaveThread runs on the
 *    success path only.
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
  // FIRST statement (#908) — see postReply: refuse before generateUUID and
  // before addOptimisticThread, so nothing is encrypted, uploaded or left in
  // the store for a DM whose peer the user blocked.
  const blockedPeer = deriveBlockedDmPeer(useAppStore.getState(), groupId);
  if (blockedPeer) throw new BlockedRecipientError(blockedPeer.peerId);

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
    // A thread composed in this app is never an import (#927).
    isImport: false,
    importSource: null,
    mediaCount: options?.mediaIds?.length ?? 0,
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
      contentType: response.media && response.media.length > 0 ? 'media' : 'text',
      syncStatus: 'synced',
      // `isImport`/`importSource` carry over from the optimistic row: a thread
      // this app composed is never an import, whatever the response says.
      mediaCount: response.media?.length ?? 0,
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
    // Your own post moves the conversation to the top of your own list (#883).
    // Server createdAt, and only on the success path: an optimistic id is never
    // bumped, so a failed post leaves the order untouched.
    getStoreActions().bumpLastMessageAt(groupId, finalThread.createdAt);

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
    // #749: drop the optimistic row rather than marking it 'failed' -- the
    // composer's error banner is the failure signal, and a ghost thread row in
    // the list has no retry affordance.
    store.removeThread(clientId);
    // #747: rethrow the original so telemetry sees the real class / status.
    // Everything thrown out of this function is reportable free text — never
    // interpolate ids, key material or native payloads into a message.
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Local hydration — instant screen loads from SQLCipher cache
// ---------------------------------------------------------------------------

/**
 * Hydrate the store with threads from the local database.
 * Called synchronously before async API fetch for instant UI.
 *
 * BOUNDED since #923: a walked orbit can hold thousands of cached rows, and
 * this read runs on every open, synchronously, for a list the server is about
 * to replace. See `getRecentThreadsForConversation` for why a LIMIT is sound
 * on this particular read and nowhere else.
 */
export function hydrateThreadsFromLocal(conversationId: string): void {
  if (!isDatabaseInitialized()) return;
  try {
    const threads = getRecentThreadsForConversation(conversationId, HYDRATE_THREAD_LIMIT);
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
  // Seed media indexes from local DB so orphaned/expired-server media still renders
  hydrateMediaFromLocal(threadId);
}

/**
 * Hydrate media indexes from the local database for a thread and its replies.
 * Seeds the Zustand mediaIdsByThread / mediaIdsByReply indexes so that media
 * items already cached on disk render immediately, even if the server has
 * purged the media and the API response no longer includes them.
 *
 * Thumbnails are excluded (useVideoThumbnail does its own cold-start probe).
 * Uses mergeMediaBatch for a single set() call across all per-reply indexes.
 *
 * Media whose author the viewer has BLOCKED is dropped (#897). The server
 * stopped sending it with Backend #310, but this path re-seeds from SQLite, so
 * without the filter a blocked author's reply photo kept rendering in the
 * blocker's root-post gallery until the row was evicted. The author arrives on
 * the row itself, resolved by the repository's JOIN (reply author for reply
 * media, thread author otherwise — including the `reply_id NULL` rows awaiting
 * the `updateMediaParent` backfill). A NULL author is fail-open, as everywhere
 * else. Filtering happens BEFORE mapping, so an excluded id reaches neither
 * the per-reply index nor the thread aggregate.
 */
export function hydrateMediaFromLocal(threadId: string): void {
  if (!isDatabaseInitialized()) return;
  try {
    const batchMap = new Map<string, { type: 'thread' | 'reply'; items: MediaItem[] }>();

    // Thread-level media (OP-attached); reply media is folded in below (#601)
    const threadRows = getThreadLevelMedia(threadId);
    const threadItems = threadRows
      .filter((r) => (r.is_thumbnail ?? 0) === 0 && !isBlockedAuthor(r.author_id))
      .map(mediaRowToItem);

    // Per-reply media (batched join)
    const replyRows = getMediaForThreadReplies(threadId);
    const byReply = new Map<string, MediaItem[]>();
    const allReplyItems: MediaItem[] = [];
    for (const row of replyRows) {
      if (!row.reply_id) continue;
      if (isBlockedAuthor(row.author_id)) continue;
      const item = mediaRowToItem(row);
      allReplyItems.push(item);
      let arr = byReply.get(row.reply_id);
      if (!arr) {
        arr = [];
        byReply.set(row.reply_id, arr);
      }
      arr.push(item);
    }
    for (const [replyId, items] of byReply) {
      batchMap.set(replyId, { type: 'reply', items });
    }

    // Thread aggregate: OP items first, then reply items — matches the
    // server-path aggregation design ratified for #601. mergeMediaBatch
    // is Set-deduped so the later server merge stays idempotent.
    const combinedThreadItems = [...threadItems, ...allReplyItems];
    if (combinedThreadItems.length > 0) {
      batchMap.set(threadId, { type: 'thread', items: combinedThreadItems });
    }

    if (batchMap.size > 0) {
      useAppStore.getState().mergeMediaBatch(batchMap);
    }
  } catch (e) {
    if (__DEV__) console.warn('[hydrateMediaFromLocal] failed:', e instanceof Error ? e.message : e);
  }
}
