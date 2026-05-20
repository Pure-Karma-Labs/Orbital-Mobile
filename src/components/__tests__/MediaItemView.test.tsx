/**
 * Tests for MediaItemView — onError recovery path.
 *
 * Covers: first Image onError resets downloadState to pending,
 * second onError sets downloadState to failed.
 */

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports
// ---------------------------------------------------------------------------

const mockRetry = jest.fn();

const mockDownloadResult = {
  downloadState: 'downloaded' as const,
  localPath: '/cache/photo.jpg',
  hasKeys: true,
  retry: mockRetry,
};

jest.mock('../../hooks/useMediaDownload', () => ({
  useMediaDownload: jest.fn(() => mockDownloadResult),
}));

const mockUpdateMediaDownloadState = jest.fn();
const mockUpsertMedia = jest.fn();

const mockMediaItem = {
  id: 'media-1',
  threadId: 'thread-1',
  replyId: null,
  contentType: 'image/jpeg',
  fileName: 'photo.jpg',
  fileSize: 2048,
  width: 640,
  height: 480,
  duration: null,
  blurHash: null,
  localPath: '/cache/photo.jpg',
  thumbnailPath: null,
  downloadState: 'downloaded' as const,
  uploadState: 'done' as const,
  expiresAt: null,
  hasKeys: true,
};

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: Object.assign(
    jest.fn((selector: (state: unknown) => unknown) => {
      // Support the reactive selector in useMediaDownload (not used here since
      // useMediaDownload is mocked, but required for module evaluation)
      if (typeof selector === 'function') {
        return selector({ media: { 'media-1': mockMediaItem } });
      }
      return undefined;
    }),
    {
      getState: jest.fn(() => ({
        media: { 'media-1': { ...mockMediaItem } },
        updateMediaDownloadState: mockUpdateMediaDownloadState,
        upsertMedia: mockUpsertMedia,
      })),
    },
  ),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import React from 'react';
import { Image } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { MediaItemView } from '../MediaItemView';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderMediaItem(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(MediaItemView, {
          mediaId: 'media-1',
          width: 200,
          height: 200,
        }),
      ),
    );
  });
  return renderer;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaItemView — onError recovery', () => {
  it('renders an Image when downloaded with a localPath', () => {
    const renderer = renderMediaItem();
    const images = renderer.root.findAllByType(Image);
    expect(images).toHaveLength(1);
    expect(images[0].props.source).toEqual({ uri: 'file:///cache/photo.jpg' });
  });

  it('first onError resets downloadState to pending via upsertMedia', () => {
    const renderer = renderMediaItem();
    const image = renderer.root.findByType(Image);

    act(() => {
      image.props.onError();
    });

    // First error should call upsertMedia with pending state
    expect(mockUpsertMedia).toHaveBeenCalledTimes(1);
    expect(mockUpsertMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'media-1',
        downloadState: 'pending',
        localPath: null,
      }),
    );
    // Should NOT call updateMediaDownloadState (that is the second-error path)
    expect(mockUpdateMediaDownloadState).not.toHaveBeenCalled();
  });

  it('second onError sets downloadState to failed via updateMediaDownloadState', () => {
    const renderer = renderMediaItem();
    const image = renderer.root.findByType(Image);

    // Fire first error
    act(() => {
      image.props.onError();
    });

    // Fire second error on the same instance (ref counter is now 1)
    act(() => {
      image.props.onError();
    });

    // Second error triggers updateMediaDownloadState('media-1', 'failed')
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledTimes(1);
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith('media-1', 'failed');
  });
});
