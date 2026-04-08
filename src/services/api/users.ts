/**
 * User profile API service.
 */

import { request } from './client';
import type {
  UpdateDisplayNameRequest,
  UpdateDisplayNameResponse,
  UploadAvatarResponse,
  UserProfile,
} from '../../types/api';

export function getMe(): Promise<UserProfile> {
  return request<UserProfile>({
    method: 'GET',
    path: '/api/users/me',
  });
}

export function getUser(userId: string): Promise<UserProfile> {
  return request<UserProfile>({
    method: 'GET',
    path: `/api/users/${encodeURIComponent(userId)}`,
  });
}

export function uploadAvatar(formData: FormData): Promise<UploadAvatarResponse> {
  return request<UploadAvatarResponse>({
    method: 'POST',
    path: '/api/users/avatar',
    body: formData,
    timeout: 60_000,
  });
}

export function deleteAvatar(): Promise<void> {
  return request<void>({
    method: 'DELETE',
    path: '/api/users/avatar',
  });
}

export function updateDisplayName(
  data: UpdateDisplayNameRequest,
): Promise<UpdateDisplayNameResponse> {
  return request<UpdateDisplayNameResponse>({
    method: 'PUT',
    path: '/api/users/display-name',
    body: data,
  });
}
