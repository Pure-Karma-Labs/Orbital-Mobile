/**
 * User profile API service.
 */

import { request } from './client';
import type { UserProfile } from '../../types/api';

export function getMe(): Promise<UserProfile> {
  return request<UserProfile>({
    method: 'GET',
    path: '/api/users/me',
  });
}

