/**
 * Device registration API service (push notifications).
 */

import { request } from './client';
import type {
  RegisterDeviceRequest,
  RegisterDeviceResponse,
} from '../../types/api';

export function registerDevice(
  data: RegisterDeviceRequest,
): Promise<RegisterDeviceResponse> {
  return request<RegisterDeviceResponse>({
    method: 'POST',
    path: '/api/devices/register',
    body: data,
  });
}
