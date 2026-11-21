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

  it('serializes the activity_desc sort (#883)', async () => {
    await getGroupThreads('group-abc', { sort: 'activity_desc' });

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/api/threads/groups/group-abc/threads?sort=activity_desc',
    });
  });
});

describe('getGroupThreads cursor (#923)', () => {
  it('sends no before on a head request', async () => {
    await getGroupThreads('group-abc', { sort: 'activity_desc' });

    const callArg = mockRequest.mock.calls[0][0];
    expect(callArg.path).not.toContain('before=');
  });

  it('passes before, url-encoded, alongside the walk sort and limit', async () => {
    // A real cursor is base64url, but `+`/`=` must survive a hostile or
    // future encoding unchanged — the server re-encodes and compares.
    await getGroupThreads('group-abc', {
      sort: 'created_desc',
      limit: 100,
      before: 'a+b=c/d',
    });

    const callArg = mockRequest.mock.calls[0][0];
    expect(callArg.path).toContain('sort=created_desc');
    expect(callArg.path).toContain('limit=100');
    expect(callArg.path).toContain(`before=${encodeURIComponent('a+b=c/d')}`);
    expect(callArg.path).not.toContain('offset=');
  });

  it('opts a walk page out of the 429 retry', async () => {
    await getGroupThreads(
      'group-abc',
      { sort: 'created_desc', limit: 100, before: 'cursor-1' },
      { retryOn429: false },
    );

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({ retryOn429: false }),
    );
  });

  it('leaves the retry default alone for a head request', async () => {
    await getGroupThreads('group-abc', { sort: 'activity_desc' });

    expect(mockRequest.mock.calls[0][0]).not.toHaveProperty('retryOn429');
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
