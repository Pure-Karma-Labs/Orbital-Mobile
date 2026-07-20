/**
 * Tests for mediaPrefetchService — drain logic, filtering, single-flight, debounce,
 * and clearPrefetchState teardown.
 */

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/tmp/test-docs',
}));

const mockRemoveSubscription = jest.fn();
const mockAddEventListener = jest.fn(
  (_type: string, _handler: (...a: unknown[]) => void) => ({ remove: mockRemoveSubscription }),
);
jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (type: string, handler: (...a: unknown[]) => void) =>
      mockAddEventListener(type, handler),
    currentState: 'active',
  },
}));

const mockIsDatabaseInitialized = jest.fn(() => true);
jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: () => mockIsDatabaseInitialized(),
}));

const mockGetPendingDownloadsWithKeys = jest.fn();
jest.mock('../../database/repositories/mediaRepository', () => ({
  getPendingDownloadsWithKeys: (...args: unknown[]) => mockGetPendingDownloadsWithKeys(...args),
}));

const mockDownloadAndDecryptMedia = jest.fn();
jest.mock('../mediaDownloadService', () => ({
  downloadAndDecryptMedia: (...args: unknown[]) => mockDownloadAndDecryptMedia(...args),
}));

import {
  drainPendingMediaDownloads,
  schedulePendingMediaDrain,
  registerForegroundDrain,
  clearPrefetchState,
} from '../mediaPrefetchService';

beforeEach(() => {
  // Reset module-level state FIRST (review finding — prevents order-dependent tests)
  clearPrefetchState();
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockIsDatabaseInitialized.mockReturnValue(true);
  mockGetPendingDownloadsWithKeys.mockReturnValue([]);
  mockDownloadAndDecryptMedia.mockResolvedValue('/some/path');
});

afterEach(() => {
  jest.useRealTimers();
});

describe('drainPendingMediaDownloads', () => {
  it('no-op when database is not initialized', async () => {
    mockIsDatabaseInitialized.mockReturnValue(false);
    await drainPendingMediaDownloads();
    expect(mockGetPendingDownloadsWithKeys).not.toHaveBeenCalled();
  });

  it('no-op when no pending downloads', async () => {
    mockGetPendingDownloadsWithKeys.mockReturnValue([]);
    await drainPendingMediaDownloads();
    expect(mockDownloadAndDecryptMedia).not.toHaveBeenCalled();
  });

  it('downloads all pending items', async () => {
    mockGetPendingDownloadsWithKeys.mockReturnValue([
      { id: 'media-1' },
      { id: 'media-2' },
      { id: 'media-3' },
    ]);
    await drainPendingMediaDownloads();
    expect(mockDownloadAndDecryptMedia).toHaveBeenCalledTimes(3);
    expect(mockDownloadAndDecryptMedia).toHaveBeenCalledWith('media-1');
    expect(mockDownloadAndDecryptMedia).toHaveBeenCalledWith('media-2');
    expect(mockDownloadAndDecryptMedia).toHaveBeenCalledWith('media-3');
  });

  it('swallows per-item failures', async () => {
    mockGetPendingDownloadsWithKeys.mockReturnValue([
      { id: 'ok' },
      { id: 'fail' },
    ]);
    mockDownloadAndDecryptMedia.mockImplementation((id: string) =>
      id === 'fail' ? Promise.reject(new Error('404')) : Promise.resolve('/path'),
    );
    // Should not throw
    await drainPendingMediaDownloads();
    expect(mockDownloadAndDecryptMedia).toHaveBeenCalledTimes(2);
  });

  it('requests correct batch limit', async () => {
    mockGetPendingDownloadsWithKeys.mockReturnValue([]);
    await drainPendingMediaDownloads();
    expect(mockGetPendingDownloadsWithKeys).toHaveBeenCalledWith(25);
  });
});

describe('schedulePendingMediaDrain', () => {
  it('debounces calls (trailing)', () => {
    schedulePendingMediaDrain();
    schedulePendingMediaDrain();
    schedulePendingMediaDrain();

    // Should not have drained yet
    expect(mockGetPendingDownloadsWithKeys).not.toHaveBeenCalled();

    // Advance past debounce window
    jest.advanceTimersByTime(2_500);

    // Now it should have been called once
    expect(mockGetPendingDownloadsWithKeys).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// clearPrefetchState
// ---------------------------------------------------------------------------

describe('clearPrefetchState', () => {
  it('cancels a scheduled drain so it never fires', () => {
    // Schedule a drain (sets the debounce timer)
    schedulePendingMediaDrain();

    // Clear state before debounce fires
    clearPrefetchState();

    // Advance well past the debounce window
    jest.advanceTimersByTime(5_000);

    // The drain should never have been called
    expect(mockGetPendingDownloadsWithKeys).not.toHaveBeenCalled();
  });

  it('removes the AppState subscription and is idempotent on double-clear', () => {
    // Register the foreground drain (creates subscription)
    registerForegroundDrain();
    expect(mockAddEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    // Clear should remove the subscription
    clearPrefetchState();
    expect(mockRemoveSubscription).toHaveBeenCalledTimes(1);

    // Double-clear should not throw and should not call remove again
    mockRemoveSubscription.mockClear();
    clearPrefetchState();
    expect(mockRemoveSubscription).not.toHaveBeenCalled();
  });

  it('resets flags so a new drain works normally after clear', async () => {
    // Run an initial drain to populate internal state
    mockGetPendingDownloadsWithKeys.mockReturnValue([{ id: 'before' }]);
    await drainPendingMediaDownloads();
    expect(mockDownloadAndDecryptMedia).toHaveBeenCalledWith('before');

    // Clear all state
    clearPrefetchState();
    jest.clearAllMocks();
    mockIsDatabaseInitialized.mockReturnValue(true);
    mockDownloadAndDecryptMedia.mockResolvedValue('/some/path');

    // A new drain should work normally
    mockGetPendingDownloadsWithKeys.mockReturnValue([{ id: 'after' }]);
    await drainPendingMediaDownloads();
    expect(mockDownloadAndDecryptMedia).toHaveBeenCalledWith('after');
  });
});
