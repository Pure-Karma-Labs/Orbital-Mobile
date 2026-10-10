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
 * - Save (#878): geometry, per-id states, the ✓ badge timer being keyed on the
 *   saved id, the host-supplied canExport prop, exactly one Modal, and the
 *   control-interaction stamp that stops a Save tap toggling the video chrome
 *
 * NO FAKE TIMERS IN THIS FILE. Every Save assertion is reachable through real
 * promise resolution and real state, and the ✓ badge's clearing is asserted
 * through the id-keying (swipe away, swipe back) rather than by advancing a
 * clock. A fake-timer describe here would be the #834/#835 class of hazard:
 * this file renders the video chrome, whose Animated chain re-arms every 16 ms
 * under Jest's native-animation mock.
 */

import React from 'react';
import { Platform, Dimensions } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { MediaLightbox, SAVED_BADGE_MS } from '../MediaLightbox';

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
/**
 * Every callback handed to `Gesture.Tap().onEnd(...)`, in mount order.
 *
 * The full-page tap layer is the only way to drive VideoControls' tap
 * suppression from outside: RNGH's real handlers never run under Jest, so the
 * mock below records the callback and a test invokes it directly. Name starts
 * with `mock` for babel-plugin-jest-hoist's out-of-scope-reference allowlist.
 */
const mockTapEndHandlers: Array<() => void> = [];

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
  const tapChainable: Record<string, (...args: unknown[]) => unknown> = {
    runOnJS: () => tapChainable,
    onEnd: (cb: unknown) => {
      if (typeof cb === 'function') mockTapEndHandlers.push(cb as () => void);
      return tapChainable;
    },
  };

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

/**
 * #878: the export service is mocked so the suite drives OUTCOMES, not the
 * native writer. `describeExportOutcome` returns a SENTINEL rather than the
 * real copy: this file's job is to prove the lightbox renders whatever the
 * service said, and the real strings are asserted in
 * `services/__tests__/mediaExportService.test.ts`. Duplicating copy here would
 * just let the two drift.
 */
const mockSaveMediaItem = jest.fn();
const mockDescribeExportOutcome = jest.fn(
  (result: { outcome: string }) => `STATUS:${result.outcome}`,
);

jest.mock('../../services/mediaExportService', () => ({
  saveMediaItem: (...args: unknown[]) => mockSaveMediaItem(...args),
  describeExportOutcome: (result: { outcome: string }) =>
    mockDescribeExportOutcome(result),
}));

/**
 * The visibility state machine is replaced so `notify` is observable: it is
 * what the full-page tap calls, and "the Save press suppressed the tap" is
 * exactly "notify was not called with 'tap'".
 */
const mockNotifyControls = jest.fn();

jest.mock('../videoControls/useControlsVisibility', () => ({
  useControlsVisibility: () => ({ visible: true, notify: mockNotifyControls }),
}));

const mockOpenReportSheet = jest.fn();

// useAppStore is used both as a reactive hook (MediaLightbox, ActiveVideoPage
// call useAppStore(selector)) and imperatively (useAppStore.getState()), so the
// mock must be callable AND expose getState. mockState is declared with the
// "mock" prefix required by babel-plugin-jest-hoist's out-of-scope-reference
// allowlist; both closures below only read it lazily (on selector/getState
// invocation, i.e. at test-render time), long after this module has finished
// initializing, so the mock-hoisting-above-const ordering is not a problem.
const mockState: {
  media: Record<string, { fileSize?: number | null; downloadState?: string } | undefined>;
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

/**
 * Every renderer this file creates, unmounted in afterEach.
 *
 * Load-bearing, and NOT just hygiene (#834/#835 class): two real timers are
 * armed by a mounted lightbox and both outlive a 0.5s suite —
 * ActiveVideoPage's 1s play-intent watchdog (armed once `ready` flips true)
 * and the Save button's 2s ✓ badge timer. Left mounted, they fire after Jest
 * tears the environment down, which surfaces as "trying to `import` a file
 * after the Jest environment has been torn down" plus a React uncaught-error
 * warning attributed to a component that is no longer being tested. Unmounting
 * runs both effects' cleanup (clearTimeout), which is the real fix; no fake
 * timers are involved anywhere in this file.
 */
const createdRenderers: ReactTestRenderer[] = [];

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
  createdRenderers.push(renderer);
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
  mockTapEndHandlers.length = 0;
  mockSaveMediaItem.mockResolvedValue({ outcome: 'saved', destination: 'photos' });
  mockDescribeExportOutcome.mockImplementation(
    (result: { outcome: string }) => `STATUS:${result.outcome}`,
  );
  mockState.media = {};
  mockUseMediaDownload.mockImplementation(() => defaultDownloadResult());
  mockUseVideoThumbnail.mockImplementation((contentType: string | undefined) =>
    defaultThumbResult(contentType),
  );
});

