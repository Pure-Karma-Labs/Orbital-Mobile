/**
 * Conversation data service — orchestrates group fetch, transform, and store operations.
 *
 * Mirrors the threadService pattern: API fetch → transform → store upsert.
 * Components never call the groups API or store directly.
 */

import { listGroups, createGroup, joinGroup } from './api/groups';
import {
  persistGroupKey,
  generateGroupKey,
  encryptGroupName,
  decryptGroupName,
  getOrFetchGroupKey,
} from './crypto/contentCrypto';
import { base64ToArrayBuffer } from './crypto/utils';
import { useAppStore } from '../stores/useAppStore';
import type { Conversation } from '../types/store';
import type { GroupResponse } from '../types/api';

async function mapGroupResponse(response: GroupResponse): Promise<Conversation> {
  let name: string | null = response.encryptedName ?? null;

  if (response.encryptedName) {
    try {
      const groupKey = await getOrFetchGroupKey(response.groupId);
      name = decryptGroupName(response.encryptedName, groupKey);
    } catch {
      // Decryption failed — legacy plaintext or missing key. Use raw value.
    }
  }

  return {
    id: response.groupId,
    type: 'group',
    name,
    memberCount: response.memberCount,
    active: true,
    muteUntil: null,
    lastMessageAt: null,
    unreadCount: 0,
    createdAt: new Date(response.joinedAt).getTime(),
    updatedAt: new Date(response.joinedAt).getTime(),
  };
}

export async function loadConversations(): Promise<void> {
  const groups = await listGroups();

  for (const group of groups) {
    if (group.encryptedGroupKey) {
      try {
        persistGroupKey(group.groupId, group.encryptedGroupKey);
      } catch {
        // Validation failed — skip, will retry on next load
      }
    }
  }

  const conversations = await Promise.all(groups.map(mapGroupResponse));

  const store = useAppStore.getState();
  store.setConversations(conversations);

  if (store.activeConversationId === null && conversations.length > 0) {
    store.setActiveConversation(conversations[0].id);
  }
}

export async function createOrbit(name: string): Promise<{ groupId: string }> {
  const { key, keyBase64 } = generateGroupKey();
  const encryptedName = encryptGroupName(name, key);

  const response = await createGroup({
    encryptedName,
    encryptedGroupKey: keyBase64,
  });

  persistGroupKey(response.groupId, keyBase64);

  const now = Date.now();
  const store = useAppStore.getState();
  store.upsertConversation({
    id: response.groupId,
    type: 'group',
    name,
    memberCount: 1,
    active: true,
    muteUntil: null,
    lastMessageAt: null,
    unreadCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  store.setActiveConversation(response.groupId);

  return { groupId: response.groupId };
}

export async function joinOrbit(
  inviteCode: string,
): Promise<{ groupId: string; name: string | null }> {
  const response = await joinGroup({
    inviteCode,
    encryptedGroupKey: '',
  });

  if (response.groupKey) {
    persistGroupKey(response.groupId, response.groupKey);
  }

  let decryptedName: string | null = response.encryptedName ?? null;
  if (response.encryptedName && response.groupKey) {
    try {
      const groupKeyBytes = new Uint8Array(base64ToArrayBuffer(response.groupKey));
      decryptedName = decryptGroupName(response.encryptedName, groupKeyBytes);
    } catch {
      // Decryption failed — use raw encrypted name as fallback
    }
  }

  const now = Date.now();
  const store = useAppStore.getState();
  store.upsertConversation({
    id: response.groupId,
    type: 'group',
    name: decryptedName,
    memberCount: response.memberCount,
    active: true,
    muteUntil: null,
    lastMessageAt: null,
    unreadCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  store.setActiveConversation(response.groupId);

  return { groupId: response.groupId, name: decryptedName };
}
