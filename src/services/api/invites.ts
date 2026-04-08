/**
 * Invites API service.
 */

import { request } from './client';
import type {
  GenerateInviteLinkRequest,
  GenerateInviteRequest,
  InviteLinkResponse,
  InviteResponse,
  InviteStatusResponse,
} from '../../types/api';

export function generateInvite(data: GenerateInviteRequest): Promise<InviteResponse> {
  return request<InviteResponse>({
    method: 'POST',
    path: '/api/invites/generate',
    body: data,
  });
}

export function generateInviteLink(
  data: GenerateInviteLinkRequest,
): Promise<InviteLinkResponse> {
  return request<InviteLinkResponse>({
    method: 'POST',
    path: '/api/invites/generate-link',
    body: data,
  });
}

export function getInviteStatus(code: string): Promise<InviteStatusResponse> {
  return request<InviteStatusResponse>({
    method: 'GET',
    path: `/api/invites/status/${encodeURIComponent(code)}`,
  });
}

export function getGroupInvites(groupId: string): Promise<InviteResponse[]> {
  return request<InviteResponse[]>({
    method: 'GET',
    path: `/api/invites/group/${encodeURIComponent(groupId)}`,
  });
}
