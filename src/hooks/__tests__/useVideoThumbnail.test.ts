/**
 * Tests for useVideoThumbnail hook — cold-start hydration, delegation to
 * useMediaDownload, and result mapping.
 */

import React from 'react';
import { act, create } from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockGetMedia = jest.fn();
const mockIsDatabaseInitialized = jest.fn();

jest.mock('../../database/repositories/mediaRepository', () => ({
  getMedia: (...args: unknown[]) => mockGetMedia(...args),
}));

jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: () => mockIsDatabaseInitialized(),
}));

// We need the real mediaRowToItem — it's a pure mapper
jest.mock('../../database/repositories/mediaMapper', () => ({
  mediaRowToItem: jest.requireActual('../../database/repositories/mediaMapper').mediaRowToItem,
}));

// Mutable store state + getState().upsertMedia
const mockUpsertMedia = jest.fn();
let mockStoreState: Record<string, Record<string, unknown>> = { media: {} };

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mockStoreState),
    {
      getState: () => ({
        ...mockStoreState,
        upsertMedia: (item: unknown) => {
          mockUpsertMedia(item);
          // Write into the mutable state so re-renders pick it up
          const media = item as { id: string };
          mockStoreState = {
            ...mockStoreState,
            media: { ...mockStoreState.media, [media.id]: item as Record<string, unknown> },
          };
        },
      }),
    },
  ),
}));

// Keyed useMediaDownload mock — returns different results based on mediaId
interface MockDownloadResult {
  downloadState: string;
  localPath: string | null;
  hasKeys: boolean;
  retry: jest.Mock;
}

const mockDefaultDownloadResult: MockDownloadResult = {
  downloadState: 'pending',
  localPath: null,
  hasKeys: false,
  retry: jest.fn(),
};

const mockDownloadResults: Record<string, MockDownloadResult> = {};

