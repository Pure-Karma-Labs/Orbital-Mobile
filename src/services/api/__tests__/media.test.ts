/**
 * Tests for media API functions — uploadChunk, completeUpload, downloadMediaToFile,
 * archiveConfirm.
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

jest.mock('@dr.pogodin/react-native-fs');

import { downloadFile } from '@dr.pogodin/react-native-fs';
import { uploadChunk, completeUpload, downloadMediaToFile, archiveConfirm } from '../media';
import type { UploadChunkParams } from '../media';
import { tokenManager } from '../tokenManager';
import { AuthError, NotFoundError } from '../errors';

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

function mockFetchError(status: number, bodyText = ''): void {
  (globalThis as Record<string, unknown>).fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: jest.fn().mockRejectedValue(new Error('not json')),
    text: jest.fn().mockResolvedValue(bodyText),
  });
}

const sampleUploadParams: UploadChunkParams = {
  mediaId: 'media-123',
  groupId: 'group-456',
  chunkIndex: 0,
  totalChunks: 3,
  chunkFilePath: '/tmp/test-chunk.bin',
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
      media_id: 'media-123',
      chunk_index: 0,
      chunks_received: 1,
      total_chunks: 3,
      progress: '33.33%',
      complete: false,
    });

    const result = await uploadChunk(sampleUploadParams);

    const fetchMock = (globalThis as Record<string, unknown>).fetch as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/media/upload/chunk');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);

    // Verify response is parsed and transformed (snake_case -> camelCase)
    expect(result.mediaId).toBe('media-123');
    expect(result.chunkIndex).toBe(0);
    expect(result.chunksReceived).toBe(1);
    expect(result.totalChunks).toBe(3);
    expect(result.progress).toBe('33.33%');
    expect(result.complete).toBe(false);
  });

  it('includes optional encryptedMetadata and encryptionIv in FormData', async () => {
    mockFetchOk({ media_id: 'media-123', chunk_index: 0, chunks_received: 1, total_chunks: 3, progress: '33.33%', complete: false });

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

  it('includes content_class in FormData when provided', async () => {
    mockFetchOk({ media_id: 'media-123', chunk_index: 0, chunks_received: 1, total_chunks: 3, progress: '33.33%', complete: false });

    const params: UploadChunkParams = {
      ...sampleUploadParams,
      encryptedMetadata: '{"contentType":"video/mp4"}',
      encryptionIv: 'iv==',
      contentClass: 'video',
    };

    await uploadChunk(params);

    const fetchMock = (globalThis as Record<string, unknown>).fetch as jest.Mock;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;

    // Literal snake_case field name is load-bearing: FormData bypasses camelToSnake.
    expect((formData as unknown as { get(k: string): string | null }).get('content_class')).toBe('video');
  });

  it('omits optional fields when not provided', async () => {
    mockFetchOk({ media_id: 'media-123', chunk_index: 0, chunks_received: 1, total_chunks: 3, progress: '33.33%', complete: false });

    await uploadChunk(sampleUploadParams);

    const fetchMock = (globalThis as Record<string, unknown>).fetch as jest.Mock;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;

    expect((formData as unknown as { get(k: string): string | null }).get('encrypted_metadata')).toBeNull();
    expect((formData as unknown as { get(k: string): string | null }).get('encryption_iv')).toBeNull();
    expect((formData as unknown as { get(k: string): string | null }).get('content_class')).toBeNull();
  });

  it('uses 60s timeout', async () => {
    mockFetchOk({ media_id: 'media-123', chunk_index: 0, chunks_received: 1, total_chunks: 3, progress: '33.33%', complete: false });

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
// downloadMediaToFile
// ---------------------------------------------------------------------------
//
// The RNFS transport (retry loop, stall/backstop timers, byte ceiling, abort
// races) is covered by downloadMediaToFile.test.ts. These tests only pin the
// basic request-shape contract.

function mockDownloadFile(
  statusCode: number,
  bytesWritten: number,
  body?: string,
): void {
  (downloadFile as jest.Mock).mockReturnValue({
    jobId: 1,
    promise: Promise.resolve({ jobId: 1, statusCode, bytesWritten, body }),
  });
}

describe('downloadMediaToFile', () => {
  it('builds the URL as /api/media/:id/download and passes it to downloadFile as fromUrl', async () => {
    mockDownloadFile(200, 1024);

    await downloadMediaToFile({ mediaId: 'media-123', toFile: '/tmp/staging.bin' });

    expect(downloadFile).toHaveBeenCalledTimes(1);
    const call = (downloadFile as jest.Mock).mock.calls[0][0] as { fromUrl: string };
    expect(call.fromUrl).toContain('/api/media/media-123/download');
  });

  it('attaches the Authorization: Bearer <token> header', async () => {
    mockDownloadFile(200, 1024);

    await downloadMediaToFile({ mediaId: 'media-123', toFile: '/tmp/staging.bin' });

    const call = (downloadFile as jest.Mock).mock.calls[0][0] as {
      headers: Record<string, string>;
    };
    expect(call.headers.Authorization).toBe('Bearer test-token');
  });

  it('throws AuthError when tokenManager.getAccessToken() resolves null, without calling downloadFile', async () => {
    (tokenManager.getAccessToken as jest.Mock).mockResolvedValueOnce(null);

    await expect(
      downloadMediaToFile({ mediaId: 'media-123', toFile: '/tmp/staging.bin' }),
    ).rejects.toThrow(AuthError);

    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('percent-encodes the mediaId in the URL path', async () => {
    mockDownloadFile(200, 1024);

    await downloadMediaToFile({
      mediaId: 'media with spaces/slashes',
      toFile: '/tmp/staging.bin',
    });

    const call = (downloadFile as jest.Mock).mock.calls[0][0] as { fromUrl: string };
    expect(call.fromUrl).toContain(encodeURIComponent('media with spaces/slashes'));
    expect(call.fromUrl).not.toContain('media with spaces');
  });

  it('maps a non-200 statusCode to NotFoundError', async () => {
    mockDownloadFile(404, 0, 'not found');

    await expect(
      downloadMediaToFile({ mediaId: 'missing-media', toFile: '/tmp/staging.bin' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('returns { bytesWritten } on statusCode 200', async () => {
    mockDownloadFile(200, 2048);

    const result = await downloadMediaToFile({
      mediaId: 'media-123',
      toFile: '/tmp/staging.bin',
    });

    expect(result).toEqual({ bytesWritten: 2048 });
  });
});

// ---------------------------------------------------------------------------
// archiveConfirm
// ---------------------------------------------------------------------------

describe('archiveConfirm', () => {
  it('sends POST to /api/media/:id/archive-confirm with no body', async () => {
    mockFetchOk({
      media_id: 'media-123',
      confirmed_at: '2026-07-21T00:00:00Z',
      status: 'available',
    });

    const result = await archiveConfirm('media-123');

    const fetchMock = (globalThis as Record<string, unknown>).fetch as jest.Mock;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/media/media-123/archive-confirm');
    expect(init.method).toBe('POST');
    // No body for archive-confirm
    expect(init.body).toBeUndefined();

    // Response is parsed and transformed (snake_case -> camelCase)
    expect(result.mediaId).toBe('media-123');
    expect(result.confirmedAt).toBe('2026-07-21T00:00:00Z');
    expect(result.status).toBe('available');
  });

  it('encodes mediaId in the URL path', async () => {
    mockFetchOk({
      media_id: 'special-id',
      confirmed_at: '2026-07-21T00:00:00Z',
      status: 'available',
    });

    await archiveConfirm('special/id');

    const fetchMock = (globalThis as Record<string, unknown>).fetch as jest.Mock;
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(encodeURIComponent('special/id'));
    expect(url).not.toContain('special/id');
  });

  it('propagates error on non-ok response', async () => {
    mockFetchError(404, 'not found');

    await expect(archiveConfirm('missing')).rejects.toThrow();
  });
});
