/**
 * Tests for video playback in MediaLightbox (#458 PR 3).
 *
 * Covers the pieces that are load-bearing for correctness rather than looks:
 * - the active-page gate (only the page you are looking at downloads/plays)
 * - the ActiveVideoPage state machine, including the store-miss vs keyless split
 * - the content-escape props being pinned off
 * - the terminal (no-retry) player error path
 * - the shipped scrubber-vs-paging variant, and that it never disables paging
 */

import React from 'react';
import { Platform, Dimensions } from 'react-native';
import {
  act,
  create,
  type ReactTestRenderer,
  type ReactTestInstance,
} from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { MediaLightbox } from '../MediaLightbox';
import { LightboxVideoPage } from '../LightboxVideoPage';
import type { MediaItem } from '../../types/store';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));

const mockRetry = jest.fn();

type DownloadResult = {
  downloadState: string;
  localPath: string | null;
  hasKeys: boolean;
  retry: () => void;
};

/** mediaId -> download state. Anything unlisted resolves to a pending image. */
let downloadByMediaId: Record<string, Partial<DownloadResult>> = {};

const mockUseMediaDownload = jest.fn(
  (mediaId: string | null): DownloadResult => ({
    downloadState: 'pending',
    localPath: null,
    hasKeys: true,
    retry: mockRetry,
    ...(mediaId != null ? downloadByMediaId[mediaId] : undefined),
  }),
);

jest.mock('../../hooks/useMediaDownload', () => ({
  useMediaDownload: (...args: unknown[]) =>
    mockUseMediaDownload(args[0] as string | null),
}));

const mockUseVideoThumbnail = jest.fn((contentType?: string) => ({
  isVideo: contentType?.startsWith('video/') ?? false,
  thumbState: 'downloaded' as const,
  thumbLocalPath: '/cache/thumb.jpg',
  retryThumb: jest.fn(),
}));

jest.mock('../../hooks/useVideoThumbnail', () => ({
  useVideoThumbnail: (...args: unknown[]) =>
    mockUseVideoThumbnail(args[0] as string | undefined),
}));

const mockOpenReportSheet = jest.fn();
let mockStoreMedia: Record<string, Partial<MediaItem>> = {};

jest.mock('../../stores/useAppStore', () => {
  const getState = () => ({
    openReportSheet: mockOpenReportSheet,
    media: mockStoreMedia,
  });
  return {
    useAppStore: Object.assign(
      (selector: (s: unknown) => unknown) => selector(getState()),
      { getState },
    ),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE: MediaItem = {
  id: 'x',
  threadId: 't-1',
  replyId: null,
  contentType: 'image/jpeg',
  fileName: 'photo.jpg',
  fileSize: 1024,
  width: 800,
  height: 600,
  duration: null,
  blurHash: null,
  localPath: null,
  thumbnailPath: null,
  downloadState: 'pending',
  uploadState: 'done',
  expiresAt: null,
  hasKeys: true,
  thumbnailMediaId: null,
  isThumbnail: false,
};

function imageItem(id: string): MediaItem {
  return { ...BASE, id, contentType: 'image/jpeg', fileName: `${id}.jpg` };
}

function videoItem(id: string): MediaItem {
  return {
    ...BASE,
    id,
    contentType: 'video/mp4',
    fileName: `${id}.mp4`,
    fileSize: 25_500_000,
    duration: 42_000,
    thumbnailMediaId: `thumb-${id}`,
  };
}

/** Tracked so afterEach can unmount — OrbitalSpinner's recursive timing keeps
 *  scheduling animation frames past teardown otherwise. */
let mounted: ReactTestRenderer | null = null;

function renderLightbox(
  props: Partial<React.ComponentProps<typeof MediaLightbox>> = {},
): ReactTestRenderer {
  const defaults = {
    visible: true,
    mediaItems: [imageItem('img-0')],
    initialIndex: 0,
    onClose: jest.fn(),
  };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(MediaLightbox, { ...defaults, ...props }),
      ),
    );
  });
  mounted = renderer;
  return renderer;
}