afterEach(() => {
  // See createdRenderers: a still-mounted lightbox holds real timers that
  // outlive the suite.
  while (createdRenderers.length > 0) {
    const renderer = createdRenderers.pop();
    try {
      act(() => {
        renderer?.unmount();
      });
    } catch {
      // Already unmounted by the test itself — nothing to clean up.
    }
  }
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

// ---------------------------------------------------------------------------
// Save button (#878)
// ---------------------------------------------------------------------------

/** Pill text currently on screen, or undefined when no pill is rendered. */
function saveStatus(renderer: ReactTestRenderer): unknown {
  const hosts = renderer.root.findAll(
    (n) => typeof n.type === 'string' && n.props.testID === 'lightbox-save-status',
  );
  return hosts.length === 0 ? undefined : hosts[0].props.children;
}

/** The Save button's COMPONENT node — where onPress and a11y props live. */
function saveButton(renderer: ReactTestRenderer): ReactTestInstance {
  return findByTestId(renderer.root, 'lightbox-save');
}

async function pressSave(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    saveButton(renderer).props.onPress();
  });
}

describe('MediaLightbox — Save button geometry and chrome', () => {
  it('sits one gutter left of Close and never overlaps it', () => {
    const renderer = renderLightbox();
    const save = saveButton(renderer).props.style;
    const close = findByTestId(renderer.root, 'lightbox-close').props.style;

    // right = spacing.base (Close's inset) + 40 (Close's width) + spacing.base
    expect(save.right).toBe(16 + 40 + 16);
    expect(close.right).toBe(16);
    expect(save.width).toBe(40);
    expect(save.height).toBe(40);
    expect(save.borderRadius).toBe(20);
    expect(save.backgroundColor).toBe('rgba(0, 0, 0, 0.5)');
    expect(save.zIndex).toBe(10);
    // Same vertical line as Close, under the safe-area inset.
    expect(save.top).toBe(close.top);
    // Negative control: the two circles are 56px apart, not stacked.
    expect(save.right).not.toBe(close.right);
  });

  it('leaves the shared edge to Close in its hitSlop', () => {
    const renderer = renderLightbox();
    expect(saveButton(renderer).props.hitSlop).toEqual({
      top: 8,
      bottom: 8,
      left: 8,
      right: 0,
    });
  });

  it('renders exactly one Modal — feedback is a pill, never a nested modal', async () => {
    const renderer = renderLightbox();
    const modals = () =>
      renderer.root.findAll((n) => String(n.type) === 'Modal');
    expect(modals()).toHaveLength(1);

    await pressSave(renderer);
    expect(saveStatus(renderer)).toBe('STATUS:saved');
    expect(modals()).toHaveLength(1);
  });

  it('labels itself by the current item type', () => {
    expect(saveButton(renderLightbox()).props.accessibilityLabel).toBe('Save photo');

    const video = renderLightbox({ mediaItems: [makeVideoItem()], initialIndex: 0 });
    expect(saveButton(video).props.accessibilityLabel).toBe('Save video');

    const doc = renderLightbox({
      mediaItems: [{ ...MEDIA_ITEMS[0], contentType: 'application/pdf' }],
      initialIndex: 0,
    });
    expect(saveButton(doc).props.accessibilityLabel).toBe('Save file');
  });

  it('does NOT dismiss the lightbox', async () => {
    const onClose = jest.fn();
    const renderer = renderLightbox({ onClose });
    await pressSave(renderer);
    expect(onClose).not.toHaveBeenCalled();
    expect(mockOpenReportSheet).not.toHaveBeenCalled();
  });
});

