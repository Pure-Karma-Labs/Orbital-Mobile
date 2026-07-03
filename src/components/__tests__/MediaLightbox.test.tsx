/**
 * Tests for MediaLightbox — report button platform branching.
 *
 * Verifies:
 * - Android: tapping report calls openReportSheet directly (via InteractionManager)
 * - iOS: tapping report stashes pending target; onDismiss triggers openReportSheet
 */

import React from 'react';
import { Platform } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { MediaLightbox } from '../MediaLightbox';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));

jest.mock('../../hooks/useMediaDownload', () => ({
  useMediaDownload: () => ({ downloadState: 'pending', localPath: null }),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

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
