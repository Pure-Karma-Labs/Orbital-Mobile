/**
 * Tests for useMediaDownload hook — auto-download, retry, and cleanup.
 */

import React from 'react';
import { act, create } from 'react-test-renderer';

const mockDownloadAndDecryptMedia = jest.fn();
const mockRetryDownload = jest.fn();

jest.mock('../../services/mediaDownloadService', () => ({
  downloadAndDecryptMedia: (...args: unknown[]) =>
    mockDownloadAndDecryptMedia(...args),
  retryDownload: (...args: unknown[]) => mockRetryDownload(...args),
}));

// Mock Zustand store with selector support
let mockStoreState: Record<string, unknown> = {};

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mockStoreState),
}));

import { useMediaDownload } from '../useMediaDownload';
import type { MediaItem } from '../../types/store';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media-1',
    threadId: 'thread-1',
    replyId: null,
    contentType: 'image/jpeg',
    fileName: 'photo.jpg',
    fileSize: 1000,
    width: 640,
    height: 480,
    duration: null,
    blurHash: null,
    localPath: null,
    thumbnailPath: null,
    downloadState: 'pending',
    uploadState: 'done',
    expiresAt: null,
    hasKeys: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test harness — mirrors useMediaPicker.test.ts pattern
// ---------------------------------------------------------------------------

let hookResult: ReturnType<typeof useMediaDownload>;

function TestComponent({ mediaId }: { mediaId: string | null }) {
  hookResult = useMediaDownload(mediaId);
  return null;
}

function renderTestHook(mediaId: string | null = 'media-1') {
  let root: ReturnType<typeof create>;
  act(() => {
    root = create(React.createElement(TestComponent, { mediaId }));
  });
  return root!;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockDownloadAndDecryptMedia.mockResolvedValue('/path/to/file.jpg');
  mockRetryDownload.mockResolvedValue('/path/to/file.jpg');
  mockStoreState = {
    media: {
      'media-1': makeMediaItem(),
    },
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMediaDownload', () => {
  it('returns default state for null mediaId', () => {
    renderTestHook(null);

    expect(hookResult.downloadState).toBe('pending');
    expect(hookResult.localPath).toBeNull();
    expect(hookResult.hasKeys).toBe(false);
  });

  it('returns item state from store', () => {
    mockStoreState = {
      media: {
        'media-1': makeMediaItem({
          downloadState: 'downloaded',
          localPath: '/path/to/file.jpg',
          hasKeys: true,
        }),
      },
    };

    renderTestHook('media-1');

    expect(hookResult.downloadState).toBe('downloaded');
    expect(hookResult.localPath).toBe('/path/to/file.jpg');
    expect(hookResult.hasKeys).toBe(true);
  });

  it('auto-triggers download when pending and has keys', () => {
    renderTestHook('media-1');

    expect(mockDownloadAndDecryptMedia).toHaveBeenCalledWith(
      'media-1',
      expect.any(AbortSignal),
    );
  });

  it('does not auto-trigger when item has no keys', () => {
    mockStoreState = {
      media: {
        'media-1': makeMediaItem({ hasKeys: false }),
      },
    };

    renderTestHook('media-1');

    expect(mockDownloadAndDecryptMedia).not.toHaveBeenCalled();
  });

  it('does not auto-trigger when already downloaded', () => {
    mockStoreState = {
      media: {
        'media-1': makeMediaItem({ downloadState: 'downloaded' }),
      },
    };

    renderTestHook('media-1');

    expect(mockDownloadAndDecryptMedia).not.toHaveBeenCalled();
  });

  it('retry() calls retryDownload', () => {
    mockStoreState = {
      media: {
        'media-1': makeMediaItem({ downloadState: 'failed' }),
      },
    };

    renderTestHook('media-1');

    act(() => {
      hookResult.retry();
    });

    expect(mockRetryDownload).toHaveBeenCalledWith(
      'media-1',
      expect.any(AbortSignal),
    );
  });
});