jest.mock('../useMediaDownload', () => ({
  useMediaDownload: (id: string | null) => {
    if (!id) return mockDefaultDownloadResult;
    return mockDownloadResults[id] ?? mockDefaultDownloadResult;
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useVideoThumbnail } from '../useVideoThumbnail';
import type { UseVideoThumbnailResult } from '../useVideoThumbnail';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMediaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thumb-1',
    thread_id: 'thread-1',
    reply_id: null,
    message_id: null,
    content_type: 'image/jpeg',
    file_name: 'thumb.jpg',
    file_size: 512,
    width: 320,
    height: 240,
    duration: null,
    attachment_key: new Uint8Array([1, 2, 3]),
    attachment_digest: new Uint8Array([4, 5, 6]),
    cdn_number: 1,
    cdn_key: 'cdn/thumb-1',
    local_path: '/cache/thumb.jpg',
    thumbnail_path: null,
    blur_hash: null,
    expires_at: null,
    download_state: 'downloaded',
    upload_state: 'done',
    created_at: Date.now(),
    thumbnail_media_id: null,
    is_thumbnail: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let hookResult: UseVideoThumbnailResult;

function TestComponent({
  contentType,
  thumbnailMediaId,
}: {
  contentType?: string;
  thumbnailMediaId?: string | null;
}) {
  hookResult = useVideoThumbnail(contentType, thumbnailMediaId);
  return null;
}

function renderHook(
  contentType?: string,
  thumbnailMediaId?: string | null,
) {
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      React.createElement(TestComponent, { contentType, thumbnailMediaId }),
    );
  });
  return renderer!;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockStoreState = { media: {} };
  mockIsDatabaseInitialized.mockReturnValue(true);
  Object.keys(mockDownloadResults).forEach((k) => delete mockDownloadResults[k]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useVideoThumbnail', () => {
  it('returns isVideo=false for non-video content types, no DB probe', () => {
    renderHook('image/jpeg', null);

    expect(hookResult.isVideo).toBe(false);
    expect(hookResult.thumbState).toBe('unavailable');
    expect(hookResult.thumbLocalPath).toBeNull();
    expect(mockGetMedia).not.toHaveBeenCalled();
  });

  it('returns isVideo=false for undefined contentType', () => {
    renderHook(undefined, null);

    expect(hookResult.isVideo).toBe(false);
    expect(mockGetMedia).not.toHaveBeenCalled();
  });

  it('returns unavailable for video with null thumbnailMediaId, no probe', () => {
    renderHook('video/mp4', null);

    expect(hookResult.isVideo).toBe(true);
    expect(hookResult.thumbState).toBe('unavailable');
    expect(hookResult.thumbLocalPath).toBeNull();
    expect(mockGetMedia).not.toHaveBeenCalled();
  });

  it('delegates to useMediaDownload result when thumbnail is in the store (no DB probe)', () => {
    // Put thumbnail in store
    mockStoreState.media['thumb-1'] = {
      id: 'thumb-1',
      contentType: 'image/jpeg',
      downloadState: 'downloaded',
      localPath: '/cache/thumb.jpg',
      hasKeys: true,
    };

    mockDownloadResults['thumb-1'] = {
      downloadState: 'downloaded' as const,
      localPath: '/cache/thumb.jpg',
      hasKeys: true,
      retry: jest.fn(),
    };

    renderHook('video/mp4', 'thumb-1');

    expect(hookResult.isVideo).toBe(true);
    expect(hookResult.thumbState).toBe('downloaded');
    expect(hookResult.thumbLocalPath).toBe('/cache/thumb.jpg');
    expect(mockGetMedia).not.toHaveBeenCalled();
  });

  it('cold-start hydration: probes DB, upserts into store', () => {
    const row = makeMediaRow();
    mockGetMedia.mockReturnValue(row);

    renderHook('video/mp4', 'thumb-1');

    expect(mockGetMedia).toHaveBeenCalledWith('thumb-1');
    expect(mockGetMedia).toHaveBeenCalledTimes(1);
    expect(mockUpsertMedia).toHaveBeenCalledTimes(1);

    // Verify the upserted item was mapped correctly
    const upserted = mockUpsertMedia.mock.calls[0][0];
    expect(upserted.id).toBe('thumb-1');
    expect(upserted.contentType).toBe('image/jpeg');
    expect(upserted.hasKeys).toBe(true);
  });

  it('cold-start miss: getMedia returns null, latches unavailable, called only once', () => {
    mockGetMedia.mockReturnValue(null);

    const renderer = renderHook('video/mp4', 'thumb-1');

    expect(mockGetMedia).toHaveBeenCalledWith('thumb-1');
    expect(mockGetMedia).toHaveBeenCalledTimes(1);
    expect(hookResult.thumbState).toBe('unavailable');
    expect(mockUpsertMedia).not.toHaveBeenCalled();

    // Re-render — probe should NOT fire again
    mockGetMedia.mockClear();
    act(() => {
      renderer.update(
        React.createElement(TestComponent, {
          contentType: 'video/mp4',
          thumbnailMediaId: 'thumb-1',
        }),
      );
    });

    expect(mockGetMedia).not.toHaveBeenCalled();
  });

  it('getMedia throws: returns unavailable, no crash', () => {
    mockGetMedia.mockImplementation(() => {
      throw new Error('DB corruption');
    });

    renderHook('video/mp4', 'thumb-1');

    expect(hookResult.isVideo).toBe(true);
    expect(hookResult.thumbState).toBe('unavailable');
    expect(hookResult.thumbLocalPath).toBeNull();
  });

  it('isDatabaseInitialized false: returns unavailable, getMedia not called', () => {
    mockIsDatabaseInitialized.mockReturnValue(false);

    renderHook('video/mp4', 'thumb-1');

    expect(hookResult.isVideo).toBe(true);
    expect(hookResult.thumbState).toBe('unavailable');
    expect(mockGetMedia).not.toHaveBeenCalled();
  });

  it('hydrated with hasKeys:false returns unavailable', () => {
    // Put thumbnail in store with hasKeys: false
    mockStoreState.media['thumb-1'] = {
      id: 'thumb-1',
      contentType: 'image/jpeg',
      downloadState: 'pending',
      localPath: null,
      hasKeys: false,
    };

    renderHook('video/mp4', 'thumb-1');

    expect(hookResult.isVideo).toBe(true);
    expect(hookResult.thumbState).toBe('unavailable');
    expect(hookResult.thumbLocalPath).toBeNull();
  });
});
