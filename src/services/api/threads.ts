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

/**
 * One page of a group's (or DM's) thread list.
 *
 * `params` is a union (#923): a request carries `offset` OR `before`, never
 * both — the route answers 400 `INVALID_CURSOR` for the pair.
 *
 * `retryOn429: false` is for the cursor WALK. The whole list route sits behind
 * `generalLimiter` (500 req / IP / 15 min, shared with media and with every
 * member behind the same home network), and a walk is the one caller that can
 * issue ~50 requests in a scroll. Letting the client retry a walk page three
 * more times turns one rate-limited page into four and spends the member's
 * remaining budget on a page they can simply re-request by tapping; the footer
 * surfaces the 429 instead. Head refreshes keep the default retry.
 */
export function getGroupThreads(
  groupId: string,
  params?: GetGroupThreadsRequest,
  options?: { retryOn429?: boolean },
): Promise<ListThreadsResponse> {
  const qs = buildQueryString({
    limit: params?.limit,
    offset: params?.offset,
    sort: params?.sort,
    before: params?.before,
  });
  const path = `/api/threads/groups/${encodeURIComponent(groupId)}/threads${qs}`;

  return request<ListThreadsResponse>({
    method: 'GET',
    path,
    ...(options?.retryOn429 === false ? { retryOn429: false } : {}),
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
