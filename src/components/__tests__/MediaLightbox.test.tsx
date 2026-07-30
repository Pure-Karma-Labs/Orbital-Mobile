/**
 * Tests for MediaLightbox — report button platform branching and windowed rendering.
 *
 * Verifies:
 * - Android: tapping report calls openReportSheet directly (via InteractionManager)
 * - iOS: tapping report stashes pending target; onDismiss triggers openReportSheet
 * - Windowing: only pages within +/-1 of currentIndex are mounted (LightboxPage for
 *   images, LightboxVideoPage for videos)
 * - onMomentumScrollEnd shifts the window
 * - Arrow press shifts the window
 * - Reopen at new initialIndex mounts the correct window in the same commit
 * - useMediaDownload is only invoked for windowed mediaIds
 * - Video pages: LightboxPage is image-only; video items render LightboxVideoPage,
 *   which mounts ActiveVideoPage (real download, no suppression) when active and
 *   VideoPoster (thumbnail only) when not
 */

import React from 'react';
import { Platform, Dimensions } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { MediaLightbox } from '../MediaLightbox';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));

/**
 * MediaLightbox mounts a GestureHandlerRootView inside the Modal (#662 — an
 * Android Modal is a separate window, so App.tsx's root does not reach in), and
 * the video overlay it hosts builds Pan/Tap gestures. The real module's native
 * spec throws under Jest, so stub the surface: chainable builders that return
 * themselves, and a root view that forwards its style (it IS the backdrop).
 */
jest.mock('react-native-gesture-handler', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');

  const makeChainable = (methods: string[]): Record<string, () => unknown> => {
    const stub: Record<string, () => unknown> = {};
    for (const method of methods) {
      stub[method] = () => stub;
    }
    return stub;
  };

  const panChainable = makeChainable([
    'activeOffsetX',
    'failOffsetY',
    'runOnJS',
    'onBegin',
    'onStart',
    'onUpdate',
    'onFinalize',
    'blocksExternalGesture',
  ]);
  const tapChainable = makeChainable(['onEnd', 'runOnJS']);

  return {
    Gesture: {
      Pan: () => panChainable,
      Tap: () => tapChainable,
      Native: () => makeChainable([]),
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    GestureHandlerRootView: ({
      children,
      style,
    }: {
      children?: React.ReactNode;
      style?: unknown;
    }) =>
      ReactActual.createElement(
        View,
        { style, testID: 'lightbox-gesture-root' },
        children,
      ),
  };
});

// react-native-video is auto-mocked via __mocks__/react-native-video.ts (root
// __mocks__ for a node_module is auto-resolved by Jest — no jest.mock call).

type DownloadState = 'pending' | 'downloading' | 'downloaded' | 'failed' | 'unavailable';

interface MockDownloadResult {
  downloadState: DownloadState;
  localPath: string | null;
  hasKeys: boolean;
  retry: jest.Mock;
}

function defaultDownloadResult(): MockDownloadResult {
  return {
    downloadState: 'pending',
    localPath: null,
    hasKeys: true,
    retry: jest.fn(),
  };
}

const mockUseMediaDownload = jest.fn();

jest.mock('../../hooks/useMediaDownload', () => ({
  useMediaDownload: (...args: unknown[]) => mockUseMediaDownload(...args),
}));

/** Arg-keyed override, keyed on mediaId (first arg) — lets one render serve
 * different items different download states. */
function setDownloadResult(overrides: Record<string, Partial<MockDownloadResult>>): void {
  mockUseMediaDownload.mockImplementation((mediaId: string | null) => ({
    ...defaultDownloadResult(),
    ...(mediaId ? overrides[mediaId] : undefined),
  }));
}

interface MockThumbResult {
  isVideo: boolean;
  thumbState: DownloadState;
  thumbLocalPath: string | null;
  retryThumb: jest.Mock;
}

function defaultThumbResult(contentType: string | undefined): MockThumbResult {
  return {
    isVideo: !!contentType?.startsWith('video/'),
    thumbState: 'unavailable',
    thumbLocalPath: null,
    retryThumb: jest.fn(),
  };
}

const mockUseVideoThumbnail = jest.fn();

jest.mock('../../hooks/useVideoThumbnail', () => ({
  useVideoThumbnail: (...args: unknown[]) => mockUseVideoThumbnail(...args),
}));