function update(
  renderer: ReactTestRenderer,
  props: Partial<React.ComponentProps<typeof MediaLightbox>>,
): void {
  const defaults = {
    visible: true,
    mediaItems: [imageItem('img-0')],
    initialIndex: 0,
    onClose: jest.fn(),
  };
  act(() => {
    renderer.update(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(MediaLightbox, { ...defaults, ...props }),
      ),
    );
  });
}

/**
 * Host nodes only — a composite element carries the same testID/children prop,
 * so an unfiltered findAll double-counts every match.
 *
 * The mock renders the host element literally named 'Video'; the cast is needed
 * because ReactTestInstance['type'] is ElementType, which excludes arbitrary
 * host strings.
 */
function videoNodes(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((n) => (n.type as unknown) === 'Video');
}

function byTestId(root: ReactTestInstance, testID: string): ReactTestInstance[] {
  return root.findAll(
    (n) => typeof n.type === 'string' && n.props.testID === testID,
  );
}

/** Composite pressable — the host View underneath carries no onPress. */
function pressableByTestId(
  root: ReactTestInstance,
  testID: string,
): ReactTestInstance {
  return root.findAll(
    (n) => n.props.testID === testID && typeof n.props.onPress === 'function',
  )[0];
}

function textNodesContaining(
  root: ReactTestInstance,
  needle: string,
): ReactTestInstance[] {
  return root.findAll(
    (n) =>
      typeof n.type === 'string' &&
      typeof n.children?.[0] === 'string' &&
      n.children[0].includes(needle),
  );
}

function scrollView(root: ReactTestInstance): ReactTestInstance {
  return root.findAll((n) => n.props.onMomentumScrollEnd != null)[0];
}

const SCREEN_WIDTH = Dimensions.get('window').width;

beforeEach(() => {
  jest.clearAllMocks();
  downloadByMediaId = {};
  mockStoreMedia = {};
});

afterEach(() => {
  if (mounted) {
    const renderer = mounted;
    mounted = null;
    act(() => {
      renderer.unmount();
    });
  }
});

// ---------------------------------------------------------------------------
// 1. Active-page gating
// ---------------------------------------------------------------------------

