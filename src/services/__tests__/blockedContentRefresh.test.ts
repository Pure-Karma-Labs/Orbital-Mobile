/**
 * Tests for blockedContentRefresh — the block/unblock → refetch sequencing
 * added in #897.
 *
 * The module loads `conversationService` / `threadService` with dynamic
 * `import()`; under Jest those resolve to the mocks below, same as a static
 * import would.
 */

const mockLoadConversations = jest.fn<Promise<void>, []>();
const mockLoadDmConversations = jest.fn<Promise<void>, []>();
const mockCaptureSession = jest.fn<{ userId: string; generation: number } | null, []>();
const mockIsSessionStale = jest.fn<boolean, [{ userId: string; generation: number }]>();
const mockLoadThreadsForGroup = jest.fn<
  Promise<unknown>,
  [string, { tail?: 'keep' | 'drop' }?]
>();
const mockLoadThread = jest.fn<Promise<unknown>, [string]>();
const mockLoadMoreThreadsForGroup = jest.fn<Promise<unknown>, [string]>();

/**
 * Named so a test that temporarily replaces this module with a THROWING
 * factory can put the working one back — `jest.dontMock` would hand back the
 * real `conversationService` instead, whose `captureSession` then reads the
 * mocked store and silently returns null.
 */
const conversationServiceMock = () => ({
  loadConversations: () => mockLoadConversations(),
  loadDmConversations: () => mockLoadDmConversations(),
  captureSession: () => mockCaptureSession(),
  isSessionStale: (captured: { userId: string; generation: number }) =>
    mockIsSessionStale(captured),
});

jest.mock('../conversationService', () => conversationServiceMock());

jest.mock('../threadService', () => ({
  // The options object is forwarded, not dropped: #923 made it the difference
  // between a block (merge, keep the walked tail) and an unblock (reopen).
  loadThreadsForGroup: (groupId: string, options?: { tail?: 'keep' | 'drop' }) =>
    mockLoadThreadsForGroup(groupId, options),
  loadThread: (threadId: string) => mockLoadThread(threadId),
  // #923: a refresh re-pulls the HEAD page and nothing else. Walking further
  // pages is the member's scroll, never a background refetch — so this is
  // mocked only to be asserted NEVER called.
  loadMoreThreadsForGroup: (groupId: string) => mockLoadMoreThreadsForGroup(groupId),
}));

const mockBlockUser = jest.fn<Promise<void>, [string, string]>();
const mockUnblockUser = jest.fn<Promise<void>, [string]>();
const mockRemoveMediaForAuthor = jest.fn<void, [string]>();
const mockGetState = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: { getState: () => mockGetState() },
}));

/**
 * Required per test (after `jest.resetModules`) because the module keeps
 * single-flight state at module scope: a test that fails mid-run would
 * otherwise leave an unresolved in-flight promise behind and hang every test
 * after it.
 */
function loadModule(): typeof import('../blockedContentRefresh') {
  return require('../blockedContentRefresh') as typeof import('../blockedContentRefresh');
}

const SESSION = { userId: 'me', generation: 1 };
const ACTIVE = 'conv-active';
const VIEWING = 'conv-viewing';
const THREAD = 'thread-1';
const THREAD_CONV = 'conv-of-thread';

interface StateOverrides {
  activeConversationId?: string | null;
  viewingConversationId?: string | null;
  activeThreadId?: string | null;
  threads?: Record<string, { conversationId: string }>;
}

function setState(overrides: StateOverrides = {}): void {
  mockGetState.mockReturnValue({
    activeConversationId: ACTIVE,
    viewingConversationId: null,
    activeThreadId: null,
    threads: {},
    blockUser: mockBlockUser,
    unblockUser: mockUnblockUser,
    removeMediaForAuthor: mockRemoveMediaForAuthor,
    ...overrides,
  });
}

