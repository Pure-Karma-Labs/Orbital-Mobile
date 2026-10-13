/**
 * Tests for FileLibraryScreen — rendering, filters, sort, and cell interactions.
 *
 * Uses react-test-renderer with act() wrappers (React 19 requirement).
 * All external dependencies are mocked — no DB, no download service.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AccessibilityInfo, Alert, type AlertButton } from 'react-native';
import { ThemeProvider } from '../../theme';
import { findByTestId, findHostByTestId, hasHostTestId } from '../../testUtils/rtr';
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
        // #878: the canExport projection goes through the SHARED
        // `isExportableConversation` predicate, which reads membership from the
        // store rather than from the hook. Without this the predicate sees an
        // empty map and refuses every row.
        conversations: mockConversations,
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
  recoverStalePaths: jest.fn().mockResolvedValue([]),
  // Not used by this screen, but `mediaExportService` imports both from here
  // and a missing binding would only surface the day that mock is relaxed.
  DOWNLOAD_ABORTED_MESSAGE: 'Download aborted',
  InsufficientSpaceError: class InsufficientSpaceError extends Error {},
}));

/**
 * The two user-consent gates for "Save all" (#878 PR 2).
 *
 * Mocked at the module boundary: the real pair talks to the native photo
 * permission and persists the disclosure acknowledgement. What this suite
 * asserts is the ORDER the screen asks in, not what the dialogs look like.
 */
jest.mock('../../services/mediaExportService', () => ({
  ensureExportDisclosure: jest.fn(),
  ensureBulkExportPermission: jest.fn(),
}));

/**
 * The batch runner — mocked EXCEPT for its store.
 *
 * The run deliberately outlives the screen, so its state is a vanilla zustand
 * store read through `useStore`. Replacing that store with a plain object would
 * break `useSyncExternalStore`, so the factory builds a real one: the tests
 * drive phases by writing to it, exactly as a live run would.
 */
jest.mock('../../services/media/bulkExportRunner', () => {
  const { createStore } = require('zustand/vanilla');
  const store = createStore(() => ({
    phase: 'idle',
    total: 0,
    completed: 0,
    summary: null,
  }));
  return {
    bulkExportStore: store,
    prepareBulkExport: jest.fn(),
    checkBulkExportSpace: jest.fn(),
    startBulkExport: jest.fn(() => true),
    cancelBulkExport: jest.fn(),
    dismissBulkExportSummary: jest.fn(),
    describeBulkConfirm: jest.fn(() => 'CONFIRM_BODY'),
    describeBulkProgress: jest.fn(
      (s: { completed: number; total: number }) => `${s.completed} of ${s.total} items`,
    ),
    describeBulkSummary: jest.fn(() => 'SUMMARY_LINE'),
  };
});

/**
 * Mock MediaLightbox to avoid pulling in useMediaDownload — and to capture the
 * props this screen hands it. #878: `canExport` is the one prop this screen
 * supplies that no other lightbox host does, so the capture is how the wiring
 * is asserted without rendering the real lightbox.
 */
