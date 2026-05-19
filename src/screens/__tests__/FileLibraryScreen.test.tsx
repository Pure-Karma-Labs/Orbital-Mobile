/**
 * Tests for FileLibraryScreen — rendering, filters, sort, and cell interactions.
 *
 * Uses react-test-renderer with act() wrappers (React 19 requirement).
 * All external dependencies are mocked — no DB, no download service.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../theme';
import { FileLibraryScreen } from '../FileLibraryScreen';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: jest.fn(),
    goBack: mockGoBack,
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const RN = require('react');
  return {
    SafeAreaView: ({ children, ...props }: { children: unknown }) =>
      RN.createElement('View', props, children),
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
  };
});

// Mock the store selectors
const mockConversations: Record<string, { id: string; name: string; type: string }> = {
  'conv-1': { id: 'conv-1', name: 'Family', type: 'group' },
  'conv-2': { id: 'conv-2', name: 'Friends', type: 'group' },
};

jest.mock('../../stores', () => ({
  useConversations: jest.fn(() => ({
    conversations: mockConversations,
  })),
}));

// Mock useAppStore (Zustand store access)
const mockMedia: Record<string, { downloadState: string; localPath: string | null }> = {};
jest.mock('../../stores/useAppStore', () => ({
  useAppStore: Object.assign(
    jest.fn((selector: (s: unknown) => unknown) =>
      selector({ media: mockMedia }),
    ),
    {
      getState: () => ({
        media: mockMedia,
        setMediaBatch: jest.fn(),
      }),
    },
  ),
}));

// Mock database functions
const mockMediaRows = [
  {
    id: 'media-1',
    thread_id: 'thread-1',
    reply_id: null,
    message_id: null,
    content_type: 'image/jpeg',
    file_name: 'photo1.jpg',
    file_size: 2048000,
    width: 1920,
    height: 1080,
    duration: null,
    attachment_key: new Uint8Array(64),
    attachment_digest: null,
    cdn_number: null,
    cdn_key: null,
    local_path: null,
    thumbnail_path: null,
    blur_hash: null,
    expires_at: null,
    download_state: 'pending',
    upload_state: 'done',
    created_at: 1700000000000,
    conversation_id: 'conv-1',
  },
  {
    id: 'media-2',
    thread_id: 'thread-2',
    reply_id: null,
    message_id: null,
    content_type: 'image/png',
    file_name: 'photo2.png',
    file_size: 1024000,
    width: 800,
    height: 600,
    duration: null,
    attachment_key: new Uint8Array(64),
    attachment_digest: null,
    cdn_number: null,
    cdn_key: null,
    local_path: '/downloaded/photo2.png',
    thumbnail_path: null,
    blur_hash: null,
    expires_at: null,
    download_state: 'downloaded',
    upload_state: 'done',
    created_at: 1700000001000,
    conversation_id: 'conv-2',
  },
];

jest.mock('../../database/repositories/mediaRepository', () => ({
  getAllMedia: jest.fn(() => mockMediaRows),
  getMediaCount: jest.fn(() => 2),
  getLocalStorageUsage: jest.fn(() => 1024000),
  getMediaConversationIds: jest.fn(() => ['conv-1', 'conv-2']),
}));

jest.mock('../../database/repositories/mediaMapper', () => ({
  mediaRowToItem: jest.fn((row: Record<string, unknown>) => ({
    id: row.id,
    threadId: row.thread_id,
    replyId: row.reply_id,
    contentType: row.content_type,
    fileName: row.file_name,
    fileSize: row.file_size,
    width: row.width,
    height: row.height,
    duration: row.duration,
    blurHash: row.blur_hash,
    localPath: row.local_path,
    thumbnailPath: row.thumbnail_path,
    downloadState: row.download_state ?? 'pending',
    uploadState: row.upload_state ?? 'pending',
    expiresAt: row.expires_at,
    hasKeys: true,
  })),
}));

jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: jest.fn(() => true),
}));

jest.mock('../../services/mediaDownloadService', () => ({
  downloadAndDecryptMedia: jest.fn().mockResolvedValue('/path/to/file.jpg'),
}));

// Mock MediaLightbox to avoid pulling in useMediaDownload
jest.mock('../../components/MediaLightbox', () => {
  const { createElement } = require('react');
  return {
    MediaLightbox: (props: { visible: boolean; testID?: string }) =>
      props.visible
        ? createElement('View', { testID: 'media-lightbox' })
        : null,
  };
});

// Mock OrbitalSpinner to avoid animation complexity in tests
jest.mock('../../components/OrbitalSpinner', () => {
  const { createElement } = require('react');
  return {
    OrbitalSpinner: () => createElement('View', { testID: 'orbital-spinner' }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockNavigation = {
  goBack: mockGoBack,
  navigate: jest.fn(),
  dispatch: jest.fn(),
  reset: jest.fn(),
  isFocused: jest.fn(() => true),
  canGoBack: jest.fn(() => true),
  getParent: jest.fn(),
  getState: jest.fn(),
  setParams: jest.fn(),
  setOptions: jest.fn(),
  addListener: jest.fn(),
  removeListener: jest.fn(),
  getId: jest.fn(),
  pop: jest.fn(),
  popTo: jest.fn(),
  popToTop: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
};

const mockRoute = {
  key: 'FileLibrary-abc123',
  name: 'FileLibrary' as const,
  params: undefined,
};

function renderScreen(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(FileLibraryScreen, {
          navigation: mockNavigation as never,
          route: mockRoute,
        }),
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

function findAllByTestId(root: ReactTestInstance, testID: string): ReactTestInstance[] {
  return root.findAll((node) => node.props.testID === testID);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

describe('FileLibraryScreen — rendering', () => {
  it('renders with testID "file-library-screen"', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'file-library-screen')).not.toThrow();
  });

  it('renders the quota bar', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'quota-bar')).not.toThrow();
  });

  it('renders the content filter row', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'content-filter-row')).not.toThrow();
  });

  it('renders all four content filter chips', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'filter-all')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'filter-images')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'filter-videos')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'filter-documents')).not.toThrow();
  });

  it('renders the orbit filter row when conversations have media', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'orbit-filter-row')).not.toThrow();
    expect(() => findByTestId(renderer.root, 'orbit-all')).not.toThrow();
  });

  it('renders the sort row', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'sort-row')).not.toThrow();
  });

  it('renders the FlatList grid', () => {
    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'file-library-grid')).not.toThrow();
  });

  it('renders media cells', () => {
    const renderer = renderScreen();
    const cells = findAllByTestId(renderer.root, 'file-cell-media-1');
    expect(cells.length).toBeGreaterThan(0);
  });
});

describe('FileLibraryScreen — filter interaction', () => {
  it('changes content filter when a chip is pressed', () => {
    const { getAllMedia } = require('../../database/repositories/mediaRepository');
    const renderer = renderScreen();

    // Clear calls from initial render
    getAllMedia.mockClear();

    act(() => {
      findByTestId(renderer.root, 'filter-images').props.onPress();
    });

    // getAllMedia should have been called again with image filter
    expect(getAllMedia).toHaveBeenCalled();
  });

  it('changes orbit filter when an orbit chip is pressed', () => {
    const { getAllMedia } = require('../../database/repositories/mediaRepository');
    const renderer = renderScreen();

    getAllMedia.mockClear();

    act(() => {
      findByTestId(renderer.root, 'orbit-conv-1').props.onPress();
    });

    expect(getAllMedia).toHaveBeenCalled();
  });
});

describe('FileLibraryScreen — sort interaction', () => {
  it('cycles sort when toggle is pressed', () => {
    const renderer = renderScreen();
    const sortToggle = findByTestId(renderer.root, 'sort-toggle');

    // Find the text showing the current sort
    const textNodes = sortToggle.findAllByType('Text' as unknown as React.ComponentType);
    expect(textNodes.length).toBeGreaterThan(0);
    expect(textNodes[0].props.children).toBe('Newest');

    // Tap to cycle
    act(() => {
      sortToggle.props.onPress();
    });

    const updatedText = findByTestId(renderer.root, 'sort-toggle')
      .findAllByType('Text' as unknown as React.ComponentType);
    expect(updatedText[0].props.children).toBe('Oldest');
  });
});

describe('FileLibraryScreen — navigation', () => {
  it('calls goBack when header back is pressed', () => {
    const renderer = renderScreen();
    // Find the back button via the Header component
    const backButtons = renderer.root.findAll(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        node.props.accessibilityLabel?.includes('Go back'),
    );
    expect(backButtons.length).toBeGreaterThan(0);
    act(() => {
      backButtons[0].props.onPress();
    });
    expect(mockGoBack).toHaveBeenCalled();
  });
});

describe('FileLibraryScreen — empty state', () => {
  it('shows empty state when no media is available', () => {
    const { getAllMedia } = require('../../database/repositories/mediaRepository');
    getAllMedia.mockReturnValue([]);

    const renderer = renderScreen();
    expect(() => findByTestId(renderer.root, 'empty-state')).not.toThrow();
  });
});
