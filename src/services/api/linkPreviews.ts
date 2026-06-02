import { request, buildQueryString } from './client';
import type { LinkPreviewResponse } from '../../types/api';

export function getLinkPreview(
  url: string,
  signal?: AbortSignal,
): Promise<LinkPreviewResponse> {
  const qs = buildQueryString({ url });
  return request<LinkPreviewResponse>({
    method: 'GET',
    path: `/api/link-preview${qs}`,
    timeout: 8_000,
    signal,
  });
}