/** Arg-keyed override, keyed on contentType (first arg). */
function setThumbResult(overrides: Record<string, Partial<MockThumbResult>>): void {
  mockUseVideoThumbnail.mockImplementation((contentType: string | undefined) => ({
    ...defaultThumbResult(contentType),
    ...(contentType && overrides[contentType] ? overrides[contentType] : undefined),
  }));
}

const mockOpenReportSheet = jest.fn();

// useAppStore is used both as a reactive hook (MediaLightbox, ActiveVideoPage
// call useAppStore(selector)) and imperatively (useAppStore.getState()), so the
// mock must be callable AND expose getState. mockState is declared with the
// "mock" prefix required by babel-plugin-jest-hoist's out-of-scope-reference
// allowlist; both closures below only read it lazily (on selector/getState
// invocation, i.e. at test-render time), long after this module has finished
// initializing, so the mock-hoisting-above-const ordering is not a problem.
const mockState: {
  media: Record<string, { fileSize?: number | null } | undefined>;
  openReportSheet: jest.Mock;
} = {
  media: {},
  openReportSheet: mockOpenReportSheet,
};

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: Object.assign(
    (selector: (s: typeof mockState) => unknown) => selector(mockState),
    { getState: () => mockState },
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MEDIA_ITEMS = [
  {
    id: 'media-42',
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
    downloadState: 'pending' as const,
    uploadState: 'done' as const,
    expiresAt: null,
    hasKeys: true,
    thumbnailMediaId: null,
    isThumbnail: false,
  },
];

function makeMediaItems(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `media-${i}`,
    threadId: 't-1',
    replyId: null,
    contentType: 'image/jpeg',
    fileName: `photo-${i}.jpg`,
    fileSize: 1024,
    width: 800,
    height: 600,
    duration: null,
    blurHash: null,
    localPath: null,
    thumbnailPath: null,
    downloadState: 'pending' as const,
    uploadState: 'done' as const,
    expiresAt: null,
    hasKeys: true,
    thumbnailMediaId: null,
    isThumbnail: false,
  }));
}

function makeVideoItem() {
  return {
    id: 'video-1',
    threadId: 't-1',
    replyId: null,
    contentType: 'video/mp4',
    fileName: 'clip.mp4',
    fileSize: 50000,
    width: 1920,
    height: 1080,
    duration: 42_000,
    blurHash: null,
    localPath: null,
    thumbnailPath: null,
    downloadState: 'pending' as const,
    uploadState: 'done' as const,
    expiresAt: null,
    hasKeys: true,
    thumbnailMediaId: 'thumb-v1',
    isThumbnail: false,
  };
}

function renderLightbox(
  props: Partial<React.ComponentProps<typeof MediaLightbox>> = {},
): ReactTestRenderer {
  const defaults = {
    visible: true,
    mediaItems: MEDIA_ITEMS,
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
  return renderer;
}

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((node) => node.props.testID === testID);
  if (found.length === 0) throw new Error(`No element with testID "${testID}"`);
  return found[0];
}

function findAllByTestIdPrefix(
  root: ReactTestInstance,
  prefix: string,
): ReactTestInstance[] {
  return root.findAll(
    (node) =>
      typeof node.type === 'string' &&
      typeof node.props.testID === 'string' &&
      node.props.testID.startsWith(prefix),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SCREEN_WIDTH = Dimensions.get('window').width;

beforeEach(() => {
  jest.clearAllMocks();
  mockState.media = {};
  mockUseMediaDownload.mockImplementation(() => defaultDownloadResult());
  mockUseVideoThumbnail.mockImplementation((contentType: string | undefined) =>
    defaultThumbResult(contentType),
  );
});

// ---------------------------------------------------------------------------
// Report button — Android
// ---------------------------------------------------------------------------

describe('MediaLightbox — report button (Android)', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    (Platform as { OS: string }).OS = 'android';
  });

  afterEach(() => {
    (Platform as { OS: string }).OS = originalOS;
  });

  it('calls openReportSheet with media target after interactions settle', async () => {
    const onClose = jest.fn();
    const renderer = renderLightbox({ onClose });

    // Tap the report button
    act(() => {
      findByTestId(renderer.root, 'media-lightbox-report-button').props.onPress();
    });

    expect(onClose).toHaveBeenCalled();

    // InteractionManager.runAfterInteractions returns a cancellable promise;
    // in the test environment we need to flush microtasks for the callback to fire.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(mockOpenReportSheet).toHaveBeenCalledWith({
      contentType: 'media',
      contentId: 'media-42',
    });
  });
});

