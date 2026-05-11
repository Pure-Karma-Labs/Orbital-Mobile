/**
 * Groups / Orbits API service.
 */

import { request } from './client';
import type {
  CreateGroupRequest,
  CreateGroupResponse,
  GroupKeyResponse,
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

