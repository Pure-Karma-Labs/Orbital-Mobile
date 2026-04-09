/**
 * App version check API service.
 */

import { request, buildQueryString } from './client';
import type { VersionCheckResponse } from '../../types/api';

export function checkVersion(
  platform: string,
  version: string,
): Promise<VersionCheckResponse> {
  const qs = buildQueryString({ platform, version });
  return request<VersionCheckResponse>({
    method: 'GET',
    path: `/api/version/check${qs}`,
    skipAuth: true,
  });
}
