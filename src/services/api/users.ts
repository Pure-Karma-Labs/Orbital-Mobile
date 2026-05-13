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

