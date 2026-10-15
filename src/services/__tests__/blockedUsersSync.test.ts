/**
 * Tests for blockedUsersSync — ADDITIVE reconciliation of the local blocked
 * list with the server (#896).
 *
 * The sync pushes local-only blocks up and hydrates server-only blocks down.
 * It must never delete a server row: the suite-wide `afterEach` below is the
 * regression tripwire for that invariant.
 *
 * Server-list ids are real UUIDv4 fixtures because the module filters the
 * response through isValidUUIDv4.
 */

import { syncBlockedUsers } from '../blockedUsersSync';

// Real v4 fixtures (the module filters server ids through isValidUUIDv4).
const UID_A = '11111111-1111-4111-8111-111111111111';
const UID_B = '22222222-2222-4222-8222-222222222222';
const UID_C = '33333333-3333-4333-8333-333333333333';
const UID_X = '44444444-4444-4444-8444-444444444444';
const UID_Y = '55555555-5555-4555-9555-555555555555';
const JUNK_ID = 'not-a-uuid';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockBlockUserApi = jest.fn().mockResolvedValue(undefined);
const mockUnblockUserApi = jest.fn().mockResolvedValue(undefined);
const mockGetBlockedUsers = jest.fn().mockResolvedValue({ blockedUserIds: [] });

jest.mock('../../services/api/users', () => ({
  blockUserApi: (...args: unknown[]) => mockBlockUserApi(...args),
  unblockUserApi: (...args: unknown[]) => mockUnblockUserApi(...args),
  getBlockedUsers: (...args: unknown[]) => mockGetBlockedUsers(...args),
}));

let mockBlockedUserIds: string[] = [];
let mockUserId: string | null = 'user-self';
const mockHydrateBlockedUsers = jest.fn();

// NOTE: the mocked getState deliberately does NOT expose `unblockUser` —
// the sync has no business reaching the delete path through the store either.
jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      blockedUserIds: mockBlockedUserIds,
      userId: mockUserId,
      hydrateBlockedUsers: mockHydrateBlockedUsers,
    })),
  },
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockBlockedUserIds = [];
  mockUserId = 'user-self';
  mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: [] });
  // The two bail paths warn under __DEV__ (so a mis-wired guard is visible in
  // a smoke run); keep the suite output quiet but assertable.
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

