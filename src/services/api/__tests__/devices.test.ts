/**
 * Tests for the devices API service (push notification registration).
 */

jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import { registerDevice, deregisterDevice } from '../devices';

const mockRequest = request as jest.MockedFunction<typeof request>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue({});
});

describe('registerDevice', () => {
  it('calls POST /api/devices/register with platform, pushToken, and deviceId', async () => {
    mockRequest.mockResolvedValue({
      deviceId: 'device-123',
      platform: 'ios',
      registeredAt: '2026-05-20T00:00:00Z',
    });

    const result = await registerDevice({
      platform: 'ios',
      pushToken: 'fcm-token-abc',
      deviceId: 'device-123',
    });

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/devices/register',
      body: {
        platform: 'ios',
        pushToken: 'fcm-token-abc',
        deviceId: 'device-123',
      },
    });
    expect(result).toEqual({
      deviceId: 'device-123',
      platform: 'ios',
      registeredAt: '2026-05-20T00:00:00Z',
    });
  });

  it('works with android platform', async () => {
    mockRequest.mockResolvedValue({
      deviceId: 'device-456',
      platform: 'android',
      registeredAt: '2026-05-20T00:00:00Z',
    });

    await registerDevice({
      platform: 'android',
      pushToken: 'fcm-token-def',
      deviceId: 'device-456',
    });

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/devices/register',
      body: {
        platform: 'android',
        pushToken: 'fcm-token-def',
        deviceId: 'device-456',
      },
    });
  });
});

describe('deregisterDevice', () => {
  it('calls DELETE /api/devices/:deviceId', async () => {
    await deregisterDevice('device-123');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/api/devices/device-123',
    });
  });

  it('encodes special characters in the device ID', async () => {
    await deregisterDevice('device/with special');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/api/devices/device%2Fwith%20special',
    });
  });
});
