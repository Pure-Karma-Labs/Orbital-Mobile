/**
 * Tests for the messages (Signal relay) API service.
 */

jest.mock('../client', () => ({
  ...jest.requireActual('../client'),
  request: jest.fn(),
}));

import { request } from '../client';
import { sendMessage, fetchMessages, deleteMessage } from '../messages';

const mockRequest = request as jest.MockedFunction<typeof request>;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue({});
});

describe('sendMessage', () => {
  it('calls POST /v1/messages with correct body', async () => {
    const data = {
      conversationId: 'conv-uuid-1',
      encryptedEnvelope: 'base64payload==',
      timestamp: 1700000000000,
    };
    await sendMessage(data);

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/messages',
      body: data,
    });
  });
});

describe('fetchMessages', () => {
  it('calls GET /v1/messages with no query params when called with no args', async () => {
    await fetchMessages();

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/messages',
    });
  });

  it('appends since query param when provided', async () => {
    await fetchMessages({ since: 1700000000000 });

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/messages?since=1700000000000',
    });
  });

  it('appends limit query param when provided', async () => {
    await fetchMessages({ limit: 50 });

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/messages?limit=50',
    });
  });

  it('appends both since and limit when both are provided', async () => {
    await fetchMessages({ since: 1700000000000, limit: 25 });

    const callArg = mockRequest.mock.calls[0][0];
    expect(callArg.path).toContain('since=1700000000000');
    expect(callArg.path).toContain('limit=25');
  });
});

describe('deleteMessage', () => {
  it('calls DELETE /v1/messages/:messageId', async () => {
    await deleteMessage('msg-abc');

    expect(mockRequest).toHaveBeenCalledWith({
      method: 'DELETE',
      path: '/v1/messages/msg-abc',
    });
  });

  it('encodes special characters in messageId', async () => {
    await deleteMessage('msg/special');

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/messages/msg%2Fspecial',
      }),
    );
  });
});
