/**
 * Groups / Orbits API service.
 */

import { request } from './client';
import type {
  CreateGroupRequest,
  CreateDmRequest,
  DmResponse,
  GroupKeyResponse,
  GroupMembersResponse,
  GroupQuotaResponse,
  GroupResponse,
  JoinGroupRequest,
  JoinGroupResponse,
} from '../../types/api';

export function createGroup(data: CreateGroupRequest): Promise<GroupResponse> {
  return request<GroupResponse>({
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

export function listGroups(): Promise<GroupResponse[]> {
  return request<GroupResponse[]>({
    method: 'GET',
    path: '/api/groups',
  });
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

export function createDm(data: CreateDmRequest): Promise<DmResponse> {
  return request<DmResponse>({
    method: 'POST',
    path: '/api/groups/dm',
    body: data,
  });
}

export function listDms(): Promise<DmResponse[]> {
  return request<DmResponse[]>({
    method: 'GET',
    path: '/api/groups/dms',
  });
}