// ---------------------------------------------------------------------------
// Report button — iOS
// ---------------------------------------------------------------------------

describe('MediaLightbox — report button (iOS)', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    (Platform as { OS: string }).OS = 'ios';
  });

  afterEach(() => {
    (Platform as { OS: string }).OS = originalOS;
  });

  it('stashes pending target and does NOT call openReportSheet immediately', () => {
    const onClose = jest.fn();
    const renderer = renderLightbox({ onClose });

    act(() => {
      findByTestId(renderer.root, 'media-lightbox-report-button').props.onPress();
    });

    expect(onClose).toHaveBeenCalled();
    // On iOS, openReportSheet should NOT be called yet — it waits for onDismiss
    expect(mockOpenReportSheet).not.toHaveBeenCalled();
  });

  it('opens report sheet when onDismiss fires', () => {
    const onClose = jest.fn();
    const renderer = renderLightbox({ onClose });

    // Tap the report button — stashes target
    act(() => {
      findByTestId(renderer.root, 'media-lightbox-report-button').props.onPress();
    });

    // Find the Modal node (it has onDismiss prop)
    const modalNode = renderer.root.findAll((n) => n.props.onDismiss != null)[0];
    expect(modalNode).toBeDefined();

    act(() => {
      modalNode.props.onDismiss();
    });

    expect(mockOpenReportSheet).toHaveBeenCalledWith({
      contentType: 'media',
      contentId: 'media-42',
    });
  });
});

// ---------------------------------------------------------------------------
// Windowed rendering
// ---------------------------------------------------------------------------

