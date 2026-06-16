/**
 * User profile API service.
 */

import { request } from './client';
import type {
  UserProfile,
  UpdateDisplayNameResponse,
  UploadAvatarResponse,
} from '../../types/api';

export function getMe(): Promise<UserProfile> {
  return request<UserProfile>({
    method: 'GET',
    path: '/api/users/me',
  });
}

export function updateDisplayName(displayName: string): Promise<UpdateDisplayNameResponse> {
  return request<UpdateDisplayNameResponse>({
    method: 'PUT',
    path: '/api/users/display-name',
    body: { displayName },
  });
}

export function uploadAvatar(formData: FormData): Promise<UploadAvatarResponse> {
  return request<UploadAvatarResponse>({
    method: 'POST',
    path: '/api/users/avatar',
    body: formData,
  });
}

export function deleteAvatar(): Promise<void> {
  return request<void>({
    method: 'DELETE',
    path: '/api/users/avatar',
  });
}

/**
 * Permanently delete the authenticated user's account.
 * Requires password re-entry for confirmation.
 *
 * Backend returns:
 * - 200: success
 * - 403: incorrect password (INCORRECT_PASSWORD)
 * - 409: user still admins multi-member orbits (must transfer/dissolve first)
 * - 400: missing password
 * - 429: rate limited
 */
export function deleteAccount(userId: string, password: string): Promise<void> {
  return request<void>({
    method: 'DELETE',
    path: `/api/users/${encodeURIComponent(userId)}`,
    body: { password },
  });
}

// ---------------------------------------------------------------------------
// Block / Unblock
// ---------------------------------------------------------------------------

export function blockUserApi(userId: string): Promise<void> {
  return request<void>({
    method: 'PUT',
    path: `/api/users/${encodeURIComponent(userId)}/block`,
  });
}

export function unblockUserApi(userId: string): Promise<void> {
  return request<void>({
    method: 'DELETE',
    path: `/api/users/${encodeURIComponent(userId)}/block`,
  });
}

export interface BlockedUsersResponse {
  blockedUserIds: string[];
}

export function getBlockedUsers(): Promise<BlockedUsersResponse> {
  return request<BlockedUsersResponse>({
    method: 'GET',
    path: '/api/users/blocked',
  });
}
