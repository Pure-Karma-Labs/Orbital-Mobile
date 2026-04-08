/**
 * App version check API service.
 */

import { request } from './client';
import type { VersionCheckResponse } from '../../types/api';

export function checkVersion(
  platform: string,
  version: string,
): Promise<VersionCheckResponse> {
  const qs = `platform=${encodeURIComponent(platform)}&version=${encodeURIComponent(version)}`;
  return request<VersionCheckResponse>({
    method: 'GET',
    path: `/api/version/check?${qs}`,
    skipAuth: true,
  });
}
