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
const mockLoadThreadsForGroup = jest.fn<Promise<unknown>, [string]>();
const mockLoadThread = jest.fn<Promise<unknown>, [string]>();

jest.mock('../conversationService', () => ({
  loadConversations: () => mockLoadConversations(),
  loadDmConversations: () => mockLoadDmConversations(),
  captureSession: () => mockCaptureSession(),
  isSessionStale: (captured: { userId: string; generation: number }) =>
    mockIsSessionStale(captured),
}));

jest.mock('../threadService', () => ({
  loadThreadsForGroup: (groupId: string) => mockLoadThreadsForGroup(groupId),
  loadThread: (threadId: string) => mockLoadThread(threadId),
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
    expect(mockLoadThreadsForGroup).toHaveBeenCalledWith(ACTIVE);
    expect(mockLoadThread).not.toHaveBeenCalled();
  });

  it('refetches the viewed conversation as well when it differs from the active one', async () => {
    setState({ viewingConversationId: VIEWING });

    await loadModule().blockUserAndRefresh('bad-user', 'baduser');

    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(2);
    expect(mockLoadThreadsForGroup).toHaveBeenCalledWith(ACTIVE);
    expect(mockLoadThreadsForGroup).toHaveBeenCalledWith(VIEWING);
  });

  it("adds the open thread's conversation and the thread itself", async () => {
    setState({
      viewingConversationId: VIEWING,
      activeThreadId: THREAD,
      threads: { [THREAD]: { conversationId: THREAD_CONV } },
    });

    await loadModule().blockUserAndRefresh('bad-user', 'baduser');

    expect(mockLoadThreadsForGroup).toHaveBeenCalledTimes(3);
    expect(mockLoadThreadsForGroup).toHaveBeenCalledWith(THREAD_CONV);
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
    expect(mockLoadThreadsForGroup).toHaveBeenCalledWith(ACTIVE);
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
    expect(mockLoadThreadsForGroup).toHaveBeenCalledWith(ACTIVE);
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

  it('runs a full fetch set again on a later, non-overlapping call', async () => {
    const { refreshBlockedContent } = loadModule();

    await refreshBlockedContent();
    await refreshBlockedContent();

    expect(mockLoadConversations).toHaveBeenCalledTimes(2);
  });
});
