/**
 * Tests for mediaPrefetchService — drain logic, filtering, single-flight, debounce.
 */

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/tmp/test-docs',
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

import { drainPendingMediaDownloads, schedulePendingMediaDrain } from '../mediaPrefetchService';

beforeEach(() => {
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
