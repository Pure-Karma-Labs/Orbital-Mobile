/**
 * Threads API service.
 */

import { request, buildQueryString } from './client';
import type {
  CreateReplyRequest,
  CreateReplyResponse,
  CreateThreadRequest,
  CreateThreadResponse,
  GetGroupThreadsRequest,
  ListRepliesResponse,
  ListThreadsResponse,
  ThreadResponse,
} from '../../types/api';

export function createThread(data: CreateThreadRequest): Promise<CreateThreadResponse> {
  return request<CreateThreadResponse>({
    method: 'POST',
    path: '/api/threads',
    body: data,
  });
}

export function getGroupThreads(
  groupId: string,
  params?: GetGroupThreadsRequest,
): Promise<ListThreadsResponse> {
  const qs = buildQueryString({
    limit: params?.limit,
    offset: params?.offset,
    sort: params?.sort,
  });
  const path = `/api/threads/groups/${encodeURIComponent(groupId)}/threads${qs}`;

  return request<ListThreadsResponse>({
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
  offset?: number,
): Promise<ListRepliesResponse> {
  const qs = buildQueryString({ offset });
  return request<ListRepliesResponse>({
    method: 'GET',
    path: `/api/threads/${encodeURIComponent(threadId)}/replies${qs}`,
  });
}

export function createReply(
  threadId: string,
  data: CreateReplyRequest,
): Promise<CreateReplyResponse> {
  return request<CreateReplyResponse>({
    method: 'POST',
    path: `/api/threads/${encodeURIComponent(threadId)}/replies`,
    body: data,
  });
}
