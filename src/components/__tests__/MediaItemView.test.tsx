/**
 * Tests for MediaItemView — onError recovery path + video display.
 *
 * Covers:
 * - Image: first Image onError resets downloadState to pending,
 *   second onError sets downloadState to failed.
 * - Video: loaded/downloading/fallback states, play icon, duration badge,
 *   useMediaDownload called with null, onError targets thumb child.
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

const mockUseMediaDownload = jest.fn((_id: string | null) => mockDownloadResult);

jest.mock('../../hooks/useMediaDownload', () => ({
  useMediaDownload: (id: string | null) => mockUseMediaDownload(id),
}));

const mockUseVideoThumbnail = jest.fn(
  (_contentType?: string, _thumbnailMediaId?: string | null) => ({
    isVideo: false as boolean,
    thumbState: 'unavailable' as string,
    thumbLocalPath: null as string | null,
    retryThumb: jest.fn(),
  }),
);

jest.mock('../../hooks/useVideoThumbnail', () => ({
  useVideoThumbnail: (contentType: string | undefined, thumbnailMediaId: string | null | undefined) =>
    mockUseVideoThumbnail(contentType, thumbnailMediaId),
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
  thumbnailMediaId: null,
  isThumbnail: false,
};

const mockThumbMediaItem = {
  id: 'thumb-1',
  threadId: 'thread-1',
  replyId: null,
  contentType: 'image/jpeg',
  fileName: 'thumb.jpg',
  fileSize: 512,
  width: 320,
  height: 240,
  duration: null,
  blurHash: null,
  localPath: '/cache/thumb.jpg',
  thumbnailPath: null,
  downloadState: 'downloaded' as const,
  uploadState: 'done' as const,
  expiresAt: null,
  hasKeys: true,
  thumbnailMediaId: null,
  isThumbnail: true,
};

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: Object.assign(
    jest.fn((selector: (state: unknown) => unknown) => {
      if (typeof selector === 'function') {
        return selector({
          media: { 'media-1': mockMediaItem, 'thumb-1': mockThumbMediaItem },
        });
      }
      return undefined;
    }),
    {
      getState: jest.fn(() => ({
        media: {
          'media-1': { ...mockMediaItem },
          'thumb-1': { ...mockThumbMediaItem },
        },
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
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { MediaItemView } from '../MediaItemView';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isHost(node: ReactTestInstance): boolean {
  return typeof node.type === 'string';
}

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((node) => isHost(node) && node.props.testID === testID);
  if (found.length === 0) throw new Error(`No element with testID "${testID}"`);
  return found[0];
}

function findAllByTestId(root: ReactTestInstance, testID: string): ReactTestInstance[] {
  return root.findAll((node) => isHost(node) && node.props.testID === testID);
}

function findTextWithContent(
  root: ReactTestInstance,
  text: string,
): ReactTestInstance | undefined {
  return root.findAll(
    (node) =>
      isHost(node) &&
      node.children.map(String).join('').includes(text),
  )[0];
}

function renderMediaItem(
  props: Partial<React.ComponentProps<typeof MediaItemView>> = {},
): ReactTestRenderer {
  const defaults = {
    mediaId: 'media-1',
    width: 200,
    height: 200,
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(MediaItemView, { ...defaults, ...props }),
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
  // Reset to image defaults
  mockUseMediaDownload.mockImplementation((_id: string | null) => mockDownloadResult);
  mockUseVideoThumbnail.mockReturnValue({
    isVideo: false,
    thumbState: 'unavailable' as const,
    thumbLocalPath: null,
    retryThumb: jest.fn(),
  });
});

// ---------------------------------------------------------------------------
// Image tests — existing behavior
// ---------------------------------------------------------------------------

describe('MediaItemView — image (onError recovery)', () => {
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

    expect(mockUpsertMedia).toHaveBeenCalledTimes(1);
    expect(mockUpsertMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'media-1',
        downloadState: 'pending',
        localPath: null,
      }),
    );
    expect(mockUpdateMediaDownloadState).not.toHaveBeenCalled();
  });

  it('second onError sets downloadState to failed via updateMediaDownloadState', () => {
    const renderer = renderMediaItem();
    const image = renderer.root.findByType(Image);

    act(() => {
      image.props.onError();
    });

    act(() => {
      image.props.onError();
    });

    expect(mockUpdateMediaDownloadState).toHaveBeenCalledTimes(1);
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith('media-1', 'failed');
  });
});

// ---------------------------------------------------------------------------
// Video tests
// ---------------------------------------------------------------------------

describe('MediaItemView — video display', () => {
  it('video-loaded: renders thumbnail Image with file:// path, play icon, badge', () => {
    mockUseVideoThumbnail.mockReturnValue({
      isVideo: true,
      thumbState: 'downloaded' as const,
      thumbLocalPath: '/cache/thumb.jpg',
      retryThumb: jest.fn(),
    });

    const renderer = renderMediaItem({
      contentType: 'video/mp4',
      durationMs: 42_000,
      thumbnailMediaId: 'thumb-1',
    });

    // testID
    findByTestId(renderer.root, 'media-item-media-1-video-loaded');

    // One Image with the THUMBNAIL path, not the parent
    const images = renderer.root.findAllByType(Image);
    expect(images).toHaveLength(1);
    expect(images[0].props.source).toEqual({ uri: 'file:///cache/thumb.jpg' });

    // Play icon present
    expect(findAllByTestId(renderer.root, 'play-icon-overlay')).toHaveLength(1);

    // Duration badge with "0:42"
    expect(findTextWithContent(renderer.root, '0:42')).toBeDefined();

    // useMediaDownload called with null (suppression)
    expect(mockUseMediaDownload).toHaveBeenCalledWith(null);
  });

  it('video-downloading: shows spinner + play icon, zero Image nodes', () => {
    mockUseVideoThumbnail.mockReturnValue({
      isVideo: true,
      thumbState: 'downloading' as const,
      thumbLocalPath: null,
      retryThumb: jest.fn(),
    });

    const renderer = renderMediaItem({
      contentType: 'video/mp4',
      durationMs: 42_000,
      thumbnailMediaId: 'thumb-1',
    });

    findByTestId(renderer.root, 'media-item-media-1-video-downloading');
    expect(renderer.root.findAllByType(Image)).toHaveLength(0);
    expect(findAllByTestId(renderer.root, 'play-icon-overlay')).toHaveLength(1);
  });

  it('video with null thumbnailMediaId: shows fallback, zero Image nodes', () => {
    mockUseVideoThumbnail.mockReturnValue({
      isVideo: true,
      thumbState: 'unavailable' as const,
      thumbLocalPath: null,
      retryThumb: jest.fn(),
    });

    const renderer = renderMediaItem({
      contentType: 'video/mp4',
      durationMs: 42_000,
      thumbnailMediaId: null,
    });

    findByTestId(renderer.root, 'media-item-media-1-video-fallback');
    expect(renderer.root.findAllByType(Image)).toHaveLength(0);
    expect(findAllByTestId(renderer.root, 'play-icon-overlay')).toHaveLength(1);
  });

  it('video with null durationMs: no badge rendered', () => {
    mockUseVideoThumbnail.mockReturnValue({
      isVideo: true,
      thumbState: 'downloaded' as const,
      thumbLocalPath: '/cache/thumb.jpg',
      retryThumb: jest.fn(),
    });

    const renderer = renderMediaItem({
      contentType: 'video/mp4',
      durationMs: null,
      thumbnailMediaId: 'thumb-1',
    });

    expect(findAllByTestId(renderer.root, 'duration-badge')).toHaveLength(0);
  });

  it('tap fires onPress for video items', () => {
    mockUseVideoThumbnail.mockReturnValue({
      isVideo: true,
      thumbState: 'downloaded' as const,
      thumbLocalPath: '/cache/thumb.jpg',
      retryThumb: jest.fn(),
    });

    const onPress = jest.fn();
    const renderer = renderMediaItem({
      contentType: 'video/mp4',
      durationMs: 42_000,
      thumbnailMediaId: 'thumb-1',
      onPress,
    });

    findByTestId(renderer.root, 'media-item-media-1-video-loaded');
    act(() => {
      const pressable = renderer.root.findAll(
        (n) => n.props.onPress === onPress,
      )[0];
      pressable.props.onPress();
    });

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('onError twice on video thumb targets thumbnail child, not parent', () => {
    mockUseVideoThumbnail.mockReturnValue({
      isVideo: true,
      thumbState: 'downloaded' as const,
      thumbLocalPath: '/cache/thumb.jpg',
      retryThumb: jest.fn(),
    });

    const renderer = renderMediaItem({
      mediaId: 'video-parent',
      contentType: 'video/mp4',
      durationMs: 42_000,
      thumbnailMediaId: 'thumb-1',
    });

    const image = renderer.root.findByType(Image);

    // First error — should upsert the THUMB child
    act(() => {
      image.props.onError();
    });
    expect(mockUpsertMedia).toHaveBeenCalledTimes(1);
    expect(mockUpsertMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'thumb-1',
        downloadState: 'pending',
        localPath: null,
      }),
    );

    // Second error — should updateMediaDownloadState on the THUMB child
    act(() => {
      image.props.onError();
    });
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith('thumb-1', 'failed');
  });
});
