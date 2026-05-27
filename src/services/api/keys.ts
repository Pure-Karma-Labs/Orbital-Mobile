import { request } from './client';
import type {
  UploadPreKeyBundleRequest,
  UploadPreKeyBundleResponse,
  PreKeyCountResponse,
  PreKeyBundleResponse,
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

export function getPreKeyBundle(serviceId: string): Promise<PreKeyBundleResponse> {
  return request<PreKeyBundleResponse>({
    method: 'GET',
    path: `/v1/keys/bundle/${encodeURIComponent(serviceId)}`,
  });
}
