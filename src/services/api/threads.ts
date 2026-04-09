/**
 * Threads API service.
 */

import { request, buildQueryString } from './client';
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
  const qs = buildQueryString({
    cursor: params?.cursor,
    limit: params?.limit,
    sort: params?.sort,
  });
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
  const qs = buildQueryString({ cursor });
  return request<PaginatedResponse<ReplyResponse>>({
    method: 'GET',
    path: `/api/threads/${encodeURIComponent(threadId)}/replies${qs}`,
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
