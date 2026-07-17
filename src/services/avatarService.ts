/**
 * Avatar encryption service — handles encrypted avatar upload, download, and caching.
 *
 * Upload flow:
 * 1. Read image bytes from URI
 * 2. Generate attachment keys (64 bytes: 32 AES + 32 HMAC)
 * 3. Encrypt image with attachment keys
 * 4. For each group the user belongs to, encrypt the attachment key under the group key
 * 5. POST FormData with encrypted blob + digest + avatar_group_keys
 * 6. Persist attachment key locally in SQLCipher items table
 *
 * Download/resolve flow:
 * 1. Check if decrypted avatar file exists in cache
 * 2. If not, decrypt the avatar key using group key, fetch encrypted blob, decrypt, cache
 *
 * SECURITY: Decrypted avatars are written to CachesDirectoryPath (not DocumentDirectoryPath)
 * to avoid iCloud/iTunes backup exposure. Ciphertext ArrayBuffer is released before base64
 * encoding to allow GC. Atomic write via .tmp + rename prevents partial plaintext on crash.
 */

import {
  generateAttachmentKeys,
  encryptAttachment,
  decryptAttachment,
} from './crypto/attachmentCrypto';
import {
  encryptContent,
  decryptContent,
  getOrFetchGroupKey,
} from './crypto/contentCrypto';
import { arrayBufferToBase64, base64ToArrayBuffer, toArrayBuffer } from './crypto/utils';
import { request, requestBinary } from './api/client';
import { listGroups } from './api/groups';
import { setItem, getItem } from '../database/repositories/itemRepository';
import { useAppStore } from '../stores/useAppStore';
import type { UploadAvatarResponse } from '../types/api';
import { createSemaphore } from '../utils/semaphore';
import {
  readFile,
  writeFile,
  exists,
  mkdir,
  moveFile,
  unlink,
  CachesDirectoryPath,
} from '@dr.pogodin/react-native-fs';
import { sanitizeStillImage } from './media/imageSanitizer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AVATAR_CACHE_DIR = `${CachesDirectoryPath}/avatars`;
const AVATAR_KEY_ITEM_ID = 'avatarAttachmentKey';

// Inflight dedup for resolve operations
const resolveInflight = new Map<string, Promise<string | null>>();

// 3 concurrent: avatar decrypt is sync FFI (~10-100ms each);
// more would starve the JS thread for animations/gestures.
const avatarSemaphore = createSemaphore(3);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureAvatarCacheDir(): Promise<void> {
  const dirExists = await exists(AVATAR_CACHE_DIR);
  if (!dirExists) {
    await mkdir(AVATAR_CACHE_DIR);
  }
}

/**
 * Build a cache filename for a decrypted avatar.
 * Uses userId + digest to ensure stale caches are invalidated on re-upload.
 */
