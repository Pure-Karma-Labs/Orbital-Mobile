/**
 * Tests for mediaArchiveConfirmService — confirmArchived matrix, drain behavior,
 * debounce, foreground listener, clearArchiveConfirmState.
 */

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

const mockArchiveConfirm = jest.fn();

jest.mock('../api/media', () => ({
  archiveConfirm: (...args: unknown[]) => mockArchiveConfirm(...args),
}));

const mockGetMedia = jest.fn();
const mockGetUnconfirmedDownloadedMedia = jest.fn();
const mockSetArchiveConfirmed = jest.fn();

jest.mock('../../database/repositories/mediaRepository', () => ({
  getMedia: (...args: unknown[]) => mockGetMedia(...args),
  getUnconfirmedDownloadedMedia: (...args: unknown[]) => mockGetUnconfirmedDownloadedMedia(...args),
  setArchiveConfirmed: (...args: unknown[]) => mockSetArchiveConfirmed(...args),
}));

jest.mock('../../database/connection', () => ({
  isDatabaseInitialized: jest.fn(() => true),
}));

import {
  confirmArchived,
  drainPendingArchiveConfirms,
  scheduleArchiveConfirmDrain,
  registerForegroundConfirmDrain,
  unregisterForegroundConfirmDrain,
  clearArchiveConfirmState,
} from '../mediaArchiveConfirmService';
import { NotFoundError, AuthError, NetworkError, ApiError } from '../api/errors';
import { AppState } from 'react-native';
import { isDatabaseInitialized } from '../../database/connection';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockGetMedia.mockReturnValue(null);
  mockGetUnconfirmedDownloadedMedia.mockReturnValue([]);
  mockArchiveConfirm.mockResolvedValue({
    mediaId: 'media-1',
    confirmedAt: '2026-07-21T00:00:00Z',
    status: 'available',
  });
  // Restore isDatabaseInitialized — clearAllMocks does not reset mockReturnValue
  (isDatabaseInitialized as jest.Mock).mockReturnValue(true);
  // Reset module state between tests
  clearArchiveConfirmState();
});

afterEach(() => {
  jest.useRealTimers();
  clearArchiveConfirmState();
});

// ---------------------------------------------------------------------------
// confirmArchived — matrix
// ---------------------------------------------------------------------------

describe('confirmArchived', () => {
  it('returns confirmed on 200 and marks DB', async () => {
    const result = await confirmArchived('media-1');

    expect(result).toBe('confirmed');
    expect(mockArchiveConfirm).toHaveBeenCalledWith('media-1');
    expect(mockSetArchiveConfirmed).toHaveBeenCalledWith('media-1');
  });

  it('skips API call when already flagged locally', async () => {
    mockGetMedia.mockReturnValue({ archive_confirmed: 1 });

    const result = await confirmArchived('media-1');

    expect(result).toBe('confirmed');
    expect(mockArchiveConfirm).not.toHaveBeenCalled();
    expect(mockSetArchiveConfirmed).not.toHaveBeenCalled();
  });

  it('returns terminal and marks on 404 (NotFoundError)', async () => {
    mockArchiveConfirm.mockRejectedValue(new NotFoundError('gone'));

    const result = await confirmArchived('media-1');

    expect(result).toBe('terminal');
    expect(mockSetArchiveConfirmed).toHaveBeenCalledWith('media-1');
  });

  it('returns terminal and marks on 403 (AuthError — left group)', async () => {
    mockArchiveConfirm.mockRejectedValue(new AuthError(403, 'forbidden'));

    const result = await confirmArchived('media-1');

    expect(result).toBe('terminal');
    expect(mockSetArchiveConfirmed).toHaveBeenCalledWith('media-1');
  });

  it('returns transient on 401 (AuthError) — no mark', async () => {
    mockArchiveConfirm.mockRejectedValue(new AuthError(401, 'unauthorized'));

    const result = await confirmArchived('media-1');

    expect(result).toBe('transient');
    expect(mockSetArchiveConfirmed).not.toHaveBeenCalled();
  });

  it('returns transient on NetworkError — no mark', async () => {
    mockArchiveConfirm.mockRejectedValue(new NetworkError('offline'));

    const result = await confirmArchived('media-1');

    expect(result).toBe('transient');
    expect(mockSetArchiveConfirmed).not.toHaveBeenCalled();
  });

  it('returns transient on 429 ApiError — no mark', async () => {
    mockArchiveConfirm.mockRejectedValue(
      new ApiError('Rate limited', 429, 'RATE_LIMITED', true),
    );

    const result = await confirmArchived('media-1');

    expect(result).toBe('transient');
    expect(mockSetArchiveConfirmed).not.toHaveBeenCalled();
  });

  it('returns transient on unknown error — no mark', async () => {
    mockArchiveConfirm.mockRejectedValue(new Error('something unexpected'));

    const result = await confirmArchived('media-1');

    expect(result).toBe('transient');
    expect(mockSetArchiveConfirmed).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    mockArchiveConfirm.mockRejectedValue(new Error('boom'));

    await expect(confirmArchived('media-1')).resolves.toBe('transient');
  });
});

