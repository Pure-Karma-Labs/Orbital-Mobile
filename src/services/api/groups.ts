/**
 * Groups / Orbits API service.
 */

import { request } from './client';
import type {
  CreateDmRequest,
  CreateDmResponse,
  CreateGroupRequest,
  CreateGroupResponse,
  DmResponse,
  GenerateInviteCodeOptions,
  GenerateInviteCodeResponse,
  GenerateInviteCodeV2Response,
  GroupKeyResponse,
  GroupMember,
  GroupMembersResponse,
  GroupQuotaResponse,
  GroupResponse,
  JoinGroupRequest,
  JoinGroupResponse,
  PendingWrapsResponse,
} from '../../types/api';

interface ListGroupsApiResponse {
  groups: GroupResponse[];
}

interface ListDmsApiResponse {
  dms: DmResponse[];
}

export function createGroup(data: CreateGroupRequest): Promise<CreateGroupResponse> {
  return request<CreateGroupResponse>({
    method: 'POST',
    path: '/api/groups',
    body: data,
  });
}

export function joinGroup(data: JoinGroupRequest): Promise<JoinGroupResponse> {
  return request<JoinGroupResponse>({
    method: 'POST',
    path: '/api/groups/join',
    body: data,
  });
}

export async function listGroups(): Promise<GroupResponse[]> {
  const response = await request<ListGroupsApiResponse>({
    method: 'GET',
    path: '/api/groups',
  });
  return response.groups;
}

export function getGroupKey(groupId: string): Promise<GroupKeyResponse> {
  return request<GroupKeyResponse>({
    method: 'GET',
    path: `/api/groups/${encodeURIComponent(groupId)}/key`,
  });
}

export function getGroupQuota(groupId: string): Promise<GroupQuotaResponse> {
  return request<GroupQuotaResponse>({
    method: 'GET',
    path: `/api/groups/${encodeURIComponent(groupId)}/quota`,
  });
}

export function createDm(data: CreateDmRequest): Promise<CreateDmResponse> {
  return request<CreateDmResponse>({
    method: 'POST',
    path: '/api/groups/dm',
    body: data,
  });
}

export async function listDms(): Promise<DmResponse[]> {
  const response = await request<ListDmsApiResponse>({
    method: 'GET',
    path: '/api/groups/dms',
  });
  return response.dms;
}

export function submitWrappedKey(
  groupId: string,
  userId: string,
  wrappedGroupKey: string,
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>({
    method: 'POST',
    path: `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/wrapped-key`,
    body: { wrappedGroupKey },
  });
}

export function selfWrapGroupKey(
  groupId: string,
  wrappedGroupKey: string,
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>({
    method: 'POST',
    path: `/api/groups/${encodeURIComponent(groupId)}/self-wrap`,
    body: { wrappedGroupKey },
  });
}

export async function getPendingWraps(
  groupId: string,
): Promise<PendingWrapsResponse['pending']> {
  const response = await request<PendingWrapsResponse>({
    method: 'GET',
    path: `/api/groups/${encodeURIComponent(groupId)}/pending-wraps`,
  });
  return response.pending;
}

export async function getGroupMembers(groupId: string): Promise<GroupMember[]> {
  const response = await request<GroupMembersResponse>({
    method: 'GET',
    path: `/api/groups/${encodeURIComponent(groupId)}/members`,
  });
  return response.members;
}

export function generateInviteCode(
  groupId: string,
  targetEmail: string,
): Promise<GenerateInviteCodeResponse>;
export function generateInviteCode(
  groupId: string,
  targetEmail: string,
  options: GenerateInviteCodeOptions,
): Promise<GenerateInviteCodeV2Response>;
export function generateInviteCode(
  groupId: string,
  targetEmail: string,
  options?: GenerateInviteCodeOptions,
): Promise<GenerateInviteCodeResponse | GenerateInviteCodeV2Response> {
  const body: Record<string, string> = {targetEmail};
  if (options) {
    body.code = options.code;
    body.encryptedGroupKey = options.encryptedGroupKey;
  }
  return request<GenerateInviteCodeResponse | GenerateInviteCodeV2Response>({
    method: 'POST',
    path: `/api/groups/${encodeURIComponent(groupId)}/invite-codes`,
    body,
  });
}

export async function removeMember(groupId: string, userId: string): Promise<void> {
  await request<void>({
    method: 'DELETE',
    path: `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
  });
}

export async function transferOrbitOwner(
  groupId: string,
  newOwnerId: string,
): Promise<void> {
  await request<{ success: boolean }>({
    method: 'POST',
    path: `/api/groups/${encodeURIComponent(groupId)}/transfer-owner`,
    body: { newOwnerId },
  });
}

export async function dissolveOrbit(groupId: string): Promise<void> {
  await request<{ success: boolean }>({
    method: 'DELETE',
    path: `/api/groups/${encodeURIComponent(groupId)}`,
  });
}

/**
 * Mark a group as read for the current user.
 * POST /api/groups/:groupId/read (no body) → 200 { last_read_at }
 */
export function markGroupRead(
  groupId: string,
): Promise<{ lastReadAt: string }> {
  return request<{ lastReadAt: string }>({
    method: 'POST',
    path: `/api/groups/${encodeURIComponent(groupId)}/read`,
  });
}

