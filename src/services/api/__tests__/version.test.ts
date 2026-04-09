/**
 * Tests for the version API service.
 */

jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import { checkVersion } from '../version';

const mockRequest = request as jest.MockedFunction<typeof request>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue({});
});

describe('checkVersion', () => {
  it('calls GET /api/version/check with platform and version query params', async () => {
    await checkVersion('ios', '1.2.3');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/version/check?platform=ios&version=1.2.3',
      skipAuth: true,
    });
  });

  it('uses skipAuth: true', async () => {
    await checkVersion('android', '2.0.0');

    const callArg = mockRequest.mock.calls[0][0];
    expect(callArg.skipAuth).toBe(true);
  });

  it('encodes special characters in platform and version', async () => {
    await checkVersion('ios beta', '1.0.0-rc.1');

    const callArg = mockRequest.mock.calls[0][0];
    expect(callArg.path).toContain('platform=ios%20beta');
    expect(callArg.path).toContain('version=1.0.0-rc.1');
  });
});
