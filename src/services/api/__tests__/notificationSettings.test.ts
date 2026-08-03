/**
 * Tests for the notification settings API service (#449).
 *
 * Verifies method/path/body for all five endpoints. The client's
 * camelToSnake/snakeToCamel transform is exercised in client.test.ts — these
 * modules pass camelCase through untouched.
 */

jest.mock('../client', () => ({
  request: jest.fn(),
}));

import { request } from '../client';
import {
  getNotificationPrefs,
  updateNotificationPrefs,
  getNotificationMutes,
  muteTargetApi,
  unmuteTargetApi,
} from '../notificationSettings';

const mockRequest = request as jest.MockedFunction<typeof request>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue(undefined);
});

describe('getNotificationPrefs', () => {
  it('calls GET /api/users/me/notification-prefs and returns the full pref set', async () => {
    mockRequest.mockResolvedValue({
      newThread: true,
      newReply: false,
      newDm: true,
      memberJoined: false,
    });

    const result = await getNotificationPrefs();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/users/me/notification-prefs',
    });
    expect(result).toEqual({
      newThread: true,
      newReply: false,
      newDm: true,
      memberJoined: false,
    });
  });
});

describe('updateNotificationPrefs', () => {
  it('calls PUT with only the keys supplied (partial patch)', async () => {
    mockRequest.mockResolvedValue({
      newThread: true,
      newReply: false,
      newDm: true,
      memberJoined: true,
    });

    const result = await updateNotificationPrefs({ newReply: false });

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'PUT',
      path: '/api/users/me/notification-prefs',
      body: { newReply: false },
    });
    expect(result.newReply).toBe(false);
  });

  it('passes multiple keys through unchanged', async () => {
    await updateNotificationPrefs({ newDm: false, memberJoined: false });

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'PUT',
      path: '/api/users/me/notification-prefs',
      body: { newDm: false, memberJoined: false },
    });
  });
});

describe('getNotificationMutes', () => {
  it('calls GET /api/users/me/notification-mutes and returns the mute rows', async () => {
    mockRequest.mockResolvedValue({
      mutes: [
        { targetId: 'thread-1', targetType: 'thread', createdAt: '2026-08-03T00:00:00Z' },
      ],
    });

    const result = await getNotificationMutes();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/users/me/notification-mutes',
    });
    expect(result.mutes).toHaveLength(1);
    expect(result.mutes[0].targetType).toBe('thread');
  });
});

describe('muteTargetApi', () => {
  it('calls PUT /api/users/me/notification-mutes/:targetId with the target type', async () => {
    await muteTargetApi('thread-1', 'thread');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'PUT',
      path: '/api/users/me/notification-mutes/thread-1',
      body: { targetType: 'thread' },
    });
  });

  it('supports group targets', async () => {
    await muteTargetApi('group-9', 'group');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'PUT',
      path: '/api/users/me/notification-mutes/group-9',
      body: { targetType: 'group' },
    });
  });

  it('encodes special characters in the target ID', async () => {
    await muteTargetApi('a/b c', 'thread');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'PUT',
      path: '/api/users/me/notification-mutes/a%2Fb%20c',
      body: { targetType: 'thread' },
    });
  });
});

describe('unmuteTargetApi', () => {
  it('calls DELETE /api/users/me/notification-mutes/:targetId and resolves undefined on 204', async () => {
    const result = await unmuteTargetApi('thread-1');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/api/users/me/notification-mutes/thread-1',
    });
    expect(result).toBeUndefined();
  });

  it('encodes special characters in the target ID', async () => {
    await unmuteTargetApi('a/b c');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/api/users/me/notification-mutes/a%2Fb%20c',
    });
  });
});
