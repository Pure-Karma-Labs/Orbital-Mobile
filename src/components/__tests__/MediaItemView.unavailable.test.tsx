/**
 * Tests for MediaItemView — unavailable state rendering.
 */

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/tmp/test-docs',
}));

jest.mock('../../services/mediaDownloadService', () => ({
  downloadAndDecryptMedia: jest.fn(),
  retryDownload: jest.fn(),
  DOWNLOAD_ABORTED_MESSAGE: 'Download aborted',
}));

jest.mock('../../hooks/useVideoThumbnail', () => ({
  useVideoThumbnail: () => ({
    isVideo: false,
    thumbState: null,
    thumbLocalPath: null,
    retryThumb: jest.fn(),
  }),
}));

const mockUseMediaDownload = jest.fn();
jest.mock('../../hooks/useMediaDownload', () => ({
  useMediaDownload: () => mockUseMediaDownload(),
}));

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: Object.assign(
    jest.fn((selector: (s: Record<string, unknown>) => unknown) =>
      selector({ media: {} }),
    ),
    {
      getState: jest.fn(() => ({
        media: {},
        updateMediaDownloadState: jest.fn(),
        upsertMedia: jest.fn(),
      })),
    },
  ),
}));

import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { MediaItemView } from '../MediaItemView';
import { ThemeProvider } from '../../theme';

function renderView(props: Partial<React.ComponentProps<typeof MediaItemView>> = {}): ReactTestRenderer {
  const defaults = { mediaId: 'media-1', width: 200, height: 200 };
  let rend!: ReactTestRenderer;
  act(() => {
    rend = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(MediaItemView, { ...defaults, ...props }),
      ),
    );
  });
  return rend;
}

function findByTestId(root: ReactTestInstance, testId: string): ReactTestInstance | null {
  try {
    return root.findByProps({ testID: testId });
  } catch {
    return null;
  }
}

describe('MediaItemView — unavailable state', () => {
  it('renders non-pressable "No longer available" tile when unavailable + no localPath', () => {
    mockUseMediaDownload.mockReturnValue({
      downloadState: 'unavailable',
      localPath: null,
      hasKeys: true,
      retry: jest.fn(),
    });

    const rend = renderView();
    const tile = findByTestId(rend.root, 'media-item-media-1-unavailable');
    expect(tile).not.toBeNull();

    // Check the text content
    const texts = rend.root.findAllByType(Text);
    const textContent = texts.map(t => {
      const children = t.props.children;
      return typeof children === 'string' ? children : '';
    }).join(' ');
    expect(textContent).toContain('No longer available');
  });

  it('renders image when unavailable + localPath exists (local copy wins)', () => {
    mockUseMediaDownload.mockReturnValue({
      downloadState: 'unavailable',
      localPath: '/tmp/test-docs/media/media-1.jpg',
      hasKeys: true,
      retry: jest.fn(),
    });

    const rend = renderView();
    const tile = findByTestId(rend.root, 'media-item-media-1-unavailable');
    expect(tile).toBeNull();
  });
});
