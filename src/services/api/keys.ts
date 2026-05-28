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
