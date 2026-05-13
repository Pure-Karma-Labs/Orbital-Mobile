/**
 * Media API endpoints — chunked upload and binary download.
 *
 * Upload uses multipart FormData with snake_case field names (backend expectation).
 * Download uses requestBinary() to return raw ArrayBuffer + response headers.
 */

import { request, requestBinary } from './client';
import type { UploadChunkResponse } from '../../types/api';

// ============================================================
// Upload
// ============================================================

export interface UploadChunkParams {
  mediaId: string;
  groupId: string;
  chunkIndex: number;
  totalChunks: number;
  encryptedChunk: string;
  hmac: string;
  encryptedMetadata?: string;
  encryptionIv?: string;
}

/**
 * Upload a single encrypted chunk of a media file.
 *
 * POST /api/media/upload/chunk — multipart FormData with snake_case field names.
 * FormData fields are manually set to snake_case (not using camelToSnake transform,
 * which operates on JSON bodies, not FormData).
 */
export function uploadChunk(
  params: UploadChunkParams,
  signal?: AbortSignal,
): Promise<UploadChunkResponse> {
  const formData = new FormData();
  formData.append('media_id', params.mediaId);
  formData.append('group_id', params.groupId);
  formData.append('chunk_index', String(params.chunkIndex));
  formData.append('total_chunks', String(params.totalChunks));
  formData.append('encrypted_chunk', params.encryptedChunk);
  formData.append('hmac', params.hmac);
  if (params.encryptedMetadata) {
    formData.append('encrypted_metadata', params.encryptedMetadata);
  }
  if (params.encryptionIv) {
    formData.append('encryption_iv', params.encryptionIv);
  }

  return request<UploadChunkResponse>({
    method: 'POST',
    path: '/api/media/upload/chunk',
    body: formData,
    timeout: 60_000,
    signal,
  });
}

// ============================================================
// Complete upload
// ============================================================

export interface CompleteUploadResponse {
  mediaId: string;
  sizeBytes: number;
  uploadedAt: string;
  expiresAt: string;
  chunksUploaded: number;
}

/**
 * Signal that all chunks for a media upload have been sent.
 *
 * POST /api/media/upload/complete — JSON body.
 */
export function completeUpload(
  mediaId: string,
  groupId: string,
): Promise<CompleteUploadResponse> {
  return request<CompleteUploadResponse>({
    method: 'POST',
    path: '/api/media/upload/complete',
    body: { mediaId, groupId },
  });
}

// ============================================================
// Download
// ============================================================

export interface DownloadMediaResult {
  data: ArrayBuffer;
  encryptionIv: string | null;
  expiresAt: string | null;
}

/**
 * Download an encrypted media file.
 *
 * GET /api/media/:id/download — returns raw binary via requestBinary().
 * Custom headers X-Encryption-IV and X-Expires-At are extracted from the response.
 */
export async function downloadMedia(
  mediaId: string,
  signal?: AbortSignal,
): Promise<DownloadMediaResult> {
  const { data, headers } = await requestBinary({
    method: 'GET',
    path: `/api/media/${encodeURIComponent(mediaId)}/download`,
    timeout: 60_000,
    signal,
  });
  return {
    data,
    encryptionIv: headers.get('x-encryption-iv'),
    expiresAt: headers.get('x-expires-at'),
  };
}