// ---------------------------------------------------------------------------
// drainPendingArchiveConfirms
// ---------------------------------------------------------------------------

describe('drainPendingArchiveConfirms', () => {
  it('processes rows sequentially', async () => {
    const callOrder: string[] = [];
    mockGetUnconfirmedDownloadedMedia.mockReturnValue([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
    mockArchiveConfirm.mockImplementation(async (id: string) => {
      callOrder.push(id);
      return { mediaId: id, confirmedAt: 'now', status: 'available' };
    });

    await drainPendingArchiveConfirms();

    expect(callOrder).toEqual(['a', 'b', 'c']);
    expect(mockSetArchiveConfirmed).toHaveBeenCalledTimes(3);
  });

  it('stops on transient error, leaving remainder unmarked', async () => {
    mockGetUnconfirmedDownloadedMedia.mockReturnValue([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
    mockArchiveConfirm
      .mockResolvedValueOnce({ mediaId: 'a', confirmedAt: 'now', status: 'available' })
      .mockRejectedValueOnce(new NetworkError('offline'));

    await drainPendingArchiveConfirms();

    // 'a' confirmed, 'b' transient (stops drain), 'c' never attempted
    expect(mockSetArchiveConfirmed).toHaveBeenCalledWith('a');
    expect(mockSetArchiveConfirmed).toHaveBeenCalledTimes(1);
    // archiveConfirm called for a and b, not c
    expect(mockArchiveConfirm).toHaveBeenCalledTimes(2);
  });

  it('continues through 404/403 terminal errors', async () => {
    mockGetUnconfirmedDownloadedMedia.mockReturnValue([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
    mockArchiveConfirm
      .mockRejectedValueOnce(new NotFoundError('gone'))        // a: terminal
      .mockRejectedValueOnce(new AuthError(403, 'forbidden'))  // b: terminal
      .mockResolvedValueOnce({ mediaId: 'c', confirmedAt: 'now', status: 'available' }); // c: confirmed

    await drainPendingArchiveConfirms();

    expect(mockSetArchiveConfirmed).toHaveBeenCalledWith('a');
    expect(mockSetArchiveConfirmed).toHaveBeenCalledWith('b');
    expect(mockSetArchiveConfirmed).toHaveBeenCalledWith('c');
    expect(mockSetArchiveConfirmed).toHaveBeenCalledTimes(3);
  });

  it('single-flight: concurrent calls coalesce with rerunRequested', async () => {
    let resolveFirst!: () => void;
    const firstDrain = new Promise<void>((r) => { resolveFirst = r; });

    mockGetUnconfirmedDownloadedMedia.mockReturnValueOnce([{ id: 'a' }]);
    mockArchiveConfirm.mockImplementationOnce(async () => {
      await firstDrain;
      return { mediaId: 'a', confirmedAt: 'now', status: 'available' };
    });

    const p1 = drainPendingArchiveConfirms();

    // Second call while first is in flight — should set rerunRequested
    mockGetUnconfirmedDownloadedMedia.mockReturnValueOnce([{ id: 'b' }]);
    mockArchiveConfirm.mockResolvedValueOnce({
      mediaId: 'b', confirmedAt: 'now', status: 'available',
    });
    const p2 = drainPendingArchiveConfirms();

    // Resolve the first drain
    resolveFirst();
    await p1;
    await p2;

    // 'a' from first drain, 'b' from rerun
    expect(mockArchiveConfirm).toHaveBeenCalledTimes(2);
  });

  it('does NOT rerun after error-stop', async () => {
    mockGetUnconfirmedDownloadedMedia.mockReturnValue([{ id: 'a' }]);

    let resolveFirst!: () => void;
    const firstDrain = new Promise<void>((r) => { resolveFirst = r; });

    mockArchiveConfirm.mockImplementationOnce(async () => {
      await firstDrain;
      throw new NetworkError('offline');
    });

    const p1 = drainPendingArchiveConfirms();
    // Request rerun while first is in flight
    drainPendingArchiveConfirms();

    resolveFirst();
    await p1;

    // Despite rerunRequested being set, error-stop should prevent rerun
    // The mock was called once for 'a' (which failed), no rerun
    expect(mockArchiveConfirm).toHaveBeenCalledTimes(1);
  });

  it('returns early when database is not initialized', async () => {
    (isDatabaseInitialized as jest.Mock).mockReturnValue(false);

    await drainPendingArchiveConfirms();

    expect(mockGetUnconfirmedDownloadedMedia).not.toHaveBeenCalled();
  });

  it('returns early when no unconfirmed rows', async () => {
    mockGetUnconfirmedDownloadedMedia.mockReturnValue([]);

    await drainPendingArchiveConfirms();

    expect(mockArchiveConfirm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// scheduleArchiveConfirmDrain — debounce
// ---------------------------------------------------------------------------

describe('scheduleArchiveConfirmDrain', () => {
  it('schedules drain after DEBOUNCE_MS', () => {
    mockGetUnconfirmedDownloadedMedia.mockReturnValue([]);

    scheduleArchiveConfirmDrain();

    // Not fired yet
    expect(mockGetUnconfirmedDownloadedMedia).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2000);

    expect(mockGetUnconfirmedDownloadedMedia).toHaveBeenCalled();
  });

  it('debounces multiple calls', () => {
    mockGetUnconfirmedDownloadedMedia.mockReturnValue([]);

    scheduleArchiveConfirmDrain();
    jest.advanceTimersByTime(1000);
    scheduleArchiveConfirmDrain(); // resets the timer

    jest.advanceTimersByTime(1500);
    // Not yet — only 1500ms since last call
    expect(mockGetUnconfirmedDownloadedMedia).not.toHaveBeenCalled();

    jest.advanceTimersByTime(500);
    expect(mockGetUnconfirmedDownloadedMedia).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// registerForegroundConfirmDrain / unregisterForegroundConfirmDrain
// ---------------------------------------------------------------------------

describe('foreground drain listener', () => {
  it('registers AppState listener', () => {
    registerForegroundConfirmDrain();

    expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('is idempotent — multiple calls do not add duplicate listeners', () => {
    registerForegroundConfirmDrain();
    registerForegroundConfirmDrain();

    expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
  });

  it('unregisters AppState listener', () => {
    const mockRemove = jest.fn();
    (AppState.addEventListener as jest.Mock).mockReturnValueOnce({ remove: mockRemove });

    registerForegroundConfirmDrain();
    unregisterForegroundConfirmDrain();

    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('triggers drain on active state change', () => {
    mockGetUnconfirmedDownloadedMedia.mockReturnValue([]);
    let capturedHandler: ((state: string) => void) | null = null;
    (AppState.addEventListener as jest.Mock).mockImplementationOnce(
      (_event: string, handler: (state: string) => void) => {
        capturedHandler = handler;
        return { remove: jest.fn() };
      },
    );

    registerForegroundConfirmDrain();
    expect(capturedHandler).not.toBeNull();

    capturedHandler!('active');
    jest.advanceTimersByTime(2000);

    expect(mockGetUnconfirmedDownloadedMedia).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// clearArchiveConfirmState
// ---------------------------------------------------------------------------

describe('clearArchiveConfirmState', () => {
  it('cancels pending timer', () => {
    scheduleArchiveConfirmDrain();
    clearArchiveConfirmState();

    jest.advanceTimersByTime(5000);
    expect(mockGetUnconfirmedDownloadedMedia).not.toHaveBeenCalled();
  });

  it('removes AppState listener', () => {
    const mockRemove = jest.fn();
    (AppState.addEventListener as jest.Mock).mockReturnValueOnce({ remove: mockRemove });

    registerForegroundConfirmDrain();
    clearArchiveConfirmState();

    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('resets flags so next drain is not blocked', async () => {
    // Simulate a state where draining was true
    mockGetUnconfirmedDownloadedMedia.mockReturnValue([{ id: 'a' }]);
    mockArchiveConfirm.mockResolvedValue({
      mediaId: 'a', confirmedAt: 'now', status: 'available',
    });

    // Run a drain then clear state
    await drainPendingArchiveConfirms();
    clearArchiveConfirmState();

    // Should be able to drain again
    jest.clearAllMocks();
    (isDatabaseInitialized as jest.Mock).mockReturnValue(true);
    mockGetUnconfirmedDownloadedMedia.mockReturnValue([{ id: 'b' }]);
    mockArchiveConfirm.mockResolvedValue({
      mediaId: 'b', confirmedAt: 'now', status: 'available',
    });

    await drainPendingArchiveConfirms();
    expect(mockArchiveConfirm).toHaveBeenCalledWith('b');
  });
});
