/**
 * Tests for the "Save all" bulk runner (#878 PR 2).
 *
 * The service is mocked at its bulk boundary (`exportMediaItemInBulk`,
 * `flushStagedBulkDocuments`, `registerExportAbort`) because this suite is
 * about the RUN — ordering, concurrency, pausing, cancellation and accounting.
 * The gates themselves (disclosure, permission, access, the 0-byte guard, the
 * single native write) are the service's own suite's subject.
 *
 * NO fake timers anywhere in this file. The runner throttles emissions with a
 * real 250 ms `setTimeout`, and every assertion here reads the DRAFT through a
 * forced emission instead (`flushEmission` runs on any immediate update, and
 * every phase/summary change is immediate). #834: one scoped `useFakeTimers`
 * test in the Lightbox family failed unrelated suites 3/3.
 */

import { AppState, type AppStateStatus } from 'react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * RNFS is mocked LOCALLY, not through the root `__mocks__` automock: the root
 * mock's `getFSInfo` is a different jest.fn instance from the one the runner's
 * import resolved to, so `mockResolvedValueOnce` on it never reached this code
 * (the first version of this suite passed a space-BLOCK test vacuously).
 */
const mockGetFSInfo = jest.fn();
jest.mock('@dr.pogodin/react-native-fs', () => ({
  getFSInfo: (...a: unknown[]) => mockGetFSInfo(...a),
}));

const mockGetExportSnapshot = jest.fn();
const mockGetMediaCount = jest.fn();
jest.mock('../../../database/repositories/mediaRepository', () => ({
  getExportSnapshot: (...a: unknown[]) => mockGetExportSnapshot(...a),
  getMediaCount: (...a: unknown[]) => mockGetMediaCount(...a),
}));

/** Persisted-store state the hydration gate and the access list read. */
let mockStoreState: { conversations: Record<string, unknown>; blockedUserIds: string[] } = {
  conversations: { 'conv-1': {} },
  blockedUserIds: [],
};
let mockHasHydrated = true;
const mockHydrationListeners: Array<() => void> = [];
jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    persist: {
      hasHydrated: () => mockHasHydrated,
      onFinishHydration: (cb: () => void) => {
        mockHydrationListeners.push(cb);
        return () => {
          const at = mockHydrationListeners.indexOf(cb);
          if (at >= 0) mockHydrationListeners.splice(at, 1);
        };
      },
    },
  },
}));

const mockBeginBudget = jest.fn();
const mockEndBudget = jest.fn();
const mockExportItem = jest.fn();
const mockFlushDocuments = jest.fn();
const mockDiscardDocuments = jest.fn();
const mockStagedCount = jest.fn((..._a: unknown[]) => 0);
/** Controllers the runner handed to `registerExportAbort` — a wipe aborts these. */
const mockRegistered: AbortController[] = [];
const mockUnregisterCalls: AbortController[] = [];
jest.mock('../../mediaExportService', () => ({
  beginExportCaptureBudget: (...a: unknown[]) => mockBeginBudget(...a),
  endExportCaptureBudget: (...a: unknown[]) => mockEndBudget(...a),
  exportMediaItemInBulk: (...a: unknown[]) => mockExportItem(...a),
  flushStagedBulkDocuments: (...a: unknown[]) => mockFlushDocuments(...a),
  discardStagedBulkDocuments: (...a: unknown[]) => mockDiscardDocuments(...a),
  stagedBulkDocumentCount: (...a: unknown[]) => mockStagedCount(...a),
  registerExportAbort: (c: AbortController) => {
    mockRegistered.push(c);
    return () => {
      mockUnregisterCalls.push(c);
    };
  },
}));

import {
  bulkExportStore,
  cancelBulkExport,
  checkBulkExportSpace,
  describeBulkConfirm,
  describeBulkProgress,
  describeBulkSummary,
  dismissBulkExportSummary,
  prepareBulkExport,
  resetBulkExportForTesting,
  startBulkExport,
  type BulkExportPlan,
  type BulkExportSummary,
} from '../bulkExportRunner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FILTERS = {
  contentTypeFilter: null,
  conversationId: null,
  sortBy: 'date',
  sortOrder: 'desc',
} as const;

const GRANTED = { granted: true, photosToFiles: false };

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm-1',
    content_type: 'image/jpeg',
    file_size: 1024,
    download_state: 'downloaded',
    has_local: 1,
    ...over,
  };
}

function planFor(ids: string[]): BulkExportPlan {
  return {
    ids,
    count: ids.length,
    totalBytes: 0,
    toDownloadBytes: 0,
    maxItemBytes: 0,
    unavailableCount: 0,
    excludedCount: 0,
    needs: { photo: true, document: false },
  };
}

/** A summary with every flag off, so a test states only what it is about. */
function summaryWith(over: Partial<BulkExportSummary>): BulkExportSummary {
  return {
    saved: 0,
    skipped: 0,
    failed: 0,
    destinations: [],
    stoppedForSpace: false,
    cancelled: false,
    cancelledMidFlush: false,
    ...over,
  };
}

