/**
 * Device registration API service (push notifications).
 */

import { request } from './client';
import type { RegisterDeviceRequest, RegisterDeviceResponse } from '../../types/api';

export function registerDevice(data: RegisterDeviceRequest): Promise<RegisterDeviceResponse> {
  return request<RegisterDeviceResponse>({
    method: 'POST',
    path: '/api/devices/register',
    body: data,
  });
}

export function deregisterDevice(deviceId: string): Promise<void> {
  return request<void>({
    method: 'DELETE',
    path: `/api/devices/${encodeURIComponent(deviceId)}`,
  });
}
