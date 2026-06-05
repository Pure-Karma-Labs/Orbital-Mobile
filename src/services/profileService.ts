/**
 * Profile mutation service — orchestrates display name and avatar API calls
 * with store updates.
 *
 * Components call these functions; they never touch the API or store directly
 * for profile mutations. Follows the same pattern as threadService and
 * conversationService.
 */

import { updateDisplayName, deleteAvatar } from './api/users';
import { uploadEncryptedAvatar } from './avatarService';
import { useAppStore } from '../stores/useAppStore';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * Update the current user's display name.
 *
 * Calls the API then updates the auth store on success.
 */
export async function updateUserDisplayName(displayName: string): Promise<void> {
  await updateDisplayName(displayName);
  useAppStore.getState().updateProfile({ displayName });
}

/**
 * Upload a new avatar image from the device photo library.
 *
 * Validates mime type, encrypts the image client-side, wraps the attachment
 * key for all groups, and uploads the encrypted blob to the server.
 *
 * @param imageUri  - Local file URI from the image picker
 * @param mimeType  - MIME type of the selected image
 * @returns The new avatar URL path from the server
 */
export async function updateUserAvatar(
  imageUri: string,
  mimeType: string,
): Promise<string> {
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new Error('Unsupported image type. Please use JPEG, PNG, GIF, or WebP.');
  }

  return uploadEncryptedAvatar(imageUri, mimeType);
}

/**
 * Remove the current user's avatar.
 *
 * Calls the API then clears the avatar path in the store.
 */
export async function removeUserAvatar(): Promise<void> {
  await deleteAvatar();
  useAppStore.getState().updateProfile({ avatarPath: null });
}