/** Let every queued microtask run. The runner never waits on a real timer. */
async function drain(times = 40): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** The last AppState 'change' handler the runner installed. */
let appStateHandler: ((s: AppStateStatus) => void) | null = null;
let appStateRemove: jest.Mock;
let addEventListenerSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockRegistered.length = 0;
  mockUnregisterCalls.length = 0;
  mockHydrationListeners.length = 0;
  mockHasHydrated = true;
  mockStoreState = { conversations: { 'conv-1': {} }, blockedUserIds: [] };
  appStateHandler = null;
  appStateRemove = jest.fn();
  addEventListenerSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event: string, handler: (s: AppStateStatus) => void) => {
      appStateHandler = handler;
      return { remove: appStateRemove } as never;
    });
  mockGetFSInfo.mockResolvedValue({ freeSpace: 32 * 1024 * 1024 * 1024 });
  mockGetExportSnapshot.mockReturnValue([]);
  mockGetMediaCount.mockReturnValue(0);
  mockExportItem.mockResolvedValue({ outcome: 'saved', destination: 'photos' });
  mockFlushDocuments.mockResolvedValue({ outcome: 'saved', count: 0 });
  mockStagedCount.mockReturnValue(0);
  resetBulkExportForTesting();
});

afterEach(() => {
  resetBulkExportForTesting();
  addEventListenerSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// prepareBulkExport
// ---------------------------------------------------------------------------

describe('prepareBulkExport', () => {
  it('passes the grid filters, the blocked set, the access list and the item bound to SQL', async () => {
    mockStoreState = {
      conversations: { 'conv-1': {}, 'conv-2': {} },
      blockedUserIds: ['user-bad'],
    };
    mockGetExportSnapshot.mockReturnValue([row()]);

    await prepareBulkExport({
      contentTypeFilter: 'image',
      conversationId: 'conv-2',
      sortBy: 'size',
      sortOrder: 'asc',
    });

    const [options, access, limit] = mockGetExportSnapshot.mock.calls[0];
    // #897: the blocked set rides on the OPTIONS, the one channel the grid
    // shares, so `matching` below already excludes a blocked author.
    expect(options).toMatchObject({
      contentTypeFilter: 'image',
      conversationId: 'conv-2',
      sortBy: 'size',
      sortOrder: 'asc',
      excludeAuthorIds: ['user-bad'],
    });
    // Membership only — it is the access filter, not the author filter.
    expect(access).toEqual({ conversationIds: ['conv-1', 'conv-2'] });
    expect(limit).toBe(500);

    // Both counts take the SAME options, so the matching/accessible delta is
    // orphans only rather than orphans plus blocked authors.
    for (const [countOptions] of mockGetMediaCount.mock.calls) {
      expect(countOptions).toMatchObject({ excludeAuthorIds: ['user-bad'] });
    }
  });

  it('sums the totals and separates what still has to be downloaded', async () => {
    mockGetExportSnapshot.mockReturnValue([
      row({ id: 'local', file_size: 1000, has_local: 1, download_state: 'downloaded' }),
      row({ id: 'remote', file_size: 2000, has_local: 0, download_state: 'pending' }),
    ]);
    mockGetMediaCount.mockReturnValue(2);

    const plan = await prepareBulkExport(FILTERS);

    expect(plan).not.toBeNull();
    expect(plan?.ids).toEqual(['local', 'remote']);
    expect(plan?.count).toBe(2);
    expect(plan?.totalBytes).toBe(3000);
    expect(plan?.toDownloadBytes).toBe(2000);
  });

  it('counts a refused content type as excluded, never as saveable', async () => {
    mockGetExportSnapshot.mockReturnValue([
      row({ id: 'ok' }),
      row({ id: 'evil', content_type: 'text/html' }),
      row({ id: 'evil2', content_type: 'application/x-apple-aspen-config' }),
    ]);
    mockGetMediaCount.mockReturnValue(3);

    const plan = await prepareBulkExport(FILTERS);

    expect(plan?.ids).toEqual(['ok']);
    expect(plan?.excludedCount).toBe(2);
  });

  it('counts an evicted row with no local copy as unavailable, not excluded', async () => {
    mockGetExportSnapshot.mockReturnValue([
      row({ id: 'gone', download_state: 'unavailable', has_local: 0 }),
      row({ id: 'kept', download_state: 'unavailable', has_local: 1 }),
    ]);
    mockGetMediaCount.mockReturnValue(2);

    const plan = await prepareBulkExport(FILTERS);

    expect(plan?.unavailableCount).toBe(1);
    expect(plan?.excludedCount).toBe(0);
    // A local copy wins over the server's eviction.
    expect(plan?.ids).toEqual(['kept']);
  });

  it('reports orphaned rows as excluded via the count delta', async () => {
    mockGetExportSnapshot.mockReturnValue([row({ id: 'ok' })]);
    // The grid shows 5; only 1 is accessible. Since #897 both counts already
    // exclude blocked authors, so this delta is the ORPHAN set alone.
    mockGetMediaCount.mockImplementation((_o: unknown, access?: unknown) =>
      access === undefined ? 5 : 1,
    );

    const plan = await prepareBulkExport(FILTERS);

    expect(plan?.count).toBe(1);
    expect(plan?.excludedCount).toBe(4);
  });

  it('reports rows past the item bound as excluded', async () => {
    mockGetExportSnapshot.mockReturnValue([row({ id: 'a' }), row({ id: 'b' })]);
    mockGetMediaCount.mockReturnValue(9);

    const plan = await prepareBulkExport(FILTERS);

    expect(plan?.count).toBe(2);
    expect(plan?.excludedCount).toBe(7);
  });

  it('derives the permission needs from the routes present', async () => {
    mockGetExportSnapshot.mockReturnValue([row({ id: 'photo' })]);
    mockGetMediaCount.mockReturnValue(1);
    expect((await prepareBulkExport(FILTERS))?.needs).toEqual({
      photo: true,
      document: false,
    });

    mockGetExportSnapshot.mockReturnValue([
      row({ id: 'doc', content_type: 'application/pdf' }),
    ]);
    expect((await prepareBulkExport(FILTERS))?.needs).toEqual({
      photo: false,
      document: true,
    });

    mockGetExportSnapshot.mockReturnValue([
      row({ id: 'photo' }),
      row({ id: 'doc', content_type: 'application/pdf' }),
    ]);
    expect((await prepareBulkExport(FILTERS))?.needs).toEqual({
      photo: true,
      document: true,
    });
  });

  it('returns a zero plan rather than null when nothing matches', async () => {
    mockGetExportSnapshot.mockReturnValue([]);
    const plan = await prepareBulkExport(FILTERS);
    expect(plan).not.toBeNull();
    expect(plan?.count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The blocked-users hydration gate
  // -------------------------------------------------------------------------

  it('waits for persisted membership before snapshotting', async () => {
    mockHasHydrated = false;
    mockGetExportSnapshot.mockReturnValue([row()]);

    const pending = prepareBulkExport(FILTERS);
    await drain();

    // No query yet: an empty blocked list would fail OPEN.
    expect(mockGetExportSnapshot).not.toHaveBeenCalled();
    expect(mockHydrationListeners.length).toBe(1);

    mockHasHydrated = true;
    mockStoreState = { conversations: { 'conv-1': {} }, blockedUserIds: ['user-bad'] };
    mockHydrationListeners[0]();

    const plan = await pending;
    expect(plan?.count).toBe(1);
    // The gate exists so the blocked set is HYDRATED before it is read; it is
    // read onto the options now (#897), not onto the access filter.
    expect(mockGetExportSnapshot.mock.calls[0][0]).toMatchObject({
      excludeAuthorIds: ['user-bad'],
    });
    expect(mockGetExportSnapshot.mock.calls[0][1]).toEqual({
      conversationIds: ['conv-1'],
    });
  });

  it('REFUSES the run when hydration never arrives (fails closed)', async () => {
    mockHasHydrated = false;
    mockGetExportSnapshot.mockReturnValue([row()]);

    // Scoped fake timers: this file mounts no component, so the #834 hazard
    // (an Animated chain surviving the environment teardown) does not apply.
    // Restored in the finally so nothing after this test sees a fake clock.
    jest.useFakeTimers();
    try {
      const pending = prepareBulkExport(FILTERS);
      await Promise.resolve();
      expect(mockGetExportSnapshot).not.toHaveBeenCalled();

      jest.advanceTimersByTime(5000);
      await expect(pending).resolves.toBeNull();

      // Still no query: an empty blockedUserIds list fails OPEN, so refusing
      // is the only safe answer. The screen turns null into "Can't save yet".
      expect(mockGetExportSnapshot).not.toHaveBeenCalled();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('a late hydration after the timeout cannot resolve the refusal twice', async () => {
    mockHasHydrated = false;
    jest.useFakeTimers();
    try {
      const pending = prepareBulkExport(FILTERS);
      await Promise.resolve();
      jest.advanceTimersByTime(5000);
      await expect(pending).resolves.toBeNull();

      // The listener was torn down by the timeout's own settle.
      expect(mockHydrationListeners.length).toBe(0);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('unsubscribes from hydration once it has fired', async () => {
    mockHasHydrated = false;
    const pending = prepareBulkExport(FILTERS);
    await drain();
    mockHasHydrated = true;
    mockHydrationListeners[0]();
    await pending;
    expect(mockHydrationListeners.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkBulkExportSpace
// ---------------------------------------------------------------------------

describe('checkBulkExportSpace', () => {
  const MB = 1024 * 1024;

  it('requires the download bytes, the copies and the headroom', async () => {
    mockGetFSInfo.mockResolvedValueOnce({ freeSpace: 1000 * MB });

    const space = await checkBulkExportSpace({
      toDownloadBytes: 100 * MB,
      totalBytes: 200 * MB,
      maxItemBytes: 50 * MB,
    });

    // 100 (download) + 200 (the OS copies every item)
    // + 200 (2 x 2 workers x the 50 MB item each holds twice while decrypting)
    // + 64 (headroom).
    expect(space.requiredBytes).toBe(564 * MB);
    expect(space.ok).toBe(true);
  });

  it('counts the two-workers-times-2x transient peak', async () => {
    mockGetFSInfo.mockResolvedValueOnce({ freeSpace: 1000 * MB });
    const withPeak = await checkBulkExportSpace({
      toDownloadBytes: 0,
      totalBytes: 0,
      maxItemBytes: 50 * MB,
    });
    mockGetFSInfo.mockResolvedValueOnce({ freeSpace: 1000 * MB });
    const withoutPeak = await checkBulkExportSpace({
      toDownloadBytes: 0,
      totalBytes: 0,
      maxItemBytes: 0,
    });
    // The difference is exactly 2 x WORKER_COUNT x maxItemBytes. Omitting it
    // let an approved batch stop for space mid-run, and a re-run duplicates
    // everything already saved.
    expect(withPeak.requiredBytes - withoutPeak.requiredBytes).toBe(200 * MB);
  });

  it('blocks when free space is short of the requirement', async () => {
    mockGetFSInfo.mockResolvedValueOnce({ freeSpace: 10 * MB });
    const space = await checkBulkExportSpace({
      toDownloadBytes: 0,
      totalBytes: 0,
      maxItemBytes: 0,
    });
    expect(space.ok).toBe(false);
    expect(space.freeBytes).toBe(10 * MB);
  });

  it('does not block when the free-space read itself fails', async () => {
    mockGetFSInfo.mockRejectedValueOnce(new Error('nope'));
    const space = await checkBulkExportSpace({
      toDownloadBytes: 0,
      totalBytes: 0,
      maxItemBytes: 0,
    });
    expect(space.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

describe('copy helpers', () => {
  it('describes progress as items done out of the confirmed total', () => {
    expect(
      describeBulkProgress({ phase: 'running', total: 37, completed: 12, summary: null }),
    ).toBe('12 of 37 items');
  });

  it('never shows more done than the total', () => {
    expect(
      describeBulkProgress({ phase: 'running', total: 2, completed: 9, summary: null }),
    ).toBe('2 of 2 items');
  });

  it('states the count, the size and that the originals stay', () => {
    const body = describeBulkConfirm({
      ...planFor(['a', 'b']),
      totalBytes: 1288490188,
    });
    expect(body).toContain('Save 2 items (≈1.2 GB)?');
    expect(body).toContain('The originals stay in Orbital.');
    expect(body).not.toContain('skipped');
    expect(body).not.toContain('downloaded first');
  });

  it('adds the skipped line when anything is excluded or unavailable', () => {
    const body = describeBulkConfirm({
      ...planFor(['a']),
      excludedCount: 2,
      unavailableCount: 1,
    });
    expect(body).toContain("3 items can't be saved and will be skipped");
  });

  it('warns about a large download, and only above the threshold', () => {
    const under = describeBulkConfirm({
      ...planFor(['a']),
      toDownloadBytes: 100 * 1024 * 1024,
    });
    expect(under).not.toContain('will be downloaded first');

    const over = describeBulkConfirm({
      ...planFor(['a']),
      toDownloadBytes: 850 * 1024 * 1024,
    });
    expect(over).toContain('About 850 MB will be downloaded first');
    expect(over).toContain('mobile data');
  });

  it('names both destinations when a run used both', () => {
    expect(
      describeBulkSummary(summaryWith({ saved: 3, destinations: ['photos', 'files'] })),
    ).toBe('Saved 3 items to Photos and Files.');
  });

  it('reports skipped, failed, cancellation and the storage stop', () => {
    expect(
      describeBulkSummary(
        summaryWith({ skipped: 1, failed: 2, stoppedForSpace: true, cancelled: true }),
      ),
    ).toBe("Nothing was saved. 1 item skipped. 2 items couldn't be saved. Stopped — not enough storage.");
  });

  it('says Cancelled when the user stopped it and space was not the reason', () => {
    expect(
      describeBulkSummary(
        summaryWith({ saved: 1, destinations: ['photos'], cancelled: true }),
      ),
    ).toBe('Saved 1 item to Photos. Cancelled.');
  });

  it('warns that copies may have landed when cancel hit the open picker', () => {
    expect(
      describeBulkSummary(
        summaryWith({ skipped: 2, cancelled: true, cancelledMidFlush: true }),
      ),
    ).toBe(
      'Nothing was saved. 2 items skipped. Cancelled — some copies may already have been saved.',
    );
  });

  it('prefers the storage stop over the mid-flush note', () => {
    const copy = describeBulkSummary(
      summaryWith({ stoppedForSpace: true, cancelled: true, cancelledMidFlush: true }),
    );
    expect(copy).toContain('Stopped — not enough storage.');
    expect(copy).not.toContain('already have been saved');
  });
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe('bulkExportStore', () => {
  it('starts idle', () => {
    expect(bulkExportStore.getState()).toEqual({
      phase: 'idle',
      total: 0,
      completed: 0,
      summary: null,
    });
  });

  it('keeps a STABLE snapshot identity when nothing changed', async () => {
    const before = bulkExportStore.getState();
    const listener = jest.fn();
    const unsubscribe = bulkExportStore.subscribe(listener);

    // A whole run of already-identical emissions: start, finish, dismiss.
    startBulkExport(planFor([]), GRANTED);
    expect(bulkExportStore.getState()).toBe(before);

    dismissBulkExportSummary();
    expect(bulkExportStore.getState()).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('does not subscribe to AppState at import time', () => {
    // The spy is installed fresh per test; the module was imported long before.
    expect(addEventListenerSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

describe('startBulkExport', () => {
  it('refuses an empty plan, a refused permission, and a second run', async () => {
    expect(startBulkExport(planFor([]), GRANTED)).toBe(false);
    expect(startBulkExport(planFor(['a']), { granted: false, photosToFiles: false })).toBe(
      false,
    );

    let release = (): void => {};
    mockExportItem.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ outcome: 'saved', destination: 'photos' });
        }),
    );

    expect(startBulkExport(planFor(['a']), GRANTED)).toBe(true);
    expect(startBulkExport(planFor(['b']), GRANTED)).toBe(false);

    release();
    await drain();
  });

  it('publishes total, running phase and a summary at the end', async () => {
    startBulkExport(planFor(['a', 'b', 'c']), GRANTED);
    expect(bulkExportStore.getState()).toMatchObject({
      phase: 'running',
      total: 3,
      completed: 0,
      summary: null,
    });
    expect(bulkExportStore.getState().phase).toBe('running');

    await drain();

    const state = bulkExportStore.getState();
    expect(state.phase).toBe('done');
    expect(state.completed).toBe(3);
    expect(state.summary).toEqual(
      summaryWith({ saved: 3, destinations: ['photos'] }),
    );
    expect(bulkExportStore.getState().phase).toBe('done');
  });

  it('runs at most TWO items concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    mockExportItem.mockImplementation(() => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => {
        releases.push(() => {
          inFlight -= 1;
          resolve({ outcome: 'saved', destination: 'photos' });
        });
      });
    });

    startBulkExport(planFor(['a', 'b', 'c', 'd', 'e']), GRANTED);
    await drain();
    expect(peak).toBe(2);
    expect(mockExportItem).toHaveBeenCalledTimes(2);

    // Drain the queue two at a time.
    while (releases.length > 0) {
      releases.splice(0, releases.length).forEach((r) => r());
      await drain();
    }

    expect(peak).toBe(2);
    expect(mockExportItem).toHaveBeenCalledTimes(5);
    expect(bulkExportStore.getState().summary?.saved).toBe(5);
  });

  it('registers its controller for the global wipe abort, and releases it', async () => {
    startBulkExport(planFor(['a']), GRANTED);
    expect(mockRegistered.length).toBe(1);
    await drain();
    expect(mockUnregisterCalls).toEqual([mockRegistered[0]]);
  });

  it('subscribes to AppState lazily and removes the subscription at the end', async () => {
    expect(addEventListenerSpy).not.toHaveBeenCalled();
    startBulkExport(planFor(['a']), GRANTED);
    expect(addEventListenerSpy).toHaveBeenCalledTimes(1);
    expect(appStateRemove).not.toHaveBeenCalled();
    await drain();
    expect(appStateRemove).toHaveBeenCalledTimes(1);
  });

  it('opens a per-run Sentry capture budget and closes it at the end', async () => {
    // The beforeEach reset closes a budget too, so count from here.
    const closedBefore = mockEndBudget.mock.calls.length;

    startBulkExport(planFor(['a']), GRANTED);
    expect(mockBeginBudget).toHaveBeenCalledTimes(1);
    expect(mockEndBudget.mock.calls.length).toBe(closedBefore);

    await drain();
    // One event per failure CODE for the whole run, not one per item: a
    // systemic writer failure was 500 identical Sentry events from one tap.
    expect(mockEndBudget.mock.calls.length).toBe(closedBefore + 1);
  });

  it('discards any stale staging on entry', async () => {
    startBulkExport(planFor(['a']), GRANTED);
    // A previous run cancelled mid-picker can leave entries staged; they point
    // at files chosen under a different snapshot.
    expect(mockDiscardDocuments).toHaveBeenCalled();
    await drain();
  });

  it('passes the photosToFiles reroute through to every item', async () => {
    startBulkExport(planFor(['a']), { granted: true, photosToFiles: true });
    await drain();
    expect(mockExportItem).toHaveBeenCalledWith(
      'a',
      expect.anything(),
      expect.objectContaining({ photosToFiles: true }),
    );
  });
});

describe('per-item accounting', () => {
  async function runOne(outcome: unknown): Promise<void> {
    mockExportItem.mockResolvedValue(outcome);
    startBulkExport(planFor(['a']), GRANTED);
    await drain();
  }

  it.each([
    ['unavailable', 'skipped'],
    ['notAllowed', 'skipped'],
    ['unsupported', 'skipped'],
    ['corrupt', 'skipped'],
    ['failed', 'failed'],
    ['permission', 'failed'],
  ])('counts %s as %s', async (outcome, bucket) => {
    await runOne({ outcome });
    const summary = bulkExportStore.getState().summary;
    expect(summary?.[bucket as 'skipped' | 'failed']).toBe(1);
    expect(summary?.saved).toBe(0);
  });

  it('keeps going after an item is deleted or loses access mid-batch', async () => {
    mockExportItem
      .mockResolvedValueOnce({ outcome: 'saved', destination: 'photos' })
      .mockResolvedValueOnce({ outcome: 'unavailable' })
      .mockResolvedValueOnce({ outcome: 'notAllowed' })
      .mockResolvedValueOnce({ outcome: 'saved', destination: 'photos' });

    startBulkExport(planFor(['a', 'b', 'c', 'd']), GRANTED);
    await drain();

    expect(mockExportItem).toHaveBeenCalledTimes(4);
    expect(bulkExportStore.getState().summary).toMatchObject({ saved: 2, skipped: 2 });
    expect(bulkExportStore.getState().completed).toBe(4);
  });

  it('survives an item that throws instead of resolving', async () => {
    mockExportItem.mockRejectedValueOnce(new Error('boom'));
    mockExportItem.mockResolvedValue({ outcome: 'saved', destination: 'photos' });

    startBulkExport(planFor(['a', 'b']), GRANTED);
    await drain();

    expect(bulkExportStore.getState().summary).toMatchObject({ saved: 1, failed: 1 });
  });

  it('STOPS the batch on noSpace and says so', async () => {
    mockExportItem.mockResolvedValue({ outcome: 'noSpace' });

    startBulkExport(planFor(['a', 'b', 'c', 'd', 'e', 'f']), GRANTED);
    await drain();

    const summary = bulkExportStore.getState().summary;
    expect(summary?.stoppedForSpace).toBe(true);
    // Two workers were in flight when the first noSpace landed; nothing after.
    expect(mockExportItem.mock.calls.length).toBeLessThanOrEqual(2);
    expect(bulkExportStore.getState().phase).toBe('done');
  });
});

describe('cancel', () => {
  it('aborts the run signal, stops starting items and reports Cancelled', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    mockExportItem.mockImplementation((id: string) => {
      started.push(id);
      return new Promise((resolve) => {
        releases.push(() => resolve({ outcome: 'saved', destination: 'photos' }));
      });
    });

    startBulkExport(planFor(['a', 'b', 'c', 'd']), GRANTED);
    await drain();
    expect(started).toEqual(['a', 'b']);

    cancelBulkExport();
    expect(mockRegistered[0].signal.aborted).toBe(true);

    releases.forEach((r) => r());
    await drain();

    expect(started).toEqual(['a', 'b']);
    const summary = bulkExportStore.getState().summary;
    expect(summary?.cancelled).toBe(true);
    expect(summary?.saved).toBe(2);
    expect(bulkExportStore.getState().phase).toBe('done');
  });

  it('does not count OUR OWN abort as a per-item skip', async () => {
    mockExportItem.mockImplementation(() => {
      cancelBulkExport();
      return Promise.resolve({ outcome: 'cancelled' });
    });

    startBulkExport(planFor(['a', 'b']), GRANTED);
    await drain();

    const summary = bulkExportStore.getState().summary;
    expect(summary?.cancelled).toBe(true);
    expect(summary?.skipped).toBe(0);
    expect(summary?.failed).toBe(0);
  });

  it('is a no-op with no run in flight', () => {
    expect(() => cancelBulkExport()).not.toThrow();
    expect(bulkExportStore.getState().phase).toBe('idle');
  });

  it('discards staged documents so none reach a picker', async () => {
    startBulkExport(planFor(['a']), GRANTED);
    cancelBulkExport();
    await drain();
    expect(mockDiscardDocuments).toHaveBeenCalled();
    expect(mockFlushDocuments).not.toHaveBeenCalled();
  });
});

describe('wipe', () => {
  it('unwinds when cancelAllExports aborts the mockRegistered controller', async () => {
    const releases: Array<() => void> = [];
    mockExportItem.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ outcome: 'cancelled' }));
        }),
    );

    startBulkExport(planFor(['a', 'b', 'c']), GRANTED);
    await drain();

    // What cancelAllExports() does to us: abort, synchronously, from outside.
    mockRegistered[0].abort();
    releases.forEach((r) => r());
    await drain();

    expect(bulkExportStore.getState().phase).toBe('done');
    expect(bulkExportStore.getState().summary?.cancelled).toBe(true);
    expect(mockExportItem).toHaveBeenCalledTimes(2);
  });

  it('releases a worker that is paused in the background', async () => {
    mockExportItem.mockResolvedValue({ outcome: 'failed' });
    startBulkExport(planFor(['a', 'b', 'c', 'd']), GRANTED);
    appStateHandler?.('background');
    await drain();

    // Both workers are parked waiting for the app to come back.
    const parked = mockExportItem.mock.calls.length;
    mockRegistered[0].abort();
    await drain();

    expect(mockExportItem.mock.calls.length).toBe(parked);
    expect(bulkExportStore.getState().phase).toBe('done');
  });
});

describe('background pause and resume', () => {
  it('pauses on background, starts nothing more, and resumes on active', async () => {
    const started: string[] = [];
    mockExportItem.mockImplementation((id: string) => {
      started.push(id);
      return Promise.resolve({ outcome: 'saved', destination: 'photos' });
    });

    startBulkExport(planFor(['a', 'b', 'c', 'd']), GRANTED);
    appStateHandler?.('background');
    await drain();

    expect(bulkExportStore.getState().phase).toBe('paused');
    const pausedAt = started.length;

    appStateHandler?.('active');
    await drain();

    expect(started.length).toBeGreaterThan(pausedAt);
    expect(bulkExportStore.getState().phase).toBe('done');
  });

  it('does NOT pause on iOS "inactive" — that is our own picker or alert', async () => {
    const releases: Array<() => void> = [];
    mockExportItem.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ outcome: 'saved', destination: 'photos' }));
        }),
    );

    startBulkExport(planFor(['a', 'b', 'c']), GRANTED);
    appStateHandler?.('inactive');
    await drain();

    expect(bulkExportStore.getState().phase).toBe('running');

    while (releases.length > 0) {
      releases.splice(0, releases.length).forEach((r) => r());
      await drain();
    }
    expect(bulkExportStore.getState().summary?.saved).toBe(3);
  });

  it('re-queues an item that failed while backgrounded — ONCE', async () => {
    const attempts: string[] = [];
    mockExportItem.mockImplementation((id: string) => {
      attempts.push(id);
      return Promise.resolve({ outcome: 'failed' });
    });

    startBulkExport(planFor(['a']), GRANTED);
    appStateHandler?.('background');
    await drain();

    // The one in-flight item failed with the app in the background: re-queued,
    // not counted. Nothing runs until the app is back.
    expect(attempts).toEqual(['a']);
    expect(bulkExportStore.getState().phase).toBe('paused');

    appStateHandler?.('active');
    await drain();

    // Retried exactly once, then counted.
    expect(attempts).toEqual(['a', 'a']);
    expect(bulkExportStore.getState().summary).toMatchObject({ failed: 1, saved: 0 });
  });

  it('does not re-queue a SAVED item, or a second failure of the same item', async () => {
    mockExportItem.mockResolvedValueOnce({ outcome: 'saved', destination: 'photos' });
    mockExportItem.mockResolvedValue({ outcome: 'failed' });

    startBulkExport(planFor(['a', 'b']), GRANTED);
    appStateHandler?.('background');
    await drain();
    appStateHandler?.('active');
    await drain();

    // 'a' saved (never retried), 'b' failed once in background then retried.
    expect(mockExportItem.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'b']);
    expect(bulkExportStore.getState().summary).toMatchObject({ saved: 1, failed: 1 });
  });
});

describe('iOS document batching', () => {
  it('batches deferred documents into ONE picker at the end of the run', async () => {
    mockExportItem.mockResolvedValue({ outcome: 'deferred' });
    mockFlushDocuments.mockResolvedValue({ outcome: 'saved', count: 3 });

    startBulkExport(planFor(['a', 'b', 'c']), GRANTED);
    await drain();

    expect(mockFlushDocuments).toHaveBeenCalledTimes(1);
    expect(bulkExportStore.getState().summary).toEqual(
      summaryWith({ saved: 3, destinations: ['files'] }),
    );
  });

  it('counts a cancelled picker as skipped, not failed', async () => {
    mockExportItem.mockResolvedValue({ outcome: 'deferred' });
    mockFlushDocuments.mockResolvedValue({ outcome: 'cancelled', count: 2 });

    startBulkExport(planFor(['a', 'b']), GRANTED);
    await drain();

    expect(bulkExportStore.getState().summary).toMatchObject({ saved: 0, skipped: 2 });
  });

  it('counts staged items a wipe emptied as skipped', async () => {
    mockExportItem.mockResolvedValue({ outcome: 'deferred' });
    // The staging list was cleared between staging and the flush.
    mockFlushDocuments.mockResolvedValue({ outcome: 'skipped', count: 0 });

    startBulkExport(planFor(['a', 'b']), GRANTED);
    await drain();

    expect(bulkExportStore.getState().summary).toMatchObject({ saved: 0, skipped: 2 });
  });

  it('stays dismissible when the picker NEVER settles', async () => {
    mockExportItem.mockResolvedValue({ outcome: 'deferred' });
    mockFlushDocuments.mockImplementation(() => new Promise(() => {}));

    startBulkExport(planFor(['a', 'b']), GRANTED);
    await drain();

    // The picker is up and the run has not settled on its own.
    expect(bulkExportStore.getState().phase).toBe('running');

    cancelBulkExport();
    await drain();

    expect(bulkExportStore.getState().phase).toBe('done');
    expect(bulkExportStore.getState().summary).toMatchObject({
      skipped: 2,
      cancelled: true,
    });

    dismissBulkExportSummary();
    expect(bulkExportStore.getState().phase).toBe('idle');
  });

  it('says copies may already have landed when cancel hit the open picker', async () => {
    mockExportItem.mockResolvedValue({ outcome: 'deferred' });
    mockFlushDocuments.mockImplementation(() => new Promise(() => {}));

    startBulkExport(planFor(['a', 'b']), GRANTED);
    await drain();
    expect(bulkExportStore.getState().phase).toBe('running');

    cancelBulkExport();
    await drain();

    const summary = bulkExportStore.getState().summary;
    expect(summary?.cancelledMidFlush).toBe(true);
    expect(summary?.skipped).toBe(2);
    expect(describeBulkSummary(summary as BulkExportSummary)).toContain(
      'some copies may already have been saved',
    );
  });

  it('does NOT claim copies landed when cancel came before the picker', async () => {
    const releases: Array<() => void> = [];
    mockExportItem.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ outcome: 'deferred' }));
        }),
    );

    startBulkExport(planFor(['a', 'b']), GRANTED);
    await drain();
    cancelBulkExport();
    releases.forEach((r) => r());
    await drain();

    expect(bulkExportStore.getState().summary?.cancelledMidFlush).toBe(false);
    expect(mockFlushDocuments).not.toHaveBeenCalled();
  });

  it('sweeps leftover staging even when the run deferred nothing', async () => {
    mockStagedCount.mockReturnValue(1);
    startBulkExport(planFor(['a']), GRANTED);
    await drain();
    expect(mockFlushDocuments).not.toHaveBeenCalled();
    expect(mockDiscardDocuments).toHaveBeenCalled();
  });
});

