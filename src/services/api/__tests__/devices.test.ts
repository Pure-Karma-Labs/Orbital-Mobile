/**
 * Tests for the devices API service.
 */

jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import { registerDevice } from '../devices';

const mockRequest = request as jest.MockedFunction<typeof request>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue({});
});

describe('registerDevice', () => {
  it('calls POST /api/devices/register with iOS platform and push token', async () => {
    const data = { platform: 'ios' as const, pushToken: 'apns-token-abc' };
    await registerDevice(data);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/devices/register',
      body: data,
    });
  });

  it('calls POST /api/devices/register with Android platform and push token', async () => {
    const data = { platform: 'android' as const, pushToken: 'fcm-token-xyz' };
    await registerDevice(data);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/devices/register',
      body: data,
    });
  });
});