describe('active-page gating', () => {
  it('mounts the player for the active video page and downloads the real id', () => {
    mockStoreMedia = { 'video-1': videoItem('video-1') };
    downloadByMediaId = {
      'video-1': { downloadState: 'downloaded', localPath: '/media/video-1.mp4' },
    };

    const renderer = renderLightbox({
      mediaItems: [videoItem('video-1'), imageItem('img-2')],
      initialIndex: 0,
    });

    expect(videoNodes(renderer.root).length).toBe(1);

    // The REAL media id — the old null-suppression pattern would never download.
    const ids = mockUseMediaDownload.mock.calls.map((c) => c[0]);
    expect(ids).toContain('video-1');
  });

  it('renders a poster (and never downloads) for a non-active neighbour video', () => {
    mockStoreMedia = { 'video-1': videoItem('video-1') };

    const renderer = renderLightbox({
      mediaItems: [imageItem('img-0'), videoItem('video-1')],
      initialIndex: 0,
    });

    // Neighbour page is mounted (windowing) but only as a poster.
    expect(byTestId(renderer.root, 'lightbox-video-poster-video-1').length).toBe(1);
    expect(videoNodes(renderer.root).length).toBe(0);

    const ids = mockUseMediaDownload.mock.calls.map((c) => c[0]);
    expect(ids).not.toContain('video-1');
  });

  it('mounts no player at all while the lightbox is closed', () => {
    mockStoreMedia = { 'video-1': videoItem('video-1') };
    downloadByMediaId = {
      'video-1': { downloadState: 'downloaded', localPath: '/media/video-1.mp4' },
    };

    const renderer = renderLightbox({
      mediaItems: [videoItem('video-1')],
      initialIndex: 0,
      visible: false,
    });

    expect(videoNodes(renderer.root).length).toBe(0);
    expect(byTestId(renderer.root, 'lightbox-video-video-1').length).toBe(0);
  });

  it('unmounts the player on isActive=false even with the page still rendered', () => {
    // Defence in depth for the iOS-Modal-keeps-children case: the assertion
    // above can be satisfied by RN's Modal returning null when !visible, so
    // exercise the isActive gate directly on the page component.
    mockStoreMedia = { 'video-1': videoItem('video-1') };
    downloadByMediaId = {
      'video-1': { downloadState: 'downloaded', localPath: '/media/video-1.mp4' },
    };

    let renderer!: ReactTestRenderer;
    const render = (isActive: boolean) =>
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(LightboxVideoPage, {
          mediaId: 'video-1',
          pageWidth: 390,
          pageHeight: 844,
          contentType: 'video/mp4',
          thumbnailMediaId: 'thumb-video-1',
          durationMs: 42_000,
          isActive,
        }),
      );

    act(() => {
      renderer = create(render(true));
    });
    expect(videoNodes(renderer.root).length).toBe(1);

    act(() => {
      renderer.update(render(false));
    });
    expect(videoNodes(renderer.root).length).toBe(0);
    expect(byTestId(renderer.root, 'lightbox-video-poster-video-1').length).toBe(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('unmounts the player when the user swipes to an image page', () => {
    mockStoreMedia = { 'video-1': videoItem('video-1') };
    downloadByMediaId = {
      'video-1': { downloadState: 'downloaded', localPath: '/media/video-1.mp4' },
    };

    const items = [videoItem('video-1'), imageItem('img-2')];
    const renderer = renderLightbox({ mediaItems: items, initialIndex: 0 });
    expect(videoNodes(renderer.root).length).toBe(1);

    act(() => {
      scrollView(renderer.root).props.onMomentumScrollEnd({
        nativeEvent: { contentOffset: { x: SCREEN_WIDTH } },
      });
    });

    expect(videoNodes(renderer.root).length).toBe(0);
    expect(byTestId(renderer.root, 'lightbox-video-poster-video-1').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Player props
// ---------------------------------------------------------------------------

describe('player props', () => {
  beforeEach(() => {
    mockStoreMedia = { 'video-1': videoItem('video-1') };
    downloadByMediaId = {
      'video-1': { downloadState: 'downloaded', localPath: '/media/video-1.mp4' },
    };
  });

  it('plays the local file with native controls, paused, no content escape', () => {
    const renderer = renderLightbox({
      mediaItems: [videoItem('video-1')],
      initialIndex: 0,
    });

    const video = videoNodes(renderer.root)[0];
    expect(video.props.source).toEqual({ uri: 'file:///media/video-1.mp4' });
    expect(video.props.controls).toBe(true);
    // No autoplay.
    expect(video.props.paused).toBe(true);
    expect(video.props.resizeMode).toBe('contain');
    // Content-escape surface pinned off.
    expect(video.props.allowsExternalPlayback).toBe(false);
    expect(video.props.playInBackground).toBe(false);
    expect(video.props.playWhenInactive).toBe(false);
    expect(video.props.showNotificationControls).toBe(false);
    expect(video.props.ignoreSilentSwitch).toBe('ignore');
    expect(video.props.mixWithOthers).toBe('duck');
    expect(video.props.testID).toBe('lightbox-video-video-1');
  });

  it('mirrors native transport state into paused', () => {
    const renderer = renderLightbox({
      mediaItems: [videoItem('video-1')],
      initialIndex: 0,
    });

    act(() => {
      videoNodes(renderer.root)[0].props.onPlaybackStateChanged({
        isPlaying: true,
        isSeeking: false,
      });
    });
    expect(videoNodes(renderer.root)[0].props.paused).toBe(false);

    act(() => {
      videoNodes(renderer.root)[0].props.onPlaybackStateChanged({
        isPlaying: false,
        isSeeking: false,
      });
    });
    expect(videoNodes(renderer.root)[0].props.paused).toBe(true);
  });

  it('ignores seek transitions — the Android buffering dip must not latch paused (PR #652 review)', () => {
    const renderer = renderLightbox({
      mediaItems: [videoItem('video-1')],
      initialIndex: 0,
    });

    // Start playback via native controls
    act(() => {
      videoNodes(renderer.root)[0].props.onPlaybackStateChanged({
        isPlaying: true,
        isSeeking: false,
      });
    });
    expect(videoNodes(renderer.root)[0].props.paused).toBe(false);

    // media3 emits {isPlaying:false, isSeeking:true} during the
    // STATE_BUFFERING pass of every native-scrubber seek. Echoing it into
    // the controlled `paused` prop would setPlayWhenReady(false) and stop
    // playback after every Android scrub.
    act(() => {
      videoNodes(renderer.root)[0].props.onPlaybackStateChanged({
        isPlaying: false,
        isSeeking: true,
      });
    });
    expect(videoNodes(renderer.root)[0].props.paused).toBe(false);
  });

  it('drops the poster overlay once the first frame is ready', () => {
    const renderer = renderLightbox({
      mediaItems: [videoItem('video-1')],
      initialIndex: 0,
    });

    expect(
      byTestId(renderer.root, 'lightbox-video-poster-overlay-video-1').length,
    ).toBe(1);

    act(() => {
      videoNodes(renderer.root)[0].props.onReadyForDisplay();
    });

    expect(
      byTestId(renderer.root, 'lightbox-video-poster-overlay-video-1').length,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. State machine
// ---------------------------------------------------------------------------

describe('ActiveVideoPage state machine', () => {
  it('shows a spinner and a static size label while downloading', () => {
    mockStoreMedia = { 'video-1': videoItem('video-1') };
    downloadByMediaId = { 'video-1': { downloadState: 'downloading' } };

    const renderer = renderLightbox({
      mediaItems: [videoItem('video-1')],
      initialIndex: 0,
    });

    expect(byTestId(renderer.root, 'lightbox-video-downloading-video-1').length).toBe(1);
    expect(textNodesContaining(renderer.root, 'Downloading · ').length).toBe(1);
    expect(textNodesContaining(renderer.root, '24 MB').length).toBe(1);
    expect(videoNodes(renderer.root).length).toBe(0);
  });

  it('shows the keyless placeholder copy when the item has no keys', () => {
    mockStoreMedia = { 'video-1': videoItem('video-1') };
    downloadByMediaId = { 'video-1': { hasKeys: false } };

    const renderer = renderLightbox({
      mediaItems: [videoItem('video-1')],
      initialIndex: 0,
    });

    expect(byTestId(renderer.root, 'lightbox-video-locked-video-1').length).toBe(1);
    expect(textNodesContaining(renderer.root, '[locked]').length).toBe(1);
    expect(textNodesContaining(renderer.root, 'Encrypted').length).toBe(1);
  });

  it('treats a store miss as pending, NOT as keyless', () => {
    // No mockStoreMedia entry at all, and the hook's default for a missing item is
    // hasKeys:false — which must not be read as "encrypted".
    downloadByMediaId = { 'video-1': { hasKeys: false } };

    const renderer = renderLightbox({
      mediaItems: [videoItem('video-1')],
      initialIndex: 0,
    });

    expect(byTestId(renderer.root, 'lightbox-video-pending-video-1').length).toBe(1);
    expect(byTestId(renderer.root, 'lightbox-video-locked-video-1').length).toBe(0);
  });

  it('offers retry on a failed download and calls the hook retry', () => {
    mockStoreMedia = { 'video-1': videoItem('video-1') };
    downloadByMediaId = { 'video-1': { downloadState: 'failed' } };

    const renderer = renderLightbox({
      mediaItems: [videoItem('video-1')],
      initialIndex: 0,
    });

    expect(byTestId(renderer.root, 'lightbox-video-failed-video-1').length).toBe(1);
    const failed = pressableByTestId(renderer.root, 'lightbox-video-failed-video-1');
    expect(failed).toBeDefined();

    act(() => {
      failed.props.onPress();
    });
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it('reports an unavailable video as no longer available', () => {
    mockStoreMedia = { 'video-1': videoItem('video-1') };
    downloadByMediaId = { 'video-1': { downloadState: 'unavailable' } };

    const renderer = renderLightbox({
      mediaItems: [videoItem('video-1')],
      initialIndex: 0,
    });

    expect(byTestId(renderer.root, 'lightbox-video-unavailable-video-1').length).toBe(1);
    expect(textNodesContaining(renderer.root, 'No longer available').length).toBe(1);
  });

  it('is terminal on the FIRST player error and never retries the download', () => {
    mockStoreMedia = { 'video-1': videoItem('video-1') };
    downloadByMediaId = {
      'video-1': { downloadState: 'downloaded', localPath: '/media/video-1.mp4' },
    };

    const renderer = renderLightbox({
      mediaItems: [videoItem('video-1')],
      initialIndex: 0,
    });

    act(() => {
      videoNodes(renderer.root)[0].props.onError({
        error: { errorString: 'decode failed' },
      });
    });

    expect(byTestId(renderer.root, 'lightbox-video-error-video-1').length).toBe(1);
    expect(textNodesContaining(renderer.root, "Couldn't play this video").length).toBe(1);
    // Player gone, poster overlay gone, and crucially no download retry —
    // retryDownload() cannot clear local_path, so it would spin forever.
    expect(videoNodes(renderer.root).length).toBe(0);
    expect(
      byTestId(renderer.root, 'lightbox-video-poster-overlay-video-1').length,
    ).toBe(0);
    expect(mockRetry).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Scrubber vs paging — shipped variant
// ---------------------------------------------------------------------------

describe('scrubber vs paging', () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    (Platform as { OS: string }).OS = originalOS;
  });

  it('stops the iOS paging ScrollView from stealing scrubber drags', () => {
    (Platform as { OS: string }).OS = 'ios';
    mockStoreMedia = { 'video-1': videoItem('video-1') };
    downloadByMediaId = {
      'video-1': { downloadState: 'downloaded', localPath: '/media/video-1.mp4' },
    };

    const renderer = renderLightbox({
      mediaItems: [videoItem('video-1'), imageItem('img-2')],
      initialIndex: 0,
    });

    expect(scrollView(renderer.root).props.canCancelContentTouches).toBe(false);
  });

  it('leaves the Android ScrollView untouched (DefaultTimeBar claims the gesture)', () => {
    (Platform as { OS: string }).OS = 'android';
    mockStoreMedia = { 'video-1': videoItem('video-1') };
    downloadByMediaId = {
      'video-1': { downloadState: 'downloaded', localPath: '/media/video-1.mp4' },
    };

    const renderer = renderLightbox({
      mediaItems: [videoItem('video-1'), imageItem('img-2')],
      initialIndex: 0,
    });

    expect(scrollView(renderer.root).props.canCancelContentTouches).toBeUndefined();
  });

  it('never disables paging — including the round-2 stale-latch scenarios', () => {
    (Platform as { OS: string }).OS = 'ios';
    mockStoreMedia = { 'video-1': videoItem('video-1') };
    downloadByMediaId = {
      'video-1': { downloadState: 'downloaded', localPath: '/media/video-1.mp4' },
    };

    const withVideo = [videoItem('video-1'), imageItem('img-2')];
    const renderer = renderLightbox({ mediaItems: withVideo, initialIndex: 0 });

    // (a) while a downloaded video page is active
    expect(scrollView(renderer.root).props.scrollEnabled).toBeUndefined();

    // (b) after paging on to an image
    act(() => {
      scrollView(renderer.root).props.onMomentumScrollEnd({
        nativeEvent: { contentOffset: { x: SCREEN_WIDTH } },
      });
    });
    expect(scrollView(renderer.root).props.scrollEnabled).toBeUndefined();

    // (c) after closing — RN's Modal renders nothing, so there is no paging
    // surface left to hold a stale latch
    update(renderer, { mediaItems: withVideo, initialIndex: 0, visible: false });
    expect(
      renderer.root.findAll((n) => n.props.onMomentumScrollEnd != null).length,
    ).toBe(0);

    // (d) after reopening on an all-image gallery
    update(renderer, {
      mediaItems: [imageItem('img-9'), imageItem('img-10')],
      initialIndex: 0,
      visible: true,
    });
    expect(scrollView(renderer.root).props.scrollEnabled).toBeUndefined();
  });
});