describe('summary lifecycle (reattach)', () => {
  it('holds the summary until it is dismissed', async () => {
    startBulkExport(planFor(['a']), GRANTED);
    await drain();
    expect(bulkExportStore.getState().phase).toBe('done');

    // A screen can unmount and remount here; the store is module state, so the
    // summary is still there to re-render.
    expect(bulkExportStore.getState().summary).not.toBeNull();

    dismissBulkExportSummary();
    expect(bulkExportStore.getState()).toEqual({
      phase: 'idle',
      total: 0,
      completed: 0,
      summary: null,
    });
  });

  it('ignores a dismiss while a run is in flight', async () => {
    const releases: Array<() => void> = [];
    mockExportItem.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ outcome: 'saved', destination: 'photos' }));
        }),
    );

    startBulkExport(planFor(['a', 'b']), GRANTED);
    await drain();

    dismissBulkExportSummary();
    expect(bulkExportStore.getState()).toMatchObject({ phase: 'running', total: 2 });

    releases.forEach((r) => r());
    await drain();
  });

  it('a new run clears the previous summary', async () => {
    startBulkExport(planFor(['a']), GRANTED);
    await drain();
    expect(bulkExportStore.getState().summary).not.toBeNull();

    startBulkExport(planFor(['b', 'c']), GRANTED);
    expect(bulkExportStore.getState()).toMatchObject({
      phase: 'running',
      total: 2,
      completed: 0,
      summary: null,
    });
    await drain();
  });
});

describe('resetBulkExportForTesting', () => {
  it('aborts a live run and empties the store', async () => {
    mockExportItem.mockImplementation(() => new Promise(() => {}));
    startBulkExport(planFor(['a', 'b']), GRANTED);
    await drain();

    resetBulkExportForTesting();

    expect(bulkExportStore.getState().phase).toBe('idle');
    expect(mockRegistered[0].signal.aborted).toBe(true);
    expect(appStateRemove).toHaveBeenCalled();
    expect(bulkExportStore.getState()).toEqual({
      phase: 'idle',
      total: 0,
      completed: 0,
      summary: null,
    });
  });
});
