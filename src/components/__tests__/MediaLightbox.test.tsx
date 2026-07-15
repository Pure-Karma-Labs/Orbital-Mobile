/**
 * Tests for MediaLightbox — report button platform branching and windowed rendering.
 *
 * Verifies:
 * - Android: tapping report calls openReportSheet directly (via InteractionManager)
 * - iOS: tapping report stashes pending target; onDismiss triggers openReportSheet
 * - Windowing: only pages within +/-1 of currentIndex are mounted as LightboxPage
 * - onMomentumScrollEnd shifts the window
 * - Arrow press shifts the window
 * - Reopen at new initialIndex mounts the correct window in the same commit
 * - useMediaDownload is only invoked for windowed mediaIds
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

const mockUseMediaDownload = jest.fn().mockReturnValue({
  downloadState: 'pending',
  localPath: null,
});

jest.mock('../../hooks/useMediaDownload', () => ({
  useMediaDownload: (...args: unknown[]) => mockUseMediaDownload(...args),
}));

const mockOpenReportSheet = jest.fn();
jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: () => ({
      openReportSheet: mockOpenReportSheet,
    }),
  },
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
  }));
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
  mockUseMediaDownload.mockReturnValue({
    downloadState: 'pending',
    localPath: null,
  });
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
