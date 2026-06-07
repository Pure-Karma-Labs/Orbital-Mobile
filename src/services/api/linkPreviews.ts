import { request, buildQueryString, API_BASE_URL } from './client';
import type { LinkPreviewResponse } from '../../types/api';

export async function getLinkPreview(
  url: string,
  signal?: AbortSignal,
): Promise<LinkPreviewResponse> {
  const qs = buildQueryString({ url });
  const data = await request<LinkPreviewResponse>({
    method: 'GET',
    path: `/api/link-preview${qs}`,
    timeout: 8_000,
    signal,
  });
  if (data.imageUrl && data.imageUrl.startsWith('/')) {
    data.imageUrl = `${API_BASE_URL}${data.imageUrl}`;
  }
  return data;
}
