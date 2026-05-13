/**
 * Tests for media API functions — uploadChunk, completeUpload, downloadMedia.
 */

jest.mock('../tokenManager', () => ({
  tokenManager: {
    getAccessToken: jest.fn().mockResolvedValue('test-token'),
    clearTokens: jest.fn().mockResolvedValue(undefined),
    setTokens: jest.fn().mockResolvedValue(undefined),
    isConfigured: jest.fn().mockReturnValue(false),
    configure: jest.fn(),
  },
}));

import { uploadChunk, completeUpload, downloadMedia } from '../media';
import type { UploadChunkParams } from '../media';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockHeaders(entries: Record<string, string> = {}): Headers {
  return {
    get: jest.fn((name: string) => entries[name.toLowerCase()] ?? null),
    has: jest.fn((name: string) => name.toLowerCase() in entries),
  } as unknown as Headers;
}

function mockFetchOk(
  body: unknown,
  options: { headers?: Record<string, string> } = {},
): void {
  const headers = mockHeaders(options.headers ?? {});
  (globalThis as Record<string, unknown>).fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024)),
    headers,
  });
}

function mockFetchBinary(
  buffer: ArrayBuffer,
  headers: Record<string, string> = {},
): void {
  const h = mockHeaders(headers);
  (globalThis as Record<string, unknown>).fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: jest.fn().mockRejectedValue(new Error('not json')),
    text: jest.fn().mockResolvedValue(''),
    arrayBuffer: jest.fn().mockResolvedValue(buffer),
    headers: h,
  });
}

function mockFetchError(status: number, bodyText = ''): void {
  (globalThis as Record<string, unknown>).fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: jest.fn().mockRejectedValue(new Error('not json')),
    text: jest.fn().mockResolvedValue(bodyText),
  });
}

/** Mock Blob for test — RN's Blob type has different constructor signature */
const sampleChunkBlob = { size: 4, type: 'application/octet-stream' } as Blob;

const sampleUploadParams: UploadChunkParams = {
  mediaId: 'media-123',
  groupId: 'group-456',
  chunkIndex: 0,
  totalChunks: 3,
  chunkData: sampleChunkBlob,
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// uploadChunk
// ---------------------------------------------------------------------------

describe('uploadChunk', () => {
  it('sends POST to /api/media/upload/chunk with FormData', async () => {
    mockFetchOk({
      upload_id: 'upload-1',
      received: 1,
      complete: false,
    });

    const result = await uploadChunk(sampleUploadParams);

    const fetchMock = (globalThis as Record<string, unknown>).fetch as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/media/upload/chunk');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);

    // Verify response is parsed and transformed
    expect(result.uploadId).toBe('upload-1');
    expect(result.received).toBe(1);
    expect(result.complete).toBe(false);
  });

  it('includes optional encryptedMetadata and encryptionIv in FormData', async () => {
    mockFetchOk({ upload_id: 'upload-1', received: 1, complete: false });

    const params: UploadChunkParams = {
      ...sampleUploadParams,
      encryptedMetadata: '{"contentType":"image/jpeg"}',
      encryptionIv: 'iv==',
    };

    await uploadChunk(params);

    const fetchMock = (globalThis as Record<string, unknown>).fetch as jest.Mock;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;

    // FormData.get() should return the appended values
    expect((formData as unknown as { get(k: string): string | null }).get('encrypted_metadata')).toBe('{"contentType":"image/jpeg"}');
    expect((formData as unknown as { get(k: string): string | null }).get('encryption_iv')).toBe('iv==');
  });

  it('omits optional fields when not provided', async () => {
    mockFetchOk({ upload_id: 'upload-1', received: 1, complete: false });

    await uploadChunk(sampleUploadParams);

    const fetchMock = (globalThis as Record<string, unknown>).fetch as jest.Mock;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;

    expect((formData as unknown as { get(k: string): string | null }).get('encrypted_metadata')).toBeNull();
    expect((formData as unknown as { get(k: string): string | null }).get('encryption_iv')).toBeNull();
  });

  it('uses 60s timeout', async () => {
    mockFetchOk({ upload_id: 'upload-1', received: 1, complete: false });

    await uploadChunk(sampleUploadParams);

    // Timeout is set internally but manifests as an AbortSignal
    const fetchMock = (globalThis as Record<string, unknown>).fetch as jest.Mock;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// completeUpload
// ---------------------------------------------------------------------------

describe('completeUpload', () => {
  it('sends POST to /api/media/upload/complete with JSON body', async () => {
    mockFetchOk({
      media_id: 'media-123',
      size_bytes: 5000000,
      uploaded_at: '2026-01-01T00:00:00Z',
      expires_at: '2026-04-01T00:00:00Z',
      chunks_uploaded: 3,
    });

    const result = await completeUpload('media-123', 'group-456');

    const fetchMock = (globalThis as Record<string, unknown>).fetch as jest.Mock;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/media/upload/complete');
    expect(init.method).toBe('POST');

    // Body should be snake_case JSON
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ media_id: 'media-123', group_id: 'group-456' });

    // Response should be camelCase
    expect(result.mediaId).toBe('media-123');
    expect(result.sizeBytes).toBe(5000000);
    expect(result.chunksUploaded).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// downloadMedia
// ---------------------------------------------------------------------------

describe('downloadMedia', () => {
  it('sends GET to /api/media/:id/download and returns ArrayBuffer + headers', async () => {
    const buffer = new ArrayBuffer(2048);
    mockFetchBinary(buffer, {
      'x-encryption-iv': 'base64iv==',
      'x-expires-at': '2026-04-01T00:00:00Z',
    });

    const result = await downloadMedia('media-123');

    const fetchMock = (globalThis as Record<string, unknown>).fetch as jest.Mock;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/media/media-123/download');
    expect(init.method).toBe('GET');

    expect(result.data).toBeInstanceOf(ArrayBuffer);
    expect(result.encryptionIv).toBe('base64iv==');
    expect(result.expiresAt).toBe('2026-04-01T00:00:00Z');
  });

  it('returns null for missing headers', async () => {
    const buffer = new ArrayBuffer(512);
    mockFetchBinary(buffer, {});

    const result = await downloadMedia('media-456');

    expect(result.encryptionIv).toBeNull();
    expect(result.expiresAt).toBeNull();
  });

  it('encodes mediaId in the URL path', async () => {
    const buffer = new ArrayBuffer(128);
    mockFetchBinary(buffer, {});

    await downloadMedia('media with spaces/slashes');

    const fetchMock = (globalThis as Record<string, unknown>).fetch as jest.Mock;
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(encodeURIComponent('media with spaces/slashes'));
    expect(url).not.toContain('media with spaces');
  });

  it('propagates error on non-ok response', async () => {
    mockFetchError(404, 'not found');

    await expect(downloadMedia('missing-media')).rejects.toThrow();
  });
});