describe('MediaLightbox — Save states', () => {
  it('shows nothing until pressed', () => {
    const renderer = renderLightbox();
    expect(saveStatus(renderer)).toBeUndefined();
    expect(saveButton(renderer).props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });
  });

  it('reads "Downloading…" while the source is still being fetched', async () => {
    let settle!: (r: unknown) => void;
    mockSaveMediaItem.mockImplementation(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const renderer = renderLightbox();

    await act(async () => {
      saveButton(renderer).props.onPress();
    });

    expect(saveStatus(renderer)).toBe('Downloading…');
    expect(saveButton(renderer).props.accessibilityState).toEqual({
      disabled: false,
      busy: true,
    });

    await act(async () => {
      settle({ outcome: 'saved', destination: 'photos' });
    });
  });

  it('reads "Saving…" once the source is already on disk', async () => {
    mockState.media['media-42'] = { downloadState: 'downloaded' };
    let settle!: (r: unknown) => void;
    mockSaveMediaItem.mockImplementation(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const renderer = renderLightbox();

    await act(async () => {
      saveButton(renderer).props.onPress();
    });
    expect(saveStatus(renderer)).toBe('Saving…');

    await act(async () => {
      settle({ outcome: 'saved', destination: 'photos' });
    });
  });

  it('shows the ✓ glyph and the service’s own copy on success', async () => {
    const renderer = renderLightbox();
    await pressSave(renderer);

    expect(saveStatus(renderer)).toBe('STATUS:saved');
    expect(saveButton(renderer).findByType('Text' as never).props.children).toBe('✓');
    expect(mockDescribeExportOutcome).toHaveBeenCalledWith({
      outcome: 'saved',
      destination: 'photos',
    });
  });

  it.each(['failed', 'noSpace', 'permission', 'unsupported', 'corrupt', 'unavailable', 'notAllowed'])(
    'shows the ⚠ glyph and the service copy for %s',
    async (outcome) => {
      mockSaveMediaItem.mockResolvedValue({ outcome });
      const renderer = renderLightbox();
      await pressSave(renderer);

      expect(saveStatus(renderer)).toBe(`STATUS:${outcome}`);
      expect(saveButton(renderer).findByType('Text' as never).props.children).toBe('⚠');
    },
  );

  it('drops back to idle on a cancelled save', async () => {
    mockSaveMediaItem.mockResolvedValue({ outcome: 'cancelled' });
    const renderer = renderLightbox();
    await pressSave(renderer);

    expect(saveStatus(renderer)).toBeUndefined();
    expect(saveButton(renderer).findByType('Text' as never).props.children).toBe('⤓');
  });

  it('never gets stuck on "saving" if the service rejects', async () => {
    mockSaveMediaItem.mockRejectedValue(new Error('unexpected'));
    const renderer = renderLightbox();
    await pressSave(renderer);

    expect(saveStatus(renderer)).toBe("Couldn't save");
  });

  it('ignores a second press while a save is in flight', async () => {
    mockSaveMediaItem.mockImplementation(() => new Promise(() => {}));
    const renderer = renderLightbox();

    await pressSave(renderer);
    await pressSave(renderer);

    expect(mockSaveMediaItem).toHaveBeenCalledTimes(1);
  });

  // #879 review: the double-press guard used to read `saveStatuses`, which is
  // STATE. Two presses in one tick both see the pre-press map (React has not
  // re-rendered in between), so both started a save and two copies landed in
  // Photos. The guard is now a ref, written before anything awaits.
  it('starts ONE save when the button is pressed twice in the same tick', async () => {
    mockSaveMediaItem.mockImplementation(() => new Promise(() => {}));
    const renderer = renderLightbox();

    await act(async () => {
      const onPress = saveButton(renderer).props.onPress;
      onPress();
      onPress();
    });

    expect(mockSaveMediaItem).toHaveBeenCalledTimes(1);
  });

  // #879 review: the previous success's 2s badge timer is keyed on `savedId`.
  // Left armed across a NEW save on the same item it fired mid-save and
  // deleted that save's 'saving' status, un-latching the old state-based guard
  // — a third press then produced a second copy. handleSave now drops the
  // badge (and so the timer) before it starts.
  //
  // NO fake timers: installing them in this file poisons the jest worker for
  // whichever suite it runs next, even with drain -> clear -> restore (#834 —
  // reproduced 3/3 on this test, clean 3/3 without it). Instead, spy on the
  // real setTimeout/clearTimeout and fire the badge timer by hand — but only if
  // the component has not cleared it, which is exactly what a deadline does.
  it('a new save on the same item is not un-latched by the old badge timer', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    /** Run every SAVED_BADGE_MS timer that is still armed, as its deadline would. */
    const fireArmedBadgeTimers = (): void => {
      const cleared = new Set(clearTimeoutSpy.mock.calls.map(([handle]) => handle));
      setTimeoutSpy.mock.calls.forEach(([callback, delay], i) => {
        const handle = setTimeoutSpy.mock.results[i]?.value;
        if (delay === SAVED_BADGE_MS && !cleared.has(handle)) {
          clearTimeout(handle);
          (callback as () => void)();
        }
      });
    };
    try {
      let settleSecond!: (result: unknown) => void;
      mockSaveMediaItem
        .mockResolvedValueOnce({ outcome: 'saved', destination: 'photos' })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              settleSecond = resolve;
            }),
        );

      const renderer = renderLightbox();

      // 1. First save succeeds; the badge (and its 2s timer) is up.
      await act(async () => {
        saveButton(renderer).props.onPress();
      });
      expect(saveStatus(renderer)).toBe('STATUS:saved');
      expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === SAVED_BADGE_MS)).toBe(true);

      // 2. Second save starts INSIDE the badge window.
      await act(async () => {
        saveButton(renderer).props.onPress();
      });
      expect(mockSaveMediaItem).toHaveBeenCalledTimes(2);
      expect(saveStatus(renderer)).toBe('Downloading…');

      // 3. The OLD timer's deadline passes. It must not touch this save.
      act(() => {
        fireArmedBadgeTimers();
      });
      expect(saveStatus(renderer)).toBe('Downloading…');
      expect(saveButton(renderer).props.accessibilityState.busy).toBe(true);

      // 4. ...and the guard is still latched, so no third save can start.
      await act(async () => {
        saveButton(renderer).props.onPress();
      });
      expect(mockSaveMediaItem).toHaveBeenCalledTimes(2);

      await act(async () => {
        settleSecond({ outcome: 'saved', destination: 'photos' });
      });
      expect(saveStatus(renderer)).toBe('STATUS:saved');
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('passes an AbortSignal and aborts it when the lightbox closes', async () => {
    mockSaveMediaItem.mockImplementation(() => new Promise(() => {}));
    const renderer = renderLightbox();
    await pressSave(renderer);

    const signal = mockSaveMediaItem.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);

    act(() => {
      renderer.update(
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(MediaLightbox, {
            visible: false,
            mediaItems: MEDIA_ITEMS,
            initialIndex: 0,
            onClose: jest.fn(),
          }),
        ),
      );
    });

    expect(signal.aborted).toBe(true);
    expect(saveStatus(renderer)).toBeUndefined();
  });
});

