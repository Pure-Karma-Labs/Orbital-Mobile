/**
 * Media API service.
 *
 * uploadChunk: uses FormData body with a 60-second timeout for large payloads.
 * downloadMedia: returns raw ArrayBuffer (encrypted bytes) via rawResponse: true.
 *   The caller is responsible for decrypting the content using the attachment key.
 */

import { request } from './client';
import type { UploadChunkRequest, UploadChunkResponse } from '../../types/api';

export function uploadChunk(
  data: UploadChunkRequest,
  signal?: AbortSignal,
): Promise<UploadChunkResponse> {
  const formData = new FormData();
  if (data.uploadId !== undefined) {
    formData.append('upload_id', data.uploadId);
  }
  formData.append('chunk_index', String(data.chunkIndex));
  formData.append('total_chunks', String(data.totalChunks));
  formData.append('encrypted_chunk', data.encryptedChunk);
  formData.append('hmac', data.hmac);
  if (data.encryptedMetadata !== undefined) {
    formData.append('encrypted_metadata', data.encryptedMetadata);
  }

  return request<UploadChunkResponse>({
    method: 'POST',
    path: '/api/media/upload/chunk',
    body: formData,
    timeout: 60_000,
    signal,
  });
}

/**
 * Download encrypted media bytes.
 * Returns a raw ArrayBuffer — caller must decrypt using the attachment key.
 */
export function downloadMedia(
  mediaId: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  return request<ArrayBuffer>({
    method: 'GET',
    path: `/api/media/${encodeURIComponent(mediaId)}/download`,
    rawResponse: true,
    timeout: 60_000,
    signal,
  });
}
