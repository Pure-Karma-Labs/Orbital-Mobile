/**
 * Tests for blockedUsersSync — reconciles local blocked list with server.
 */

import { syncBlockedUsers } from '../blockedUsersSync';

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

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      blockedUserIds: mockBlockedUserIds,
    })),
  },
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockBlockedUserIds = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('syncBlockedUsers', () => {
  it('pushes local-only blocks to the server', async () => {
    mockBlockedUserIds = ['user-1', 'user-2'];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: ['user-2'] });

    await syncBlockedUsers();

    expect(mockBlockUserApi).toHaveBeenCalledTimes(1);
    expect(mockBlockUserApi).toHaveBeenCalledWith('user-1');
    expect(mockUnblockUserApi).not.toHaveBeenCalled();
  });

  it('removes server-only blocks (local is authoritative)', async () => {
    mockBlockedUserIds = ['user-1'];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: ['user-1', 'user-3'] });

    await syncBlockedUsers();

    expect(mockUnblockUserApi).toHaveBeenCalledTimes(1);
    expect(mockUnblockUserApi).toHaveBeenCalledWith('user-3');
    expect(mockBlockUserApi).not.toHaveBeenCalled();
  });

  it('pushes and removes delta in both directions', async () => {
    mockBlockedUserIds = ['user-1', 'user-2'];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: ['user-2', 'user-3'] });

    await syncBlockedUsers();

    expect(mockBlockUserApi).toHaveBeenCalledWith('user-1');
    expect(mockUnblockUserApi).toHaveBeenCalledWith('user-3');
  });

  it('does nothing when local and server lists match', async () => {
    mockBlockedUserIds = ['user-1', 'user-2'];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: ['user-1', 'user-2'] });

    await syncBlockedUsers();

    expect(mockBlockUserApi).not.toHaveBeenCalled();
    expect(mockUnblockUserApi).not.toHaveBeenCalled();
  });

  it('handles empty local list with non-empty server list', async () => {
    mockBlockedUserIds = [];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: ['user-1', 'user-2'] });

    await syncBlockedUsers();

    expect(mockUnblockUserApi).toHaveBeenCalledTimes(2);
    expect(mockUnblockUserApi).toHaveBeenCalledWith('user-1');
    expect(mockUnblockUserApi).toHaveBeenCalledWith('user-2');
    expect(mockBlockUserApi).not.toHaveBeenCalled();
  });

  it('handles non-empty local list with empty server list', async () => {
    mockBlockedUserIds = ['user-1', 'user-2'];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: [] });

    await syncBlockedUsers();

    expect(mockBlockUserApi).toHaveBeenCalledTimes(2);
    expect(mockBlockUserApi).toHaveBeenCalledWith('user-1');
    expect(mockBlockUserApi).toHaveBeenCalledWith('user-2');
    expect(mockUnblockUserApi).not.toHaveBeenCalled();
  });

  it('handles both lists empty as no-op', async () => {
    mockBlockedUserIds = [];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: [] });

    await syncBlockedUsers();

    expect(mockBlockUserApi).not.toHaveBeenCalled();
    expect(mockUnblockUserApi).not.toHaveBeenCalled();
  });

  it('completes even when individual API calls fail (allSettled)', async () => {
    mockBlockedUserIds = ['user-1', 'user-2'];
    mockGetBlockedUsers.mockResolvedValue({ blockedUserIds: [] });
    mockBlockUserApi
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('network error'));

    // Should not throw
    await expect(syncBlockedUsers()).resolves.not.toThrow();

    expect(mockBlockUserApi).toHaveBeenCalledTimes(2);
  });

  it('propagates getBlockedUsers failure to caller', async () => {
    mockBlockedUserIds = ['user-1'];
    mockGetBlockedUsers.mockRejectedValue(new Error('server down'));

    await expect(syncBlockedUsers()).rejects.toThrow('server down');
    expect(mockBlockUserApi).not.toHaveBeenCalled();
    expect(mockUnblockUserApi).not.toHaveBeenCalled();
  });
});
