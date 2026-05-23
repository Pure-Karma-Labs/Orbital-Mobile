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
  processReceivedGroupKey,
} from './crypto/contentCrypto';
import { getIdentityKeyPair, resolveRemoteIdentityKey } from './crypto/identityKeyAccess';
import { generateUUID } from '../utils/uuid';
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
  const currentUserId = useAppStore.getState().userId;

  const uniqueSenders = new Set<string>();
  for (const group of groups) {
    if (group.wrappedGroupKey && group.wrappedBy) {
      uniqueSenders.add(group.wrappedBy);
    }
  }
  if (currentUserId && uniqueSenders.size > 0) {
    await Promise.all(
      Array.from(uniqueSenders).map((id) =>
        resolveRemoteIdentityKey(id, currentUserId).catch(() => {}),
      ),
    );
  }

  for (const group of groups) {
    if (group.wrappedGroupKey) {
      try {
        await processReceivedGroupKey(group.groupId, group.wrappedGroupKey, group.wrappedBy);
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
  const groupId = generateUUID();
  const { key, keyBase64 } = generateGroupKey();
  const encryptedName = encryptGroupName(name, key);
  const { publicKey: ownPubKey } = getIdentityKeyPair();
  const wrappedBase64 = wrapGroupKey(key, ownPubKey, groupId);

  const response = await createGroup({
    groupId,
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
  const currentUserId = useAppStore.getState().userId;

  const uniqueSenders = new Set<string>();
  for (const dm of dms) {
    if (dm.wrappedGroupKey && dm.wrappedBy) {
      uniqueSenders.add(dm.wrappedBy);
    }
  }
  if (currentUserId && uniqueSenders.size > 0) {
    await Promise.all(
      Array.from(uniqueSenders).map((id) =>
        resolveRemoteIdentityKey(id, currentUserId).catch(() => {}),
      ),
    );
  }

  for (const dm of dms) {
    if (dm.wrappedGroupKey) {
      try {
        await processReceivedGroupKey(dm.groupId, dm.wrappedGroupKey, dm.wrappedBy);
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
  const groupId = generateUUID();
  const { key, keyBase64 } = generateGroupKey();
  const { publicKey: ownPubKey } = getIdentityKeyPair();
  const wrappedBase64 = wrapGroupKey(key, ownPubKey, groupId);

  const currentUserId = useAppStore.getState().userId;
  let recipientWrappedGroupKey: string | undefined;
  if (currentUserId) {
    try {
      const recipientPubKey = await resolveRemoteIdentityKey(recipientId, currentUserId);
      recipientWrappedGroupKey = wrapGroupKey(key, recipientPubKey, groupId);
    } catch {
      // Recipient key resolution failed — send without recipient wrap
    }
  }

  const response = await createDm({
    groupId,
    recipientId,
    wrappedGroupKey: wrappedBase64,
    recipientWrappedGroupKey: recipientWrappedGroupKey ?? null,
  });

  if (response.isNew) {
    persistGroupKey(response.groupId, keyBase64);
  } else if (response.wrappedGroupKey) {
    try {
      await processReceivedGroupKey(response.groupId, response.wrappedGroupKey, response.wrappedBy);
    } catch {
      if (__DEV__) console.warn('[startDm] failed to process existing DM key');
    }
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
    try {
      await processReceivedGroupKey(
        response.groupId,
        response.wrappedGroupKey,
        response.wrappedBy ?? null,
      );
    } catch {
      // Key delivery may be async via WS wrapped_key_delivered
    }
  }

  let decryptedName: string | null = response.encryptedName ?? null;
  if (response.encryptedName) {
    try {
      const groupKey = await getOrFetchGroupKey(response.groupId);
      decryptedName = decryptGroupName(response.encryptedName, groupKey);
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
