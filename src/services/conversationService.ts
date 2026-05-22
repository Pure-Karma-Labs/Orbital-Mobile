/**
 * Conversation data service — orchestrates group fetch, transform, and store operations.
 *
 * Mirrors the threadService pattern: API fetch → transform → store upsert.
 * Components never call the groups API or store directly.
 */

import { listGroups, createGroup, joinGroup, listDms, createDm } from './api/groups';
import {
  persistGroupKey,
  generateGroupKey,
  encryptGroupName,
  decryptGroupName,
  getOrFetchGroupKey,
  wrapGroupKey,
} from './crypto/contentCrypto';
import { getIdentityKeyPair } from './crypto/identityKeyAccess';
import { base64ToArrayBuffer } from './crypto/utils';
import { useAppStore } from '../stores/useAppStore';
import type { Conversation } from '../types/store';
import type { DmResponse, GroupResponse } from '../types/api';

async function mapGroupResponse(response: GroupResponse): Promise<Conversation> {
  let name: string | null = response.encryptedName ?? null;

  if (response.encryptedName) {
    try {
      const groupKey = await getOrFetchGroupKey(response.groupId);
      name = decryptGroupName(response.encryptedName, groupKey);
    } catch {
      name = '(unable to decrypt)';
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
    if (group.wrappedGroupKey) {
      try {
        persistGroupKey(group.groupId, group.wrappedGroupKey);
      } catch {
        if (__DEV__) console.warn('[loadConversations] invalid group key for', group.groupId);
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

export async function createOrbit(name: string): Promise<{ groupId: string; inviteCode: string | null }> {
  const { key, keyBase64 } = generateGroupKey();
  const encryptedName = encryptGroupName(name, key);
  const { publicKey: ownPubKey } = getIdentityKeyPair();
  const wrappedBase64 = wrapGroupKey(key, ownPubKey);

  const response = await createGroup({
    encryptedName,
    wrappedGroupKey: wrappedBase64,
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

  return { groupId: response.groupId, inviteCode: response.inviteCode ?? null };
}

function mapDmResponse(response: DmResponse): Conversation {
  return {
    id: response.groupId,
    type: 'direct',
    name: response.recipient.username,
    memberCount: 2,
    active: true,
    muteUntil: null,
    lastMessageAt: response.lastMessageAt
      ? new Date(response.lastMessageAt).getTime()
      : null,
    unreadCount: 0,
    createdAt: new Date(response.createdAt).getTime(),
    updatedAt: new Date(response.createdAt).getTime(),
  };
}

export async function loadDmConversations(): Promise<void> {
  const dms = await listDms();

  for (const dm of dms) {
    if (dm.wrappedGroupKey) {
      try {
        persistGroupKey(dm.groupId, dm.wrappedGroupKey);
      } catch {
        if (__DEV__) console.warn('[loadDmConversations] invalid group key for', dm.groupId);
      }
    }
  }

  const conversations = dms.map(mapDmResponse);

  const store = useAppStore.getState();
  for (const conversation of conversations) {
    store.upsertConversation(conversation);
  }
}

export async function startDm(
  recipientId: string,
): Promise<{ conversationId: string; recipientName: string }> {
  const { key, keyBase64 } = generateGroupKey();
  const { publicKey: ownPubKey } = getIdentityKeyPair();
  const wrappedBase64 = wrapGroupKey(key, ownPubKey);

  const response = await createDm({
    recipientId,
    wrappedGroupKey: wrappedBase64,
  });

  if (response.isNew) {
    persistGroupKey(response.groupId, keyBase64);
  } else if (response.wrappedGroupKey) {
    persistGroupKey(response.groupId, response.wrappedGroupKey);
  }

  const now = Date.now();
  const store = useAppStore.getState();
  store.upsertConversation({
    id: response.groupId,
    type: 'direct',
    name: response.recipient.username,
    memberCount: 2,
    active: true,
    muteUntil: null,
    lastMessageAt: null,
    unreadCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  return {
    conversationId: response.groupId,
    recipientName: response.recipient.username,
  };
}

/**
 * Fetch all groups the user belongs to, including active invite codes.
 *
 * Used by the InviteFriends screen to display shareable invite codes per orbit.
 * The GroupResponse type already includes `activeInviteCode`.
 */
export async function fetchGroupsWithInviteCodes(): Promise<GroupResponse[]> {
  return listGroups();
}

export async function joinOrbit(
  inviteCode: string,
): Promise<{ groupId: string; name: string | null }> {
  const response = await joinGroup({
    inviteCode,
  });

  if (response.wrappedGroupKey) {
    persistGroupKey(response.groupId, response.wrappedGroupKey);
  }

  let decryptedName: string | null = response.encryptedName ?? null;
  if (response.encryptedName && response.wrappedGroupKey) {
    try {
      const groupKeyBytes = new Uint8Array(base64ToArrayBuffer(response.wrappedGroupKey));
      decryptedName = decryptGroupName(response.encryptedName, groupKeyBytes);
    } catch {
      decryptedName = '(unable to decrypt)';
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