describe('MediaLightbox — per-id state and the ✓ badge timer', () => {
  const items = makeMediaItems(3);

  function scrollTo(renderer: ReactTestRenderer, index: number): void {
    const scrollView = renderer.root.findAll((n) => n.props.onMomentumScrollEnd != null)[0];
    act(() => {
      scrollView.props.onMomentumScrollEnd({
        nativeEvent: { contentOffset: { x: index * SCREEN_WIDTH } },
      });
    });
  }

  it('clears the saved badge on swipe, and it does not come back on swipe-BACK', async () => {
    const renderer = renderLightbox({ mediaItems: items, initialIndex: 0 });
    await pressSave(renderer);
    expect(saveStatus(renderer)).toBe('STATUS:saved');

    // The effect's cleanup runs here: timer cleared, savedId dropped.
    scrollTo(renderer, 1);
    expect(saveStatus(renderer)).toBeUndefined();

    // If the badge were merely HIDDEN (state kept, timer still pending) it
    // would reappear for media-0 on the way back.
    scrollTo(renderer, 0);
    expect(saveStatus(renderer)).toBeUndefined();
  });

  it('keeps an error pill scoped to its own id', async () => {
    mockSaveMediaItem.mockResolvedValue({ outcome: 'failed' });
    const renderer = renderLightbox({ mediaItems: items, initialIndex: 0 });
    await pressSave(renderer);
    expect(saveStatus(renderer)).toBe('STATUS:failed');

    scrollTo(renderer, 1);
    expect(saveStatus(renderer)).toBeUndefined();

    // An error is NOT timed, so returning to the item still shows it.
    scrollTo(renderer, 0);
    expect(saveStatus(renderer)).toBe('STATUS:failed');
  });

  it('saves the item the user is LOOKING at after a swipe', async () => {
    const renderer = renderLightbox({ mediaItems: items, initialIndex: 0 });
    scrollTo(renderer, 2);
    await pressSave(renderer);

    expect(mockSaveMediaItem).toHaveBeenCalledWith('media-2', expect.anything());
  });
});