describe('MediaLightbox — windowed rendering', () => {
  const items = makeMediaItems(10);

  it('mounts pages 0-1 and 8 placeholders when initialIndex is 0', () => {
    const renderer = renderLightbox({ mediaItems: items, initialIndex: 0 });

    const pages = findAllByTestIdPrefix(renderer.root, 'lightbox-page-');
    const placeholders = findAllByTestIdPrefix(renderer.root, 'lightbox-placeholder-');

    expect(pages.length).toBe(2); // pages 0 and 1
    expect(placeholders.length).toBe(8);

    // Verify the correct pages are mounted
    expect(pages.map((p) => p.props.testID).sort()).toEqual([
      'lightbox-page-media-0',
      'lightbox-page-media-1',
    ]);
  });

  it('mounts pages 4-6 and 7 placeholders when initialIndex is 5', () => {
    const renderer = renderLightbox({ mediaItems: items, initialIndex: 5 });

    const pages = findAllByTestIdPrefix(renderer.root, 'lightbox-page-');
    const placeholders = findAllByTestIdPrefix(renderer.root, 'lightbox-placeholder-');

    expect(pages.length).toBe(3); // pages 4, 5, 6
    expect(placeholders.length).toBe(7);

    expect(pages.map((p) => p.props.testID).sort()).toEqual([
      'lightbox-page-media-4',
      'lightbox-page-media-5',
      'lightbox-page-media-6',
    ]);
  });

  it('mounts pages 8-9 and 8 placeholders when initialIndex is 9', () => {
    const renderer = renderLightbox({ mediaItems: items, initialIndex: 9 });

    const pages = findAllByTestIdPrefix(renderer.root, 'lightbox-page-');
    const placeholders = findAllByTestIdPrefix(renderer.root, 'lightbox-placeholder-');

    expect(pages.length).toBe(2); // pages 8 and 9
    expect(placeholders.length).toBe(8);

    expect(pages.map((p) => p.props.testID).sort()).toEqual([
      'lightbox-page-media-8',
      'lightbox-page-media-9',
    ]);
  });

  it('shifts window on onMomentumScrollEnd and updates counter', () => {
    const renderer = renderLightbox({ mediaItems: items, initialIndex: 0 });

    // Simulate scroll to page 3
    const scrollView = renderer.root.findAll(
      (n) => n.props.onMomentumScrollEnd != null,
    )[0];

    act(() => {
      scrollView.props.onMomentumScrollEnd({
        nativeEvent: { contentOffset: { x: 3 * SCREEN_WIDTH } },
      });
    });

    const pages = findAllByTestIdPrefix(renderer.root, 'lightbox-page-');
    const placeholders = findAllByTestIdPrefix(renderer.root, 'lightbox-placeholder-');

    // Window: pages 2, 3, 4
    expect(pages.length).toBe(3);
    expect(placeholders.length).toBe(7);

    expect(pages.map((p) => p.props.testID).sort()).toEqual([
      'lightbox-page-media-2',
      'lightbox-page-media-3',
      'lightbox-page-media-4',
    ]);

    // Counter should show "4 / 10"
    const counterText = renderer.root.findAll(
      (n) =>
        typeof n.children?.[0] === 'string' && n.children[0].includes(' / '),
    );
    expect(counterText.length).toBeGreaterThan(0);
    expect(counterText[0].children[0]).toBe('4 / 10');
  });

  it('shifts window on next-arrow press', () => {
    const renderer = renderLightbox({ mediaItems: items, initialIndex: 0 });

    // Press next arrow
    act(() => {
      findByTestId(renderer.root, 'lightbox-next').props.onPress();
    });

    const pages = findAllByTestIdPrefix(renderer.root, 'lightbox-page-');

    // Window: pages 0, 1, 2
    expect(pages.length).toBe(3);
    expect(pages.map((p) => p.props.testID).sort()).toEqual([
      'lightbox-page-media-0',
      'lightbox-page-media-1',
      'lightbox-page-media-2',
    ]);
  });

  it('mounts correct window when reopened at new initialIndex', () => {
    // First render at initialIndex 0
    const renderer = renderLightbox({
      mediaItems: items,
      initialIndex: 0,
      visible: true,
    });

    // Verify initial window
    let pages = findAllByTestIdPrefix(renderer.root, 'lightbox-page-');
    expect(pages.map((p) => p.props.testID).sort()).toEqual([
      'lightbox-page-media-0',
      'lightbox-page-media-1',
    ]);

    // Close the lightbox
    act(() => {
      renderer.update(
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(MediaLightbox, {
            visible: false,
            mediaItems: items,
            initialIndex: 0,
            onClose: jest.fn(),
          }),
        ),
      );
    });

    // Reopen at initialIndex 7
    act(() => {
      renderer.update(
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(MediaLightbox, {
            visible: true,
            mediaItems: items,
            initialIndex: 7,
            onClose: jest.fn(),
          }),
        ),
      );
    });

    pages = findAllByTestIdPrefix(renderer.root, 'lightbox-page-');
    expect(pages.map((p) => p.props.testID).sort()).toEqual([
      'lightbox-page-media-6',
      'lightbox-page-media-7',
      'lightbox-page-media-8',
    ]);
  });

  it('invokes useMediaDownload only for windowed mediaIds', () => {
    mockUseMediaDownload.mockClear();

    renderLightbox({ mediaItems: items, initialIndex: 5 });

    // useMediaDownload should only be called for pages 4, 5, 6
    const calledMediaIds = mockUseMediaDownload.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(calledMediaIds.sort()).toEqual(['media-4', 'media-5', 'media-6']);

    // Verify cancelOnUnmount is passed
    mockUseMediaDownload.mock.calls.forEach((call: unknown[]) => {
      expect(call[1]).toEqual({ cancelOnUnmount: true });
    });
  });
});

// ---------------------------------------------------------------------------
// Video page rendering
//
// LightboxPage (rendered for image items) no longer touches videos at all.
// Video items are routed to LightboxVideoPage, which always renders the outer
// `lightbox-page-${mediaId}` wrapper (so the windowing assertions above keep
// working unchanged for mixed galleries) and mounts either:
//   - ActiveVideoPage (isActive: visible && index === currentIndex) — the sole
//     trigger for the real video download, using the real mediaId
//   - VideoPoster (not active) — thumbnail-only, never downloads the video
// ---------------------------------------------------------------------------