const mockLightboxProps: Array<Record<string, unknown>> = [];
jest.mock('../../components/MediaLightbox', () => {
  const { createElement } = require('react');
  return {
    MediaLightbox: (props: { visible: boolean; testID?: string }) => {
      mockLightboxProps.push(props as unknown as Record<string, unknown>);
      return props.visible
        ? createElement('View', { testID: 'media-lightbox' })
        : null;
    },
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

/**
 * Every screen mounted by a test, so `afterEach` can unmount them.
 *
 * #878: the bulk-export store is MODULE state and every mounted screen
 * subscribes to it, so a renderer left mounted by an earlier test reacts to a
 * phase change driven by a later one — and announces. Tearing each mount down
 * is what keeps the announcement counts a property of one screen.
 */
const mountedRenderers: ReactTestRenderer[] = [];

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
  mountedRenderers.push(renderer);
  return renderer;
}

// ---------------------------------------------------------------------------
// Save-all fixtures (#878)
// ---------------------------------------------------------------------------

type BulkPhase = 'idle' | 'running' | 'paused' | 'done';

interface BulkSummaryShape {
  saved: number;
  skipped: number;
  failed: number;
  destinations: string[];
  stoppedForSpace: boolean;
  cancelled: boolean;
}

interface BulkStateShape {
  phase: BulkPhase;
  total: number;
  completed: number;
  summary: BulkSummaryShape | null;
}

const IDLE_BULK_STATE: BulkStateShape = {
  phase: 'idle',
  total: 0,
  completed: 0,
  summary: null,
};

interface BulkRunnerMock {
  bulkExportStore: {
    setState: (next: BulkStateShape, replace: true) => void;
    getState: () => BulkStateShape;
  };
  prepareBulkExport: jest.Mock;
  checkBulkExportSpace: jest.Mock;
  startBulkExport: jest.Mock;
  cancelBulkExport: jest.Mock;
  dismissBulkExportSummary: jest.Mock;
  describeBulkConfirm: jest.Mock;
  describeBulkProgress: jest.Mock;
  describeBulkSummary: jest.Mock;
}

function bulkRunner(): BulkRunnerMock {
  return jest.requireMock('../../services/media/bulkExportRunner');
}

function exportService(): {
  ensureExportDisclosure: jest.Mock;
  ensureBulkExportPermission: jest.Mock;
} {
  return jest.requireMock('../../services/mediaExportService');
}

/** A plan shaped like `BulkExportPlan`; only `count` matters to the screen. */
function makePlan(overrides: Partial<{
  ids: string[];
  count: number;
  totalBytes: number;
  toDownloadBytes: number;
  unavailableCount: number;
  excludedCount: number;
  needs: { photo: boolean; document: boolean };
}> = {}): Record<string, unknown> {
  return {
    ids: ['media-1', 'media-2'],
    count: 2,
    totalBytes: 3 * 1024 * 1024,
    toDownloadBytes: 1024 * 1024,
    unavailableCount: 0,
    excludedCount: 0,
    needs: { photo: true, document: false },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockLightboxProps.length = 0;
  // The run outlives the screen by design, so the store is module state that
  // would otherwise leak between tests. Reset before any render.
  bulkRunner().bulkExportStore.setState(IDLE_BULK_STATE, true);
  exportService().ensureExportDisclosure.mockResolvedValue(true);
  exportService().ensureBulkExportPermission.mockResolvedValue({
    granted: true,
    photosToFiles: false,
  });
});

afterEach(() => {
  act(() => {
    for (const renderer of mountedRenderers.splice(0)) renderer.unmount();
  });
});

describe('FileLibraryScreen — rendering', () => {
  it('renders with testID "file-library-screen"', () => {
    const renderer = renderScreen();
    expect(hasHostTestId(renderer.root, 'file-library-screen')).toBe(true);
  });

  it('does not render quota bar when quota is not loaded', () => {
    const renderer = renderScreen();
    expect(hasHostTestId(renderer.root, 'quota-bar')).toBe(false);
  });

  it('renders the content filter row', () => {
    const renderer = renderScreen();
    expect(hasHostTestId(renderer.root, 'content-filter-row')).toBe(true);
  });

  it('renders all four content filter chips', () => {
    const renderer = renderScreen();
    expect(hasHostTestId(renderer.root, 'filter-all')).toBe(true);
    expect(hasHostTestId(renderer.root, 'filter-images')).toBe(true);
    expect(hasHostTestId(renderer.root, 'filter-videos')).toBe(true);
    expect(hasHostTestId(renderer.root, 'filter-documents')).toBe(true);
  });

  it('renders the orbit filter row when conversations have media', () => {
    const renderer = renderScreen();
    expect(hasHostTestId(renderer.root, 'orbit-filter-row')).toBe(true);
    expect(hasHostTestId(renderer.root, 'orbit-all')).toBe(true);
  });

  it('renders the sort row', () => {
    const renderer = renderScreen();
    expect(hasHostTestId(renderer.root, 'sort-row')).toBe(true);
  });

  it('renders the FlatList grid', () => {
    const renderer = renderScreen();
    expect(hasHostTestId(renderer.root, 'file-library-grid')).toBe(true);
  });

  it('renders media cells', () => {
    const renderer = renderScreen();
    expect(hasHostTestId(renderer.root, 'file-cell-media-1')).toBe(true);
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

    // getAllMedia should have been called with image content filter
    expect(getAllMedia).toHaveBeenCalledWith(
      expect.objectContaining({ contentTypeFilter: 'image' }),
    );
  });

  it('changes orbit filter when an orbit chip is pressed', () => {
    const { getAllMedia } = require('../../database/repositories/mediaRepository');
    const renderer = renderScreen();

    getAllMedia.mockClear();

    act(() => {
      findByTestId(renderer.root, 'orbit-conv-1').props.onPress();
    });

    expect(getAllMedia).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
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

describe('FileLibraryScreen — cell press interactions', () => {
  it('opens lightbox when a downloaded cell is tapped', () => {
    // media-2 is downloaded with local_path set
    mockMedia['media-2'] = { downloadState: 'downloaded', localPath: '/downloaded/photo2.png' };

    const renderer = renderScreen();
    const cell = findByTestId(renderer.root, 'file-cell-media-2');

    act(() => {
      cell.props.onPress();
    });

    // Lightbox should now be visible
    expect(hasHostTestId(renderer.root, 'media-lightbox')).toBe(true);
    delete mockMedia['media-2'];
  });

  it('triggers download when a non-downloaded cell is tapped', () => {
    const { downloadAndDecryptMedia } = require('../../services/mediaDownloadService');

    const renderer = renderScreen();
    const cell = findByTestId(renderer.root, 'file-cell-media-1');

    act(() => {
      cell.props.onPress();
    });

    expect(downloadAndDecryptMedia).toHaveBeenCalledWith('media-1');
  });

  it('does not trigger download for an item already downloading', () => {
    const { downloadAndDecryptMedia } = require('../../services/mediaDownloadService');
    downloadAndDecryptMedia.mockClear();

    mockMedia['media-1'] = { downloadState: 'downloading', localPath: null };

    const renderer = renderScreen();
    const cell = findByTestId(renderer.root, 'file-cell-media-1');

    act(() => {
      cell.props.onPress();
    });

    expect(downloadAndDecryptMedia).not.toHaveBeenCalled();
    delete mockMedia['media-1'];
  });
});

describe('FileLibraryScreen — unavailable tile states', () => {
  it('renders non-pressable "No longer available" tile when unavailable + no localPath', () => {
    mockMedia['media-1'] = { downloadState: 'unavailable', localPath: null };

    const renderer = renderScreen();

    // The unavailable tile should be present
    expect(hasHostTestId(renderer.root, 'file-cell-media-1-unavailable')).toBe(true);
    const tile = findHostByTestId(renderer.root, 'file-cell-media-1-unavailable');

    // Should contain 'No longer available' text
    const texts = tile.findAllByType('Text' as unknown as React.ComponentType);
    const textContent = texts.map(t => {
      const children = t.props.children;
      return typeof children === 'string' ? children : '';
    }).join(' ');
    expect(textContent).toContain('No longer available');

    delete mockMedia['media-1'];
  });

  it('renders download-prompt tile (not unavailable) when unavailable + localPath present', () => {
    mockMedia['media-1'] = { downloadState: 'unavailable', localPath: '/some/local/file.jpg' };

    const renderer = renderScreen();

    // The unavailable tile should NOT be present (localPath exists -> falls through)
    expect(hasHostTestId(renderer.root, 'file-cell-media-1-unavailable')).toBe(false);

    // The pressable download-prompt tile should be present
    // (isDownloaded requires downloadState === 'downloaded', so this falls through
    //  past the unavailable guard to the download-prompt branch)
    expect(hasHostTestId(renderer.root, 'file-cell-media-1')).toBe(true);

    delete mockMedia['media-1'];
  });
});

describe('FileLibraryScreen — empty state', () => {
  it('shows empty state when no media is available', () => {
    const { getAllMedia } = require('../../database/repositories/mediaRepository');
    getAllMedia.mockReturnValue([]);

    const renderer = renderScreen();
    expect(hasHostTestId(renderer.root, 'empty-state')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canExport wiring (#878)
//
// This screen is the ONE lightbox host that supplies `canExport`, because it
// is the only one that can list ORPHANS: leaving an orbit deletes its threads
// and replies but leaves `orbital_media` rows behind, so their resolved
// conversation_id is NULL and the grid still shows them under "All Orbits"
// (deliberate — the grid is unchanged). Everything else about Save is covered
// in MediaLightbox.test.tsx; this block asserts the projection only.
// ---------------------------------------------------------------------------

describe('FileLibraryScreen — canExport wiring', () => {
  // The "empty state" block above leaves getAllMedia pinned to [] (jest's
  // clearAllMocks does not remove an implementation), so each test here states
  // its own page explicitly rather than inheriting the factory default.
  beforeEach(() => {
    const repo = jest.requireMock('../../database/repositories/mediaRepository');
    (repo.getAllMedia as jest.Mock).mockReturnValue(mockMediaRows);
  });

  /** The props from the most recent MediaLightbox render. */
  function lastLightboxProps(): Record<string, unknown> {
    expect(mockLightboxProps.length).toBeGreaterThan(0);
    return mockLightboxProps[mockLightboxProps.length - 1];
  }

  function canExport(): (id: string) => boolean {
    const fn = lastLightboxProps().canExport;
    expect(typeof fn).toBe('function');
    return fn as (id: string) => boolean;
  }

  it('supplies a canExport predicate to the lightbox', () => {
    renderScreen();
    expect(canExport()).toBeInstanceOf(Function);
  });

  it('allows rows whose conversation is in the store', () => {
    renderScreen();
    // Both default rows resolve to conversations the user is in.
    expect(canExport()('media-1')).toBe(true);
    expect(canExport()('media-2')).toBe(true);
  });

  it('refuses an ORPHAN row (conversation_id is NULL)', () => {
    const repo = jest.requireMock('../../database/repositories/mediaRepository');
    (repo.getAllMedia as jest.Mock).mockReturnValue([
      { ...mockMediaRows[0], id: 'orphan-1', conversation_id: null },
      { ...mockMediaRows[1], id: 'kept-1', conversation_id: 'conv-1' },
    ]);

    renderScreen();

    expect(canExport()('orphan-1')).toBe(false);
    expect(canExport()('kept-1')).toBe(true);
  });

  it('refuses a row from a conversation the user has left', () => {
    const repo = jest.requireMock('../../database/repositories/mediaRepository');
    (repo.getAllMedia as jest.Mock).mockReturnValue([
      { ...mockMediaRows[0], id: 'left-1', conversation_id: 'conv-gone' },
    ]);

    renderScreen();

    expect(canExport()('left-1')).toBe(false);
  });

  it('refuses an id that is not on the loaded page at all', () => {
    renderScreen();
    expect(canExport()('never-loaded')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Save all (#878 PR 2)
//
// The screen owns the whole conversation — disclosure, the zero and
// low-storage arms, the confirm Alert, the permission — and `bulkExportRunner`
// owns the run. So what is asserted here is the ORDER of the gates and the
// fact that each refusal stops short of `startBulkExport`; the copy and the
// run mechanics are covered in bulkExportRunner's own suite.
//
// No fake timers anywhere in this file (#834): a scoped fake-timer test in the
// Lightbox family failed unrelated suites, so the async flow is driven with
// `await act(async () => {})` microtask flushes instead.
// ---------------------------------------------------------------------------

describe('FileLibraryScreen — Save all (#878)', () => {
  let alertSpy: jest.SpyInstance;
  let announceSpy: jest.SpyInstance;

  // Same reason as the canExport block: the "empty state" test leaves
  // getAllMedia pinned to [], so this block states its own page.
  beforeEach(() => {
    const repo = jest.requireMock('../../database/repositories/mediaRepository');
    (repo.getAllMedia as jest.Mock).mockReturnValue(mockMediaRows);

    // jest.setup.ts mocks nothing from react-native, so both of these are ours
    // to install and to restore.
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    announceSpy = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});

    bulkRunner().prepareBulkExport.mockResolvedValue(makePlan());
    bulkRunner().checkBulkExportSpace.mockResolvedValue({
      ok: true,
      requiredBytes: 4 * 1024 * 1024,
      freeBytes: 1024 * 1024 * 1024,
    });
  });

  afterEach(() => {
    alertSpy.mockRestore();
    announceSpy.mockRestore();
  });

  /** Tap "Save all" and let the flow run as far as its next await. */
  async function pressSaveAll(renderer: ReactTestRenderer): Promise<void> {
    await act(async () => {
      findByTestId(renderer.root, 'save-all-button').props.onPress();
    });
  }

  /** The buttons of the nth Alert — `Alert.alert`'s 3rd argument. */
  function alertButtons(index: number): AlertButton[] {
    const buttons = alertSpy.mock.calls[index][2];
    expect(Array.isArray(buttons)).toBe(true);
    return buttons as AlertButton[];
  }

  /** Titles of every Alert raised so far, in order. */
  function alertTitles(): unknown[] {
    return alertSpy.mock.calls.map((call) => call[0]);
  }

  function setBulkState(next: BulkStateShape): void {
    bulkRunner().bulkExportStore.setState(next, true);
  }

  it('renders an enabled Save all button while the store is idle', () => {
    const renderer = renderScreen();

    expect(hasHostTestId(renderer.root, 'save-all-button')).toBe(true);
    const host = findHostByTestId(renderer.root, 'save-all-button');
    expect(host.props.accessibilityState.disabled).toBe(false);
  });

  it('asks for the disclosure, then snapshots, then confirms, then starts', async () => {
    const runner = bulkRunner();
    const svc = exportService();
    const renderer = renderScreen();

    await pressSaveAll(renderer);

    // Gate 1 comes BEFORE any DB work: the disclosure must not be shown
    // after the app has already gone looking at the user's media.
    expect(svc.ensureExportDisclosure).toHaveBeenCalledTimes(1);
    expect(runner.prepareBulkExport).toHaveBeenCalledTimes(1);
    expect(svc.ensureExportDisclosure.mock.invocationCallOrder[0]).toBeLessThan(
      runner.prepareBulkExport.mock.invocationCallOrder[0],
    );

    // The confirm body is the plan rendered by `describeBulkConfirm` — the
    // screen never builds that string itself.
    expect(runner.describeBulkConfirm).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe('Save all');
    expect(alertSpy.mock.calls[0][1]).toBe('CONFIRM_BODY');

    // Nothing has been asked of the OS yet.
    expect(svc.ensureBulkExportPermission).not.toHaveBeenCalled();
    expect(runner.startBulkExport).not.toHaveBeenCalled();

    await act(async () => {
      alertButtons(0)[1].onPress?.();
    });

    expect(svc.ensureBulkExportPermission).toHaveBeenCalledTimes(1);
    expect(runner.startBulkExport).toHaveBeenCalledTimes(1);
  });

  it('takes no snapshot when the disclosure is declined', async () => {
    exportService().ensureExportDisclosure.mockResolvedValue(false);
    const renderer = renderScreen();

    await pressSaveAll(renderer);

    expect(bulkRunner().prepareBulkExport).not.toHaveBeenCalled();
    expect(bulkRunner().startBulkExport).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('shows "Nothing to save" for an empty plan and starts nothing', async () => {
    bulkRunner().prepareBulkExport.mockResolvedValue(makePlan({ ids: [], count: 0 }));
    const renderer = renderScreen();

    await pressSaveAll(renderer);

    expect(alertTitles()).toEqual(['Nothing to save']);
    expect(bulkRunner().checkBulkExportSpace).not.toHaveBeenCalled();
    expect(bulkRunner().startBulkExport).not.toHaveBeenCalled();
  });

  it('blocks on low storage without reaching the confirm', async () => {
    bulkRunner().checkBulkExportSpace.mockResolvedValue({
      ok: false,
      requiredBytes: 900 * 1024 * 1024,
      freeBytes: 0,
    });
    const renderer = renderScreen();

    await pressSaveAll(renderer);

    expect(alertTitles()).toEqual(['Not enough storage']);
    expect(alertTitles()).not.toContain('Save all');
    expect(exportService().ensureBulkExportPermission).not.toHaveBeenCalled();
    expect(bulkRunner().startBulkExport).not.toHaveBeenCalled();
  });

  it('refuses to start when membership never hydrated (plan is null)', async () => {
    bulkRunner().prepareBulkExport.mockResolvedValue(null);
    const renderer = renderScreen();

    await pressSaveAll(renderer);

    expect(alertTitles()).toEqual(["Can't save yet"]);
    expect(bulkRunner().checkBulkExportSpace).not.toHaveBeenCalled();
    expect(bulkRunner().startBulkExport).not.toHaveBeenCalled();
  });

  it('asks for no permission when the confirm is cancelled', async () => {
    const renderer = renderScreen();

    await pressSaveAll(renderer);
    expect(alertSpy.mock.calls[0][0]).toBe('Save all');

    await act(async () => {
      alertButtons(0)[0].onPress?.();
    });

    expect(exportService().ensureBulkExportPermission).not.toHaveBeenCalled();
    expect(bulkRunner().startBulkExport).not.toHaveBeenCalled();
  });

  it('starts nothing when the permission is refused', async () => {
    exportService().ensureBulkExportPermission.mockResolvedValue({
      granted: false,
      photosToFiles: false,
    });
    const renderer = renderScreen();

    await pressSaveAll(renderer);
    await act(async () => {
      alertButtons(0)[1].onPress?.();
    });

    expect(exportService().ensureBulkExportPermission).toHaveBeenCalledTimes(1);
    expect(bulkRunner().startBulkExport).not.toHaveBeenCalled();
  });

  it('reattaches to a run already in flight on mount', () => {
    // The reattach case: the run was started on a PREVIOUS mount, so the state
    // is in the store before this screen renders at all.
    setBulkState({ phase: 'running', total: 37, completed: 12, summary: null });

    const renderer = renderScreen();

    expect(hasHostTestId(renderer.root, 'bulk-export-panel')).toBe(true);
    expect(hasHostTestId(renderer.root, 'bulk-export-label')).toBe(true);
    expect(findHostByTestId(renderer.root, 'bulk-export-label').props.children).toBe(
      '12 of 37 items',
    );
    expect(hasHostTestId(renderer.root, 'bulk-export-bar')).toBe(true);
    expect(hasHostTestId(renderer.root, 'bulk-export-paused')).toBe(false);

    // The header button is disabled for the duration of the run.
    expect(
      findHostByTestId(renderer.root, 'save-all-button').props.accessibilityState.disabled,
    ).toBe(true);

    // The bar carries NO progressbar role: a live value would announce on
    // every item, so the screen announces start/pause/finish instead.
    const bar = findHostByTestId(renderer.root, 'bulk-export-bar');
    expect(bar.props.accessibilityRole).toBeUndefined();
    expect(bar.props.accessibilityValue).toBeUndefined();
  });

  it('renders the paused marker while the run is paused', () => {
    setBulkState({ phase: 'paused', total: 37, completed: 12, summary: null });

    const renderer = renderScreen();

    expect(hasHostTestId(renderer.root, 'bulk-export-panel')).toBe(true);
    expect(hasHostTestId(renderer.root, 'bulk-export-paused')).toBe(true);
  });

  it('cancels the run from the panel', () => {
    setBulkState({ phase: 'running', total: 37, completed: 12, summary: null });

    const renderer = renderScreen();
    act(() => {
      findByTestId(renderer.root, 'bulk-export-cancel').props.onPress();
    });

    expect(bulkRunner().cancelBulkExport).toHaveBeenCalledTimes(1);
  });

  it('reports a finished run in the summary card, dismissable', () => {
    setBulkState({
      phase: 'done',
      total: 37,
      completed: 37,
      summary: {
        saved: 35,
        skipped: 1,
        failed: 1,
        destinations: ['photos'],
        stoppedForSpace: false,
        cancelled: false,
      },
    });

    const renderer = renderScreen();

    expect(hasHostTestId(renderer.root, 'bulk-export-summary')).toBe(true);
    expect(
      findHostByTestId(renderer.root, 'bulk-export-summary-message').props.children,
    ).toBe('SUMMARY_LINE');
    // The progress panel is gone — `done` is not an active run.
    expect(hasHostTestId(renderer.root, 'bulk-export-panel')).toBe(false);

    act(() => {
      findByTestId(renderer.root, 'bulk-export-dismiss').props.onPress();
    });

    expect(bulkRunner().dismissBulkExportSummary).toHaveBeenCalledTimes(1);
  });

  it('announces start, pause and finish — and nothing per item', () => {
    renderScreen();
    expect(announceSpy).not.toHaveBeenCalled();

    act(() => {
      setBulkState({ phase: 'running', total: 37, completed: 0, summary: null });
    });
    expect(announceSpy).toHaveBeenCalledTimes(1);
    expect(announceSpy).toHaveBeenLastCalledWith('Saving 37 items');

    // A per-item tick must stay silent: 37 items would mean 37 announcements.
    act(() => {
      setBulkState({ phase: 'running', total: 37, completed: 1, summary: null });
    });
    act(() => {
      setBulkState({ phase: 'running', total: 37, completed: 2, summary: null });
    });
    expect(announceSpy).toHaveBeenCalledTimes(1);

    act(() => {
      setBulkState({ phase: 'paused', total: 37, completed: 2, summary: null });
    });
    expect(announceSpy).toHaveBeenCalledTimes(2);
    expect(announceSpy).toHaveBeenLastCalledWith('Saving paused');

    act(() => {
      setBulkState({
        phase: 'done',
        total: 37,
        completed: 37,
        summary: {
          saved: 37,
          skipped: 0,
          failed: 0,
          destinations: ['photos'],
          stoppedForSpace: false,
          cancelled: false,
        },
      });
    });
    expect(announceSpy).toHaveBeenCalledTimes(3);
    expect(announceSpy).toHaveBeenLastCalledWith('SUMMARY_LINE');
  });
});