function avatarCachePath(userId: string, digest: string): string {
  // Sanitize userId (UUID) — should already be safe
  const safeUserId = userId.replace(/[^a-zA-Z0-9-]/g, '');
  // Digest is base64, replace unsafe chars for filesystem
  const safeDigest = digest.replace(/[/+=]/g, '_').slice(0, 32);
  return `${AVATAR_CACHE_DIR}/${safeUserId}-${safeDigest}.dec`;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Encrypt and upload an avatar image.
 *
 * @param imageUri - Local file URI from image picker
 * @param mimeType - MIME type of the image
 * @returns The new avatar URL path from the server
 */
export async function uploadEncryptedAvatar(
  imageUri: string,
  _mimeType: string,
): Promise<string> {
  const userId = useAppStore.getState().userId;
  if (!userId) {
    throw new Error('Not authenticated');
  }

  // 1. Sanitize image (strip EXIF/GPS metadata, fail-closed verify)
  // SECURITY: The picker's resize re-encode is NOT a reliable strip.
  // sanitizeStillImage is the authoritative strip for all still images.
  const sanitizedPath = `${CachesDirectoryPath}/avatar-sanitized-${Date.now()}.jpg`;
  let imageBytes: Uint8Array;
  try {
    const sourcePath = imageUri.startsWith('file://') ? imageUri.slice(7) : imageUri;
    await sanitizeStillImage(sourcePath, _mimeType || 'image/jpeg', sanitizedPath);
    const imageBase64 = await readFile(sanitizedPath, 'base64');
    imageBytes = new Uint8Array(base64ToArrayBuffer(imageBase64));
  } finally {
    await unlink(sanitizedPath).catch(() => {});
  }

  // 2. Generate fresh attachment keys
  const { keys, keysBase64 } = generateAttachmentKeys();

  // 3. Encrypt image
  const { ciphertext, digest } = encryptAttachment(imageBytes, keys);

  // 4. Get all groups the user belongs to and encrypt the key for each
  const groups = await listGroups();
  const avatarGroupKeys: Array<{
    group_id: string;
    encrypted_key: string;
    key_iv: string;
  }> = [];

  for (const group of groups) {
    try {
      const groupKey = await getOrFetchGroupKey(group.groupId);
      // AAD: groupId + ":" + userId — binds to both group and avatar owner
      const aad = `${group.groupId}:${userId}`;
      const encrypted = encryptContent(keysBase64, groupKey, aad);
      avatarGroupKeys.push({
        group_id: group.groupId,
        encrypted_key: encrypted.ciphertext,
        key_iv: encrypted.iv,
      });
    } catch {
      // Skip groups where we don't have a key (we're pending)
      if (__DEV__) {
        console.warn('[avatarService] skipping group key wrap for', group.groupId);
      }
    }
  }

  if (avatarGroupKeys.length === 0 && groups.length > 0) {
    console.warn('[avatarService] No group keys wrapped — avatar will be visible only to self until keys are distributed');
  }

  // 5. Build FormData
  const digestBase64 = arrayBufferToBase64(toArrayBuffer(digest));

  // Write ciphertext to a temp file — Hermes cannot create Blobs from ArrayBuffer
  const ciphertextBase64 = arrayBufferToBase64(toArrayBuffer(ciphertext));
  const tempPath = `${CachesDirectoryPath}/avatar-upload-${Date.now()}.enc`;
  await writeFile(tempPath, ciphertextBase64, 'base64');

  const formData = new FormData();
  formData.append('avatar', {
    uri: `file://${tempPath}`,
    type: 'application/octet-stream',
    name: 'avatar.enc',
  } as unknown as Blob);
  formData.append('avatar_digest', digestBase64);
  formData.append('avatar_group_keys', JSON.stringify(avatarGroupKeys));

  // 6. POST to server
  let uploadResponse: UploadAvatarResponse;
  try {
    uploadResponse = await request<UploadAvatarResponse>({
      method: 'POST',
      path: '/api/users/avatar',
      body: formData,
    });
  } finally {
    unlink(tempPath).catch(() => {});
  }

  // 7. Store attachment key locally in SQLCipher
  try {
    setItem(AVATAR_KEY_ITEM_ID, keysBase64);
  } catch {
    // DB may not be initialized — key is lost but avatar is on server
    if (__DEV__) {
      console.warn('[avatarService] failed to persist avatar key to SQLCipher');
    }
  }

  // Cache the decrypted avatar locally so we don't re-download our own
  try {
    await ensureAvatarCacheDir();
    const cachePath = avatarCachePath(userId, digestBase64);
    const tmpPath = `${cachePath}.tmp`;
    const plaintextBase64 = arrayBufferToBase64(toArrayBuffer(imageBytes));
    await writeFile(tmpPath, plaintextBase64, 'base64');
    await unlink(cachePath).catch(() => {});
    await moveFile(tmpPath, cachePath);
  } catch {
    // Best effort — avatar will be re-downloaded if needed
  }

  // Update the store with both avatar path and digest
  useAppStore.getState().updateProfile({
    avatarPath: uploadResponse.avatarUrl,
    avatarDigest: digestBase64,
  });

  return uploadResponse.avatarUrl;
}

// ---------------------------------------------------------------------------
// Download / Resolve
// ---------------------------------------------------------------------------

/**
 * Resolve an avatar for display — returns a file:// URI to the decrypted image,
 * or null if the avatar cannot be resolved.
 *
 * For the current user's own avatar, uses the locally stored attachment key.
 * For other users, decrypts the avatar key from the contact's encrypted key data.
 *
 * @param userId        - The user whose avatar to resolve
 * @param avatarDigest  - Base64 SHA-256 digest of the encrypted avatar blob
 * @param encryptedKey  - Base64 AES-GCM ciphertext of the attachment key (null for self)
 * @param keyIv         - Base64 IV for the encrypted key (null for self)
 * @param sharedGroupId - Group ID for group key lookup (null for self)
 */
export async function resolveAvatar(
  userId: string,
  avatarDigest: string,
  encryptedKey: string | null,
  keyIv: string | null,
  sharedGroupId: string | null,
): Promise<string | null> {
  // Dedup inflight requests for the same user+digest
  const dedupKey = `${userId}:${avatarDigest}`;
  const existing = resolveInflight.get(dedupKey);
  if (existing) return existing;

  const promise = _doResolveAvatar(userId, avatarDigest, encryptedKey, keyIv, sharedGroupId)
    .finally(() => {
      // Identity check: only delete if the map still points to this promise
      // (prevents clearing a newer request if the key was reused)
      if (resolveInflight.get(dedupKey) === promise) {
        resolveInflight.delete(dedupKey);
      }
    });

  // Set BEFORE awaiting — prevents race where concurrent callers
  // slip past the dedup check before the promise is registered
  resolveInflight.set(dedupKey, promise);
  return promise;
}

async function _doResolveAvatar(
  userId: string,
  avatarDigest: string,
  encryptedKey: string | null,
  keyIv: string | null,
  sharedGroupId: string | null,
): Promise<string | null> {
  // 1. Check cache (before acquiring semaphore — fast path)
  await ensureAvatarCacheDir();
  const cachePath = avatarCachePath(userId, avatarDigest);
  const cached = await exists(cachePath);
  if (cached) {
    return `file://${cachePath}`;
  }

  // 2. Acquire semaphore slot — limits concurrent decrypt/download operations
  await avatarSemaphore.acquire();
  try {
    // Re-check cache after acquiring slot — another request may have
    // completed while we were waiting in the semaphore queue
    const cachedAfterWait = await exists(cachePath);
    if (cachedAfterWait) {
      return `file://${cachePath}`;
    }

    // 3. Get the attachment key
    let keysBase64: string;
    const currentUserId = useAppStore.getState().userId;

    if (userId === currentUserId) {
      // Own avatar — use locally stored key
      const storedKey = getItem(AVATAR_KEY_ITEM_ID);
      if (!storedKey) {
        if (__DEV__) {
          console.warn('[avatarService] no stored avatar key for own avatar');
        }
        return null;
      }
      keysBase64 = storedKey;
    } else {
      // Other user's avatar — decrypt the key using group key
      if (!encryptedKey || !keyIv || !sharedGroupId) {
        if (__DEV__) {
          console.warn('[avatarService] missing encrypted key data for user', userId);
        }
        return null;
      }

      try {
        const groupKey = await getOrFetchGroupKey(sharedGroupId);
        const aad = `${sharedGroupId}:${userId}`;
        keysBase64 = decryptContent(encryptedKey, keyIv, groupKey, aad);
      } catch (e) {
        if (__DEV__) {
          console.warn('[avatarService] failed to decrypt avatar key:', e instanceof Error ? e.message : e);
        }
        return null;
      }
    }

    // 4. Decode keysBase64 to 64-byte Uint8Array
    const keysBuffer = base64ToArrayBuffer(keysBase64);
    const keys = new Uint8Array(keysBuffer);
    if (keys.length !== 64) {
      if (__DEV__) {
        console.warn('[avatarService] invalid key length:', keys.length);
      }
      return null;
    }

    // 5. Fetch, decrypt, and cache — wrapped in try/finally to ensure
    // key material is zeroed on all exit paths (mirrors Rust Zeroizing<>)
    try {
      let ciphertextBuffer: ArrayBuffer;
      const abortController = new AbortController();
      const abortTimeout = setTimeout(() => abortController.abort(), 30_000);
      try {
        const { data } = await requestBinary({
          method: 'GET',
          path: `/api/users/${encodeURIComponent(userId)}/avatar-file`,
          signal: abortController.signal,
        });
        ciphertextBuffer = data;
      } catch (e) {
        if (__DEV__) {
          console.warn('[avatarService] failed to download avatar:', e instanceof Error ? e.message : e);
        }
        return null;
      } finally {
        clearTimeout(abortTimeout);
      }

      // 6. Decode digest and decrypt
      const digestBytes = new Uint8Array(base64ToArrayBuffer(avatarDigest));
      let plaintext: Uint8Array;
      {
        const ciphertextBytes = new Uint8Array(ciphertextBuffer);
        try {
          plaintext = decryptAttachment(ciphertextBytes, keys, digestBytes);
        } catch (e) {
          if (__DEV__) {
            console.warn('[avatarService] decryption failed:', e instanceof Error ? e.message : e);
          }
          return null;
        }
      }

      // 7. Atomic write to cache
      const tmpPath = `${cachePath}.tmp`;
      try {
        const plaintextBase64 = arrayBufferToBase64(toArrayBuffer(plaintext));
        await writeFile(tmpPath, plaintextBase64, 'base64');
        await unlink(cachePath).catch(() => {});
        await moveFile(tmpPath, cachePath);
      } catch (e) {
        await unlink(tmpPath).catch(() => {});
        if (__DEV__) {
          console.warn('[avatarService] failed to write cache:', e instanceof Error ? e.message : e);
        }
        return null;
      } finally {
        plaintext.fill(0);
      }

      return `file://${cachePath}`;
    } finally {
      keys.fill(0);
    }
  } finally {
    avatarSemaphore.release();
  }
}

// ---------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------

/**
 * Invalidate the cached avatar for a user.
 * Called when AVATAR_CHANGED WebSocket event is received.
 */
export async function invalidateAvatarCache(userId: string): Promise<void> {
  try {
    const dirExists = await exists(AVATAR_CACHE_DIR);
    if (!dirExists) return;

    // Delete all cached files for this userId (any digest)
    const safeUserId = userId.replace(/[^a-zA-Z0-9-]/g, '');
    // We can't easily list files in RN without readDir, so use readDir
    const { readDir: readDirectory } = await import('@dr.pogodin/react-native-fs');
    const files = await readDirectory(AVATAR_CACHE_DIR);
    for (const file of files) {
      if (file.name.startsWith(`${safeUserId}-`)) {
        await unlink(file.path).catch(() => {});
      }
    }
  } catch {
    // Best effort
  }
}

/**
 * Clear all avatar caches. Called on logout.
 */
export async function clearAvatarCache(): Promise<void> {
  try {
    const dirExists = await exists(AVATAR_CACHE_DIR);
    if (!dirExists) return;

    const { readDir: readDirectory } = await import('@dr.pogodin/react-native-fs');
    const files = await readDirectory(AVATAR_CACHE_DIR);
    for (const file of files) {
      await unlink(file.path).catch(() => {});
    }
  } catch {
    // Best effort
  }
}

/**
 * Clear avatar service in-memory state. Called on logout/wipe to prevent
 * stale inflight promises and semaphore slots from leaking across sessions.
 */
export function clearAvatarServiceState(): void {
  resolveInflight.clear();
  avatarSemaphore.reset();
}
