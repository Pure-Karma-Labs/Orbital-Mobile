/**
 * Tests for useMediaDownload hook — auto-download, retry, cancelOnUnmount,
 * and stale-promise re-trigger.
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
import type { UseMediaDownloadOptions } from '../useMediaDownload';
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

function TestComponent({
  mediaId,
  options,
}: {
  mediaId: string | null;
  options?: UseMediaDownloadOptions;
}) {
  hookResult = useMediaDownload(mediaId, options);
  return null;
}

function renderTestHook(
  mediaId: string | null = 'media-1',
  options?: UseMediaDownloadOptions,
) {
  let root: ReturnType<typeof create>;
  act(() => {
    root = create(
      React.createElement(TestComponent, { mediaId, options }),
    );
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

// ---------------------------------------------------------------------------
// cancelOnUnmount tests
// ---------------------------------------------------------------------------

describe('useMediaDownload — cancelOnUnmount', () => {
  it('aborts queued download on unmount when cancelOnUnmount is true', async () => {
    // Never-resolving download to simulate a queued download
    let capturedSignal: AbortSignal | undefined;
    mockDownloadAndDecryptMedia.mockImplementation(
      (_id: string, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise(() => {});
      },
    );

    const root = renderTestHook('media-1', { cancelOnUnmount: true });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    // Unmount
    act(() => {
      root.unmount();
    });

    expect(capturedSignal!.aborted).toBe(true);
  });

  it('does NOT abort when default options are used and component unmounts', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockDownloadAndDecryptMedia.mockImplementation(
      (_id: string, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise(() => {});
      },
    );

    const root = renderTestHook('media-1');

    expect(capturedSignal).toBeDefined();

    act(() => {
      root.unmount();
    });

    // Without cancelOnUnmount, the download effect cleanup skips abort
    // when downloadingRef.current is true (download in flight)
    expect(capturedSignal!.aborted).toBe(false);
  });

  it('does NOT abort in-flight download on unmount (pins queued-only invariant)', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockDownloadAndDecryptMedia.mockImplementation(
      (_id: string, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise(() => {});
      },
    );

    // Start with pending state (triggers download)
    const root = renderTestHook('media-1', { cancelOnUnmount: true });

    expect(capturedSignal).toBeDefined();

    // Simulate in-flight state: change store to 'downloading', re-render
    mockStoreState = {
      media: {
        'media-1': makeMediaItem({ downloadState: 'downloading' }),
      },
    };

    act(() => {
      root.update(
        React.createElement(TestComponent, {
          mediaId: 'media-1',
          options: { cancelOnUnmount: true },
        }),
      );
    });

    // Unmount while download is in-flight
    act(() => {
      root.unmount();
    });

    // The 'downloading' update re-rendered before unmount, so the download
    // effect re-ran and its cleanup nulled abortRef (skipping abort because
    // downloadingRef was true). By unmount, the cancel effect has no
    // controller left to abort — in-flight downloads are NOT cancelled.
    // (The queued case, where no re-render intervenes before unmount, is
    // pinned by the first test in this describe block: abort DOES fire.)
    expect(capturedSignal!.aborted).toBe(false);
  });

  it('re-triggers download after stale-promise rejection (retryAttempt)', async () => {
    let callCount = 0;
    const controllers: AbortController[] = [];

    mockDownloadAndDecryptMedia.mockImplementation(
      (_id: string, _signal: AbortSignal) => {
        callCount++;
        const ctrl = new AbortController();
        controllers.push(ctrl);

        if (callCount === 1) {
          // First call: reject (simulating joining a stale inflight entry)
          return Promise.reject(new Error('Aborted by another consumer'));
        }
        // Second call: succeed
        return Promise.resolve('/path/to/file.jpg');
      },
    );

    const root = renderTestHook('media-1', { cancelOnUnmount: true });

    // First call triggers immediately
    expect(callCount).toBe(1);

    // Flush microtasks to let the .catch/.finally handlers run
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    // retryAttempt should have bumped, causing a second call
    expect(callCount).toBe(2);

    act(() => {
      root.unmount();
    });
  });

  it('does NOT re-trigger without cancelOnUnmount', async () => {
    let callCount = 0;

    mockDownloadAndDecryptMedia.mockImplementation(() => {
      callCount++;
      return Promise.reject(new Error('Aborted by another consumer'));
    });

    const root = renderTestHook('media-1'); // no cancelOnUnmount

    expect(callCount).toBe(1);

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    // Without cancelOnUnmount, retryAttempt is not bumped
    expect(callCount).toBe(1);

    act(() => {
      root.unmount();
    });
  });
});
