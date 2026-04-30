/**
 * Tests for the threads API service.
 */

jest.mock('../client', () => ({
  ...jest.requireActual('../client'),
  request: jest.fn(),
}));

import { request } from '../client';
import {
  createThread,
  createReply,
  getGroupThreads,
  getThread,
  getThreadReplies,
} from '../threads';

const mockRequest = request as jest.MockedFunction<typeof request>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue({});
});

describe('createThread', () => {
  it('sends encrypted fields to POST /api/threads', async () => {
    const data = {
      groupId: 'group-1',
      encryptedTitle: 'aabbccdd',
      titleIv: '00112233',
      encryptedBody: 'eeff0011',
      bodyIv: '44556677',
    };

    await createThread(data);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/threads',
      body: data,
    });
  });
});

describe('getGroupThreads', () => {
  it('calls GET /api/groups/:id/threads', async () => {
    await getGroupThreads('group-abc');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/threads/groups/group-abc/threads',
    });
  });

  it('passes offset as query param', async () => {
    await getGroupThreads('group-abc', { offset: 20 });

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/threads/groups/group-abc/threads?offset=20',
    });
  });

  it('passes multiple query params when provided', async () => {
    await getGroupThreads('group-abc', { offset: 10, limit: 20, sort: 'created_desc' });

    const callArg = mockRequest.mock.calls[0][0];
    expect(callArg.path).toContain('offset=10');
    expect(callArg.path).toContain('limit=20');
    expect(callArg.path).toContain('sort=created_desc');
  });
});

describe('getThread', () => {
  it('calls GET /api/threads/:id', async () => {
    await getThread('thread-1');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/threads/thread-1',
    });
  });
});

describe('getThreadReplies', () => {
  it('calls GET /api/threads/:id/replies', async () => {
    await getThreadReplies('thread-1');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/threads/thread-1/replies',
    });
  });

  it('passes offset when provided', async () => {
    await getThreadReplies('thread-1', 20);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/threads/thread-1/replies?offset=20',
    });
  });
});

describe('createReply', () => {
  it('sends encrypted body and parentReplyId to POST /api/threads/:id/replies', async () => {
    const data = {
      encryptedBody: 'cipher-body',
      bodyIv: 'iv-123',
      parentReplyId: 'reply-parent-uuid',
    };

    await createReply('thread-1', data);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/threads/thread-1/replies',
      body: data,
    });
  });

  it('sends null parentReplyId for top-level replies', async () => {
    const data = {
      encryptedBody: 'cipher-body',
      bodyIv: 'iv-123',
      parentReplyId: null,
    };

    await createReply('thread-1', data);

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ parentReplyId: null }),
      }),
    );
  });
});
