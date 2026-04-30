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
  GroupKeyResponse,
  GroupMembersResponse,
  GroupQuotaResponse,
  GroupResponse,
  JoinGroupRequest,
  JoinGroupResponse,
} from '../../types/api';

interface ListGroupsApiResponse {
  groups: GroupResponse[];
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

export function getGroupMembers(groupId: string): Promise<GroupMembersResponse> {
  return request<GroupMembersResponse>({
    method: 'GET',
    path: `/api/groups/${encodeURIComponent(groupId)}/members`,
  });
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

export function removeMember(
  groupId: string,
  userId: string,
): Promise<void> {
  return request<void>({
    method: 'DELETE',
    path: `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
  });
}

interface ListDmsApiResponse {
  dms: DmResponse[];
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