describe('MediaLightbox — canExport', () => {
  it('defaults to exportable when the host supplies nothing', async () => {
    const renderer = renderLightbox();
    const button = saveButton(renderer);

    expect(button.props.accessibilityState.disabled).toBe(false);
    expect(button.props.style.opacity).toBe(1);

    await pressSave(renderer);
    expect(mockSaveMediaItem).toHaveBeenCalledWith('media-42', expect.anything());
  });

  it('reports disabled and refuses to save when the host says no', async () => {
    const canExport = jest.fn(() => false);
    const renderer = renderLightbox({ canExport });

    const button = saveButton(renderer);
    expect(button.props.accessibilityState).toEqual({ disabled: true, busy: false });
    expect(button.props.style.opacity).toBe(0.4);

    await pressSave(renderer);

    // Disabled, but the press still LANDS so the pill can explain why.
    expect(mockSaveMediaItem).not.toHaveBeenCalled();
    expect(saveStatus(renderer)).toBe('Not available to save');
    expect(canExport).toHaveBeenCalledWith('media-42');
  });

  it('is consulted per id, so one blocked item does not block the others', async () => {
    const items = makeMediaItems(3);
    const canExport = jest.fn((id: string) => id !== 'media-1');
    const renderer = renderLightbox({ mediaItems: items, initialIndex: 0, canExport });

    expect(saveButton(renderer).props.accessibilityState.disabled).toBe(false);

    const scrollView = renderer.root.findAll((n) => n.props.onMomentumScrollEnd != null)[0];
    act(() => {
      scrollView.props.onMomentumScrollEnd({
        nativeEvent: { contentOffset: { x: SCREEN_WIDTH } },
      });
    });

    expect(saveButton(renderer).props.accessibilityState.disabled).toBe(true);
    await pressSave(renderer);
    expect(mockSaveMediaItem).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Save over a playing video (#878)
//
// VideoControls' full-page Tap is ALWAYS mounted (it dismisses as well as
// shows), and RNGH's native handlers do not take part in the JS responder
// system — so a press on chrome OUTSIDE the player can also satisfy that Tap,
// in platform-dependent order (#518). The Save press therefore stamps the
// control-interaction timestamp through the registrar threaded
// MediaLightbox -> LightboxVideoPage -> ActiveVideoPage -> VideoControls.
// ---------------------------------------------------------------------------

describe('MediaLightbox — Save over a playing video', () => {
  function renderPlayingVideo(): ReactTestRenderer {
    const videoItem = makeVideoItem();
    mockState.media['video-1'] = { fileSize: 50000, downloadState: 'downloaded' };
    setDownloadResult({
      'video-1': { downloadState: 'downloaded', localPath: '/cache/video-1.mp4' },
    });
    const renderer = renderLightbox({ mediaItems: [videoItem], initialIndex: 0 });
    // onReadyForDisplay is what mounts VideoControls (and so registers the stamp).
    act(() => {
      findByTestId(renderer.root, 'lightbox-video-video-1').props.onReadyForDisplay();
    });
    return renderer;
  }

  /** Fire the most recently mounted full-page tap handler. */
  function firePageTap(): void {
    const handler = mockTapEndHandlers[mockTapEndHandlers.length - 1];
    expect(handler).toBeDefined();
    act(() => {
      handler();
    });
  }

  it('negative control: a page tap with no preceding Save DOES reach the controls', () => {
    renderPlayingVideo();
    firePageTap();
    expect(mockNotifyControls).toHaveBeenCalledWith('tap');
  });

  it('a Save press suppresses the page tap that may follow it', async () => {
    const renderer = renderPlayingVideo();
    mockNotifyControls.mockClear();

    await pressSave(renderer);
    firePageTap();

    // The tap was swallowed by the suppression window the Save press stamped.
    expect(mockNotifyControls).not.toHaveBeenCalledWith('tap');
  });

  it('still saves the video while suppressing the tap', async () => {
    const renderer = renderPlayingVideo();
    await pressSave(renderer);

    expect(mockSaveMediaItem).toHaveBeenCalledWith('video-1', expect.anything());
    expect(saveStatus(renderer)).toBe('STATUS:saved');
  });

  it('does not pause playback', async () => {
    const renderer = renderPlayingVideo();
    const pausedBefore = findByTestId(renderer.root, 'lightbox-video-video-1').props.paused;
    await pressSave(renderer);
    expect(findByTestId(renderer.root, 'lightbox-video-video-1').props.paused).toBe(
      pausedBefore,
    );
    expect(pausedBefore).toBe(false);
  });

  it('an image page registers no stamp, so Save is harmless there', async () => {
    const renderer = renderLightbox();
    await pressSave(renderer);
    expect(saveStatus(renderer)).toBe('STATUS:saved');
    expect(mockNotifyControls).not.toHaveBeenCalled();
  });
});
