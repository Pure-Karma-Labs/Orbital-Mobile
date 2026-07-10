import { request } from './client';
import type {
  UploadPreKeyBundleRequest,
  UploadPreKeyBundleResponse,
  PreKeyCountResponse,
  IdentityKeyResponse,
} from '../../types/api';

export function uploadPreKeyBundle(
  data: UploadPreKeyBundleRequest,
): Promise<UploadPreKeyBundleResponse> {
  return request<UploadPreKeyBundleResponse>({
    method: 'POST',
    path: '/v1/keys/bundle',
    body: data,
  });
}

export function getPreKeyCount(): Promise<PreKeyCountResponse> {
  return request<PreKeyCountResponse>({ method: 'GET', path: '/v1/keys/count' });
}

export function fetchRemoteIdentityKeyBundle(
  serviceId: string,
): Promise<IdentityKeyResponse> {
  return request<IdentityKeyResponse>({
    method: 'GET',
    path: `/v1/keys/bundle/${encodeURIComponent(serviceId)}`,
  });
}

/**
 * Reset the user's identity keys on the server.
 *
 * POST /v1/keys/reset — requires password confirmation.
 * On success: server NULLs the stored identity key + revokes all JWTs
 * (iat <= password_changed_at). Triggers re-wrap fan-out on next upload.
 *
 * 403 → AuthError (incorrect password; no token clearing — same pattern as
 *        delete-account). Distinguish from 401 via statusCode.
 * 429 → client auto-retries ~7.5s before RATE_LIMITED surfaces.
 */
export function resetIdentityKeys(
  password: string,
): Promise<void> {
  return request<void>({
    method: 'POST',
    path: '/v1/keys/reset',
    body: { password },
  });
}