/** A promise plus its resolver, so a test can settle the API on demand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let the module's dynamic `import()`s and the loaders' microtasks settle. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  mockLoadConversations.mockResolvedValue(undefined);
  mockLoadDmConversations.mockResolvedValue(undefined);
  mockLoadThreadsForGroup.mockResolvedValue(undefined);
  mockLoadThread.mockResolvedValue(undefined);
  mockCaptureSession.mockReturnValue(SESSION);
  mockIsSessionStale.mockReturnValue(false);
  mockBlockUser.mockResolvedValue(undefined);
  mockUnblockUser.mockResolvedValue(undefined);
  setState();
});

describe('blockUserAndRefresh', () => {
  it('blocks and evicts synchronously, then refetches once the API settles', async () => {
    const api = deferred<void>();
    mockBlockUser.mockReturnValue(api.promise);

    const pending = loadModule().blockUserAndRefresh('bad-user', 'baduser');

    // Synchronous on the tap: the gallery and every blockedSet-filtered list
    // must update before the round-trip, not after it.
    expect(mockBlockUser).toHaveBeenCalledWith('bad-user', 'baduser');
    expect(mockRemoveMediaForAuthor).toHaveBeenCalledWith('bad-user');
    expect(mockLoadConversations).not.toHaveBeenCalled();

    api.resolve(undefined);
    await pending;

    expect(mockLoadConversations).toHaveBeenCalledTimes(1);
    expect(mockLoadDmConversations).toHaveBeenCalledTimes(1);
    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(1);
    // A block MERGES (#923): the server just stops counting that author, so
    // every row already paged in stays valid and the member keeps their place.
    expect(mockLoadThreadsForGroup).toHaveBeenCalledWith(ACTIVE, { tail: 'keep' });
    expect(mockLoadThread).not.toHaveBeenCalled();
    // A background refresh never spends the member's page budget.
    expect(mockLoadMoreThreadsForGroup).not.toHaveBeenCalled();
  });

  it('refetches the viewed conversation as well when it differs from the active one', async () => {
    setState({ viewingConversationId: VIEWING });

    await loadModule().blockUserAndRefresh('bad-user', 'baduser');

    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(2);
    expect(mockLoadThreadsForGroup).toHaveBeenCalledWith(ACTIVE, { tail: 'keep' });
    expect(mockLoadThreadsForGroup).toHaveBeenCalledWith(VIEWING, { tail: 'keep' });
  });

  it("adds the open thread's conversation and the thread itself", async () => {
    setState({
      viewingConversationId: VIEWING,
      activeThreadId: THREAD,
      threads: { [THREAD]: { conversationId: THREAD_CONV } },
    });

    await loadModule().blockUserAndRefresh('bad-user', 'baduser');

    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(3);
    expect(mockLoadThreadsForGroup).toHaveBeenCalledWith(THREAD_CONV, { tail: 'keep' });
    expect(mockLoadThread).toHaveBeenCalledWith(THREAD);
  });

  it('de-duplicates the refresh set', async () => {
    setState({
      viewingConversationId: ACTIVE,
      activeThreadId: THREAD,
      threads: { [THREAD]: { conversationId: ACTIVE } },
    });

    await loadModule().blockUserAndRefresh('bad-user', 'baduser');

    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(1);
    expect(mockLoadThreadsForGroup).toHaveBeenCalledWith(ACTIVE, { tail: 'keep' });
  });

  it('skips the refetch when the session went stale while the block settled', async () => {
    mockIsSessionStale.mockReturnValue(true);

    await loadModule().blockUserAndRefresh('bad-user', 'baduser');

    expect(mockBlockUser).toHaveBeenCalled();
    expect(mockRemoveMediaForAuthor).toHaveBeenCalledWith('bad-user');
    expect(mockLoadConversations).not.toHaveBeenCalled();
    expect(mockLoadThreadsForGroup).not.toHaveBeenCalled();
  });

  it('still blocks when there is no session, and skips the refetch', async () => {
    mockCaptureSession.mockReturnValue(null);

    await loadModule().blockUserAndRefresh('bad-user', 'baduser');

    expect(mockBlockUser).toHaveBeenCalled();
    expect(mockLoadConversations).not.toHaveBeenCalled();
  });

  it('does not reject when a loader fails, and runs the other loaders', async () => {
    mockLoadThreadsForGroup.mockRejectedValue(new Error('offline'));

    await expect(
      loadModule().blockUserAndRefresh('bad-user', 'baduser'),
    ).resolves.toBeUndefined();

    expect(mockLoadConversations).toHaveBeenCalledTimes(1);
    expect(mockLoadDmConversations).toHaveBeenCalledTimes(1);
  });
});

describe('unblockUserAndRefresh', () => {
  it('unblocks and refetches but never evicts media', async () => {
    await loadModule().unblockUserAndRefresh('bad-user');

    expect(mockUnblockUser).toHaveBeenCalledWith('bad-user');
    expect(mockRemoveMediaForAuthor).not.toHaveBeenCalled();
    expect(mockLoadConversations).toHaveBeenCalledTimes(1);
    expect(mockLoadDmConversations).toHaveBeenCalledTimes(1);
    // An unblock REOPENS (#923): the author's threads can come back ANYWHERE
    // in the list, including inside the range this device already walked, and
    // a merge can only append. Dropping the tail returns the list to its head,
    // from where scrolling reaches them again.
    expect(mockLoadThreadsForGroup).toHaveBeenCalledWith(ACTIVE, { tail: 'drop' });
    expect(mockLoadMoreThreadsForGroup).not.toHaveBeenCalled();
  });
});

describe('refreshBlockedContent single-flight', () => {
  it('coalesces a concurrent call into exactly one re-run', async () => {
    const first = deferred<void>();
    mockLoadConversations.mockReturnValueOnce(first.promise);
    const { refreshBlockedContent } = loadModule();

    const a = refreshBlockedContent();
    const b = refreshBlockedContent();
    await flush();

    // Both callers share the one in-flight run.
    expect(mockLoadConversations).toHaveBeenCalledTimes(1);

    first.resolve(undefined);
    await Promise.all([a, b]);

    // One run for the first call, exactly one re-run for the second.
    expect(mockLoadConversations).toHaveBeenCalledTimes(2);
    expect(mockLoadDmConversations).toHaveBeenCalledTimes(2);
    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(2);
  });

  it("re-runs with 'drop' when an unblock folds into a block's run (#923)", async () => {
    // 'drop' wins over 'keep' when runs coalesce: the unblock swallowed by the
    // block's re-run must STILL reopen the list, or the unblocked author's
    // threads stay stranded behind a tail this device walked while they were
    // hidden.
    const blockApi = deferred<void>();
    mockBlockUser.mockReturnValue(blockApi.promise);
    const firstRun = deferred<void>();
    mockLoadConversations.mockReturnValueOnce(firstRun.promise);
    const { blockUserAndRefresh, unblockUserAndRefresh } = loadModule();

    const blocked = blockUserAndRefresh('bad-user', 'baduser');
    blockApi.resolve(undefined);
    await flush();

    // The block's own run is in flight, and it kept the walked tail.
    expect(mockLoadThreadsForGroup).toHaveBeenNthCalledWith(1, ACTIVE, { tail: 'keep' });

    // The unblock arrives mid-run and is coalesced into the one re-run.
    const unblocked = unblockUserAndRefresh('bad-user');
    await flush();
    firstRun.resolve(undefined);
    await Promise.all([blocked, unblocked]);

    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(2);
    expect(mockLoadThreadsForGroup).toHaveBeenNthCalledWith(2, ACTIVE, { tail: 'drop' });
    expect(mockLoadMoreThreadsForGroup).not.toHaveBeenCalled();
  });

  it('resolves instead of rejecting when a lazy import fails (#906)', async () => {
    // The loaders are absorbed by `allSettled`, but the two dynamic imports
    // can reject on their own (module-eval error, bundler miss) and every
    // caller is fire-and-forget from an Alert handler.
    jest.resetModules();
    jest.doMock('../conversationService', () => {
      throw new Error('module eval failed');
    });
    try {
      const { refreshBlockedContent } = loadModule();

      await expect(refreshBlockedContent()).resolves.toBeUndefined();
      expect(mockLoadConversations).not.toHaveBeenCalled();
    } finally {
      jest.doMock('../conversationService', () => conversationServiceMock());
      jest.resetModules();
    }
  });

  it('blockUserAndRefresh also resolves when a lazy import fails (#906)', async () => {
    jest.resetModules();
    jest.doMock('../conversationService', () => {
      throw new Error('module eval failed');
    });
    try {
      const { blockUserAndRefresh } = loadModule();

      await expect(
        blockUserAndRefresh('bad-user', 'baduser'),
      ).resolves.toBeUndefined();
      // The local half still happened.
      expect(mockBlockUser).toHaveBeenCalledWith('bad-user', 'baduser');
      expect(mockRemoveMediaForAuthor).toHaveBeenCalledWith('bad-user');
    } finally {
      jest.doMock('../conversationService', () => conversationServiceMock());
      jest.resetModules();
    }
  });

  it('runs a full fetch set again on a later, non-overlapping call', async () => {
    const { refreshBlockedContent } = loadModule();

    await refreshBlockedContent();
    await refreshBlockedContent();

    expect(mockLoadConversations).toHaveBeenCalledTimes(2);
  });
});