describe('MediaLightbox — video page', () => {
  it('active video page calls useMediaDownload with the real media id (no suppression)', () => {
    const videoItem = makeVideoItem();
    mockState.media['video-1'] = { fileSize: 50000 };

    const renderer = renderLightbox({
      mediaItems: [videoItem],
      initialIndex: 0,
    });

    // Outer lightbox-page wrapper exists regardless of active/inactive branch.
    findByTestId(renderer.root, 'lightbox-page-video-1');

    // The active page is ActiveVideoPage, which calls useMediaDownload with the
    // REAL video id — the old LightboxPage suppression (useMediaDownload(null)
    // for videos) no longer applies to the lightbox's active page.
    const downloadCalls = mockUseMediaDownload.mock.calls;
    const activeCall = downloadCalls.find((call: unknown[]) => call[0] === 'video-1');
    expect(activeCall).toBeDefined();
    expect(activeCall?.[1]).toEqual({ cancelOnUnmount: true });
    expect(downloadCalls.some((call: unknown[]) => call[0] === null)).toBe(false);

    // Default download state is 'pending' with hasKeys true, so ActiveVideoPage
    // falls through to its poster/downloading branch — no native player mounted.
    findByTestId(renderer.root, 'lightbox-video-downloading-video-1');
    expect(
      renderer.root.findAll((n) => n.props.testID === 'lightbox-video-video-1').length,
    ).toBe(0);
  });

  it('active video page mounts the native player once downloaded', () => {
    const videoItem = makeVideoItem();
    mockState.media['video-1'] = { fileSize: 50000 };
    setDownloadResult({
      'video-1': { downloadState: 'downloaded', localPath: '/cache/video-1.mp4' },
    });

    const renderer = renderLightbox({
      mediaItems: [videoItem],
      initialIndex: 0,
    });

    const video = findByTestId(renderer.root, 'lightbox-video-video-1');
    expect(video.props.source).toEqual({ uri: 'file:///cache/video-1.mp4' });
    // Autoplay (#662): mounting the active page IS the play intent.
    expect(video.props.paused).toBe(false);
  });

  it('non-active video page renders VideoPoster with a play icon, never downloads', () => {
    setThumbResult({
      'video/mp4': {
        isVideo: true,
        thumbState: 'unavailable',
        thumbLocalPath: null,
      },
    });

    const imageItem = { ...MEDIA_ITEMS[0], id: 'img-0' };
    const videoItem = makeVideoItem();

    // initialIndex 0 (image) keeps the video (index 1) windowed but NOT active.
    const renderer = renderLightbox({
      mediaItems: [imageItem, videoItem],
      initialIndex: 0,
    });

    // Outer wrapper exists for the non-active video page too.
    findByTestId(renderer.root, 'lightbox-page-video-1');

    // Non-active branch renders VideoPoster directly (its default testID).
    findByTestId(renderer.root, 'lightbox-video-poster-video-1');

    const playIcons = renderer.root.findAll(
      (n) => n.props.testID === 'play-icon-overlay',
    );
    expect(playIcons.length).toBeGreaterThan(0);

    // VideoPoster never triggers the full-video download — only the active
    // page's ActiveVideoPage does.
    const downloadCalls = mockUseMediaDownload.mock.calls;
    expect(downloadCalls.some((call: unknown[]) => call[0] === 'video-1')).toBe(false);
  });

  it('image pages render unchanged when mixed with video', () => {
    // First item is image, second is video
    setThumbResult({
      'video/mp4': { isVideo: true, thumbState: 'unavailable', thumbLocalPath: null },
    });
    setDownloadResult({
      'img-1': { downloadState: 'downloaded', localPath: '/cache/image.jpg' },
    });

    const imageItem = {
      ...MEDIA_ITEMS[0],
      id: 'img-1',
      contentType: 'image/jpeg',
    };
    const videoItem = makeVideoItem();

    const renderer = renderLightbox({
      mediaItems: [imageItem, videoItem],
      initialIndex: 0,
    });

    // Both pages should be mounted (index 0 and 1, within +-1 window)
    findByTestId(renderer.root, 'lightbox-page-img-1');
    findByTestId(renderer.root, 'lightbox-page-video-1');
  });

  it('report button says "Report video" when current item is video', () => {
    const videoItem = makeVideoItem();
    const renderer = renderLightbox({
      mediaItems: [videoItem],
      initialIndex: 0,
    });

    const reportBtn = findByTestId(renderer.root, 'media-lightbox-report-button');
    expect(reportBtn.props.accessibilityLabel).toBe('Report video');
  });

  it('nav buttons say "media" when current item is video', () => {
    const items = [
      { ...MEDIA_ITEMS[0], id: 'img-0' },
      { ...makeVideoItem(), id: 'vid-1' },
      { ...MEDIA_ITEMS[0], id: 'img-2' },
    ];

    const renderer = renderLightbox({
      mediaItems: items,
      initialIndex: 1,
    });

    // At index 1 (video), nav labels should use "media"
    const prevBtn = findByTestId(renderer.root, 'lightbox-prev');
    const nextBtn = findByTestId(renderer.root, 'lightbox-next');
    expect(prevBtn.props.accessibilityLabel).toBe('Previous media');
    expect(nextBtn.props.accessibilityLabel).toBe('Next media');
  });
});
