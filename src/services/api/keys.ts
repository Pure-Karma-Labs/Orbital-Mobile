import { request } from './client';
import type {
  UploadPreKeyBundleRequest,
  UploadPreKeyBundleResponse,
  PreKeyCountResponse,
} from '../../types/api';

export function uploadPreKeyBundle(
  data: UploadPreKeyBundleRequest,
): Promise<UploadPreKeyBundleResponse> {
  return request<UploadPreKeyBundleResponse>({
    method: 'POST',
    path: '/api/keys/bundle',
    body: data,
  });
}

export function getPreKeyCount(): Promise<PreKeyCountResponse> {
  return request<PreKeyCountResponse>({ method: 'GET', path: '/api/keys/count' });
}
