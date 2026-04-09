/**
 * Tests for the media API service.
 */

jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import { uploadChunk, downloadMedia } from '../media';

const mockRequest = request as jest.MockedFunction<typeof request>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue({});
});

describe('uploadChunk', () => {
  it('calls POST /api/media/upload/chunk with FormData body and 60s timeout', async () => {
    const data = {
      chunkIndex: 0,
      totalChunks: 3,
      encryptedChunk: 'base64chunk==',
      hmac: 'hmactag==',
    };
    await uploadChunk(data);

    const callArg = mockRequest.mock.calls[0][0];
    expect(callArg.method).toBe('POST');
    expect(callArg.path).toBe('/api/media/upload/chunk');
    expect(callArg.body).toBeInstanceOf(FormData);
    expect(callArg.timeout).toBe(60_000);
  });

  it('includes uploadId in FormData when provided', async () => {
    const data = {
      uploadId: 'upload-session-uuid',
      chunkIndex: 1,
      totalChunks: 3,
      encryptedChunk: 'base64chunk==',
      hmac: 'hmactag==',
    };
    await uploadChunk(data);

    const callArg = mockRequest.mock.calls[0][0];
    const formData = callArg.body as FormData;
    // FormData.get is available in the test environment
    expect((formData as unknown as { get: (key: string) => string | null }).get('upload_id')).toBe('upload-session-uuid');
  });

  it('passes AbortSignal through to request', async () => {
    const controller = new AbortController();
    const data = {
      chunkIndex: 0,
      totalChunks: 1,
      encryptedChunk: 'chunk==',
      hmac: 'hmac==',
    };
    await uploadChunk(data, controller.signal);

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('omits signal when not provided', async () => {
    const data = {
      chunkIndex: 0,
      totalChunks: 1,
      encryptedChunk: 'chunk==',
      hmac: 'hmac==',
    };
    await uploadChunk(data);

    const callArg = mockRequest.mock.calls[0][0];
    expect(callArg.signal).toBeUndefined();
  });
});

describe('downloadMedia', () => {
  it('calls GET /api/media/:mediaId/download with rawResponse and 60s timeout', async () => {
    await downloadMedia('media-abc');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/media/media-abc/download',
      rawResponse: true,
      timeout: 60_000,
      signal: undefined,
    });
  });

  it('encodes special characters in mediaId', async () => {
    await downloadMedia('media/id');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/media/media%2Fid/download',
      }),
    );
  });

  it('passes AbortSignal through to request', async () => {
    const controller = new AbortController();
    await downloadMedia('media-abc', controller.signal);

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
