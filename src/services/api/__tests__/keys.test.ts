jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import { uploadPreKeyBundle, getPreKeyCount, fetchRemoteIdentityKeyBundle } from '../keys';
import type { UploadPreKeyBundleRequest } from '../../../types/api';

const mockRequest = request as jest.MockedFunction<typeof request>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue({});
});

const sampleBundle: UploadPreKeyBundleRequest = {
  registrationId: 12345,
  deviceId: 1,
  identityKey: 'aWRlbnRpdHlLZXk=',
  signedPreKey: {
    keyId: 1,
    publicKey: 'c2lnbmVkUHVibGljS2V5',
    signature: 'c2lnbmF0dXJl',
  },
  preKeys: [{ keyId: 1, publicKey: 'cHJlS2V5' }],
  kyberPreKeys: [
    { keyId: 1, publicKey: 'a3liZXJQdWJsaWNLZXk=', signature: 'a3liZXJTaWc=' },
  ],
  lastResortKyberPreKey: {
    keyId: 101,
    publicKey: 'bGFzdFJlc29ydA==',
    signature: 'bGFzdFJlc29ydFNpZw==',
    lastResort: true,
  },
};

describe('uploadPreKeyBundle', () => {
  it('calls POST /v1/keys/bundle with the provided data', async () => {
    await uploadPreKeyBundle(sampleBundle);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/keys/bundle',
      body: sampleBundle,
    });
  });

  it('returns the response from request()', async () => {
    const mockResponse = { success: true };
    mockRequest.mockResolvedValue(mockResponse);

    const result = await uploadPreKeyBundle(sampleBundle);
    expect(result).toEqual(mockResponse);
  });
});

describe('getPreKeyCount', () => {
  it('calls GET /v1/keys/count', async () => {
    mockRequest.mockResolvedValue({ count: 42 });

    await getPreKeyCount();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/keys/count',
    });
  });

  it('returns the response from request()', async () => {
    mockRequest.mockResolvedValue({ count: 17 });

    const result = await getPreKeyCount();
    expect(result).toEqual({ count: 17 });
  });
});

describe('fetchRemoteIdentityKeyBundle', () => {
  it('calls GET /v1/keys/bundle/:serviceId', async () => {
    mockRequest.mockResolvedValue({ identityKey: 'base64key' });

    await fetchRemoteIdentityKeyBundle('user-uuid-123');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/keys/bundle/user-uuid-123',
    });
  });

  it('encodes the serviceId parameter', async () => {
    mockRequest.mockResolvedValue({ identityKey: 'base64key' });

    await fetchRemoteIdentityKeyBundle('user/with/slashes');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/keys/bundle/user%2Fwith%2Fslashes',
    });
  });

  it('returns the response from request()', async () => {
    const mockResponse = { identityKey: 'AQID' };
    mockRequest.mockResolvedValue(mockResponse);

    const result = await fetchRemoteIdentityKeyBundle('user-uuid');
    expect(result).toEqual(mockResponse);
  });
});
