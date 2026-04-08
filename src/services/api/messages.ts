/**
 * Signal Protocol relay API service.
 *
 * These endpoints send and receive end-to-end encrypted Signal envelopes.
 * The content of encryptedEnvelope is never inspected here — it is an opaque
 * binary payload that the Signal Protocol layer handles.
 */

import { request } from './client';
import type {
  FetchMessagesRequest,
  FetchMessagesResponse,
  SendMessageRequest,
  SendMessageResponse,
} from '../../types/api';

export function sendMessage(data: SendMessageRequest): Promise<SendMessageResponse> {
  return request<SendMessageResponse>({
    method: 'POST',
    path: '/v1/messages',
    body: data,
  });
}

export function fetchMessages(
  params?: FetchMessagesRequest,
): Promise<FetchMessagesResponse> {
  const parts: string[] = [];
  if (params?.since !== undefined) {
    parts.push(`since=${encodeURIComponent(String(params.since))}`);
  }
  if (params?.limit !== undefined) {
    parts.push(`limit=${encodeURIComponent(String(params.limit))}`);
  }
  const qs = parts.length > 0 ? `?${parts.join('&')}` : '';

  return request<FetchMessagesResponse>({
    method: 'GET',
    path: `/v1/messages${qs}`,
  });
}

export function deleteMessage(messageId: string): Promise<void> {
  return request<void>({
    method: 'DELETE',
    path: `/v1/messages/${encodeURIComponent(messageId)}`,
  });
}
