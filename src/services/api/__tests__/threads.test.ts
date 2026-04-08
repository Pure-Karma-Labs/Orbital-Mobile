/**
 * Tests for the threads API service.
 */

jest.mock('../client', () => ({
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
      contentType: 'text' as const,
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

  it('includes client-generated id when provided', async () => {
    const data = {
      id: 'client-uuid-123',
      groupId: 'group-1',
      contentType: 'text' as const,
      encryptedTitle: null,
      titleIv: null,
      encryptedBody: 'cipher',
      bodyIv: 'iv',
    };

    await createThread(data);

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ id: 'client-uuid-123' }) }),
    );
  });
});

describe('getGroupThreads', () => {
  it('calls GET /api/groups/:id/threads', async () => {
    await getGroupThreads('group-abc');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/groups/group-abc/threads',
    });
  });

  it('passes pagination cursor as query param', async () => {
    await getGroupThreads('group-abc', { cursor: 'cursor-xyz' });

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/groups/group-abc/threads?cursor=cursor-xyz',
    });
  });

  it('passes multiple query params when provided', async () => {
    await getGroupThreads('group-abc', { cursor: 'c1', limit: 20, sort: 'top' });

    const callArg = mockRequest.mock.calls[0][0];
    expect(callArg.path).toContain('cursor=c1');
    expect(callArg.path).toContain('limit=20');
    expect(callArg.path).toContain('sort=top');
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

  it('passes cursor when provided', async () => {
    await getThreadReplies('thread-1', 'cursor-r1');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/threads/thread-1/replies?cursor=cursor-r1',
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
