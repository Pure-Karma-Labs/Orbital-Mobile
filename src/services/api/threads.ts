/**
 * Threads API service.
 */

import { request } from './client';
import type {
  CreateReplyRequest,
  CreateThreadRequest,
  GetGroupThreadsRequest,
  PaginatedResponse,
  ReplyResponse,
  ThreadResponse,
} from '../../types/api';

export function createThread(data: CreateThreadRequest): Promise<ThreadResponse> {
  return request<ThreadResponse>({
    method: 'POST',
    path: '/api/threads',
    body: data,
  });
}

export function getGroupThreads(
  groupId: string,
  params?: GetGroupThreadsRequest,
): Promise<PaginatedResponse<ThreadResponse>> {
  const parts: string[] = [];
  if (params?.cursor !== undefined) {
    parts.push(`cursor=${encodeURIComponent(params.cursor)}`);
  }
  if (params?.limit !== undefined) {
    parts.push(`limit=${encodeURIComponent(String(params.limit))}`);
  }
  if (params?.sort !== undefined) {
    parts.push(`sort=${encodeURIComponent(params.sort)}`);
  }
  const qs = parts.length > 0 ? `?${parts.join('&')}` : '';
  const path = `/api/groups/${encodeURIComponent(groupId)}/threads${qs}`;

  return request<PaginatedResponse<ThreadResponse>>({
    method: 'GET',
    path,
  });
}

export function getThread(threadId: string): Promise<ThreadResponse> {
  return request<ThreadResponse>({
    method: 'GET',
    path: `/api/threads/${encodeURIComponent(threadId)}`,
  });
}

export function getThreadReplies(
  threadId: string,
  cursor?: string,
): Promise<PaginatedResponse<ReplyResponse>> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return request<PaginatedResponse<ReplyResponse>>({
    method: 'GET',
    path: `/api/threads/${encodeURIComponent(threadId)}/replies${query}`,
  });
}

export function createReply(
  threadId: string,
  data: CreateReplyRequest,
): Promise<ReplyResponse> {
  return request<ReplyResponse>({
    method: 'POST',
    path: `/api/threads/${encodeURIComponent(threadId)}/replies`,
    body: data,
  });
}