// #896 regression tripwire: the sync is additive, so no code path — in ANY
// test below — may delete a server row. The removed `unblockUserApi` import is
// the structural guarantee; this assertion fails loudly if it ever comes back.
afterEach(() => {
  expect(mockUnblockUserApi).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('syncBlockedUsers', () => {
  it('hydrates server-only blocks instead of deleting them (#896 regression)', async () => {
    mockBlockedUserIds = [];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: [UID_A, UID_B] });

    await syncBlockedUsers();

    expect(mockHydrateBlockedUsers).toHaveBeenCalledTimes(1);
    expect(mockHydrateBlockedUsers).toHaveBeenCalledWith([UID_A, UID_B]);
    expect(mockBlockUserApi).not.toHaveBeenCalled();
  });

  it('pushes local-only blocks to the server', async () => {
    mockBlockedUserIds = [UID_A, UID_B];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: [UID_B] });

    await syncBlockedUsers();

    expect(mockBlockUserApi).toHaveBeenCalledTimes(1);
    expect(mockBlockUserApi).toHaveBeenCalledWith(UID_A);
    expect(mockHydrateBlockedUsers).not.toHaveBeenCalled();
  });

  it('reconciles both directions additively, hydrating before it pushes', async () => {
    mockBlockedUserIds = [UID_A, UID_B];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: [UID_B, UID_C] });

    await syncBlockedUsers();

    expect(mockBlockUserApi).toHaveBeenCalledTimes(1);
    expect(mockBlockUserApi).toHaveBeenCalledWith(UID_A);
    expect(mockHydrateBlockedUsers).toHaveBeenCalledWith([UID_C]);
    // Ordering is the WS-ingest contract: the store write must not wait on the
    // network pushes, because ingest guards read blockedUserIds at message time.
    expect(mockHydrateBlockedUsers.mock.invocationCallOrder[0]).toBeLessThan(
      mockBlockUserApi.mock.invocationCallOrder[0],
    );
  });

  it('does not call hydrateBlockedUsers when there are no server-only ids', async () => {
    mockBlockedUserIds = [UID_A, UID_B];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: [UID_A] });

    await syncBlockedUsers();

    expect(mockHydrateBlockedUsers).not.toHaveBeenCalled();
  });

  it('drops the response when the session changed mid-sync', async () => {
    mockBlockedUserIds = [];
    mockGetBlockedUsers.mockImplementation(async () => {
      // Logout + login for another account landed while the GET was in flight.
      mockUserId = 'user-other';
      return { blockedUserIds: [UID_A, UID_B] };
    });

    await syncBlockedUsers();

    expect(mockHydrateBlockedUsers).not.toHaveBeenCalled();
    expect(mockBlockUserApi).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[BlockedUsersSync] session changed mid-sync — dropped');
  });

  it('skips the sync entirely when there is no session', async () => {
    mockUserId = null;
    mockBlockedUserIds = [UID_A];

    await syncBlockedUsers();

    expect(mockGetBlockedUsers).not.toHaveBeenCalled();
    expect(mockHydrateBlockedUsers).not.toHaveBeenCalled();
    expect(mockBlockUserApi).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[BlockedUsersSync] no session — skipped');
  });

  it('does not re-push a block unblocked during the GET (DELETE landed first)', async () => {
    mockBlockedUserIds = [UID_X, UID_Y];
    mockGetBlockedUsers.mockImplementation(async () => {
      // User unblocked X from Settings; the DELETE landed before the GET ran.
      mockBlockedUserIds = [UID_Y];
      return { blockedUserIds: [UID_Y] };
    });

    await syncBlockedUsers();

    expect(mockBlockUserApi).not.toHaveBeenCalled();
    expect(mockHydrateBlockedUsers).not.toHaveBeenCalled();
  });

  it('does not hydrate back a block unblocked during the GET (DELETE not landed)', async () => {
    mockBlockedUserIds = [UID_X, UID_Y];
    mockGetBlockedUsers.mockImplementation(async () => {
      // Local removal already applied; the server still has X at GET time.
      mockBlockedUserIds = [UID_Y];
      return { blockedUserIds: [UID_X, UID_Y] };
    });

    await syncBlockedUsers();

    expect(mockHydrateBlockedUsers).not.toHaveBeenCalled();
    expect(mockBlockUserApi).not.toHaveBeenCalled();
  });

  it('ignores a malformed server id (neither hydrated nor pushed)', async () => {
    mockBlockedUserIds = [];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: [JUNK_ID, UID_A] });

    await syncBlockedUsers();

    expect(mockHydrateBlockedUsers).toHaveBeenCalledTimes(1);
    expect(mockHydrateBlockedUsers).toHaveBeenCalledWith([UID_A]);
    expect(mockBlockUserApi).not.toHaveBeenCalled();
    // Count only — ids are never logged.
    expect(warnSpy).toHaveBeenCalledWith('[BlockedUsersSync] dropped 1 malformed server id(s)');
  });

  it('does not push a malformed local id', async () => {
    mockBlockedUserIds = [JUNK_ID, UID_A];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: [] });

    await syncBlockedUsers();

    expect(mockBlockUserApi).toHaveBeenCalledTimes(1);
    expect(mockBlockUserApi).toHaveBeenCalledWith(UID_A);
    expect(mockHydrateBlockedUsers).not.toHaveBeenCalled();
  });

  it('does nothing when local and server lists match', async () => {
    mockBlockedUserIds = [UID_A, UID_B];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: [UID_A, UID_B] });

    await syncBlockedUsers();

    expect(mockBlockUserApi).not.toHaveBeenCalled();
    expect(mockHydrateBlockedUsers).not.toHaveBeenCalled();
  });

  it('handles non-empty local list with empty server list', async () => {
    mockBlockedUserIds = [UID_A, UID_B];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: [] });

    await syncBlockedUsers();

    expect(mockBlockUserApi).toHaveBeenCalledTimes(2);
    expect(mockBlockUserApi).toHaveBeenCalledWith(UID_A);
    expect(mockBlockUserApi).toHaveBeenCalledWith(UID_B);
    expect(mockHydrateBlockedUsers).not.toHaveBeenCalled();
  });

  it('handles both lists empty as no-op', async () => {
    mockBlockedUserIds = [];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: [] });

    await syncBlockedUsers();

    expect(mockBlockUserApi).not.toHaveBeenCalled();
    expect(mockHydrateBlockedUsers).not.toHaveBeenCalled();
  });

  it('completes even when individual API calls fail (allSettled)', async () => {
    mockBlockedUserIds = [UID_A, UID_B];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: [] });
    mockBlockUserApi
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('network error'));

    // Should not throw
    await expect(syncBlockedUsers()).resolves.not.toThrow();

    expect(mockBlockUserApi).toHaveBeenCalledTimes(2);
  });

  it('propagates getBlockedUsers failure to caller', async () => {
    mockBlockedUserIds = [UID_A];
    mockGetBlockedUsers.mockRejectedValue(new Error('server down'));

    await expect(syncBlockedUsers()).rejects.toThrow('server down');
    expect(mockBlockUserApi).not.toHaveBeenCalled();
    expect(mockHydrateBlockedUsers).not.toHaveBeenCalled();
  });
});
