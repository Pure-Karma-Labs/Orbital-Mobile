/**
 * Conversation data service — orchestrates group fetch, transform, and store operations.
 *
 * Mirrors the threadService pattern: API fetch → transform → store upsert.
 * Components never call the groups API or store directly.
 */

import { listGroups, createGroup, joinGroup, listDms, createDm, getPendingWraps, submitWrappedKey, selfWrapGroupKey, getGroupMembers } from './api/groups';
import {
  persistGroupKey,
  generateGroupKey,
  encryptGroupName,
  decryptGroupName,
  getOrFetchGroupKey,
  wrapGroupKey,
  processReceivedGroupKey,
  loadPersistedGroupKey,
  setCachedGroupKey,
  evictPendingCache,
} from './crypto/contentCrypto';
import { getIdentityKeyPair, resolveRemoteIdentityKey } from './crypto/identityKeyAccess';
import { ApiError } from './api/errors';
import { generateUUID } from '../utils/uuid';
import { useAppStore } from '../stores/useAppStore';
import type { Contact, Conversation } from '../types/store';
import type { DmResponse, GroupMember, GroupResponse } from '../types/api';

export interface DecryptedGroup {
  groupId: string;
  name: string;
  inviteCode: string | null;
  memberCount: number;
  isCreator: boolean;
}

async function decryptGroupNameSafe(
  encryptedName: string | null,
  groupId: string,
): Promise<string | null> {
  if (!encryptedName) return null;
  try {
    const groupKey = await getOrFetchGroupKey(groupId);
    return decryptGroupName(encryptedName, groupKey);
  } catch {
    return '(unable to decrypt)';
  }
}

async function mapGroupResponse(response: GroupResponse): Promise<Conversation> {
  const name = await decryptGroupNameSafe(response.encryptedName ?? null, response.groupId);

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

  // Self-wrap recovery: re-upload local keys the server is missing
  // MUST run as a separate loop AFTER processReceivedGroupKey completes
  await Promise.all(
    groups
      .filter(g => !g.wrappedGroupKey)
      .map(g => selfWrapIfNeeded(g.groupId).catch((e) => {
        if (__DEV__) console.warn('[loadConversations] self-wrap failed', g.groupId, e);
      }))
  );

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


// ---------------------------------------------------------------------------
// Ensure a DM conversation exists in the store (on-demand, for WS handlers)
// ---------------------------------------------------------------------------

const ensureDmInflight = new Map<string, Promise<Conversation | null>>();

export async function ensureDmConversation(groupId: string): Promise<Conversation | null> {
  const store = useAppStore.getState();
  const existing = store.conversations[groupId];
  if (existing) return existing;

  const inflight = ensureDmInflight.get(groupId);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const currentUserId = useAppStore.getState().userId;
      const dms = await listDms();
      const dm = dms.find(d => d.groupId === groupId);
      if (!dm) return null;

      if (dm.wrappedGroupKey && dm.wrappedBy) {
        if (currentUserId) {
          try {
            await resolveRemoteIdentityKey(dm.wrappedBy, currentUserId);
          } catch { /* identity key resolution failed */ }
        }
        try {
          await processReceivedGroupKey(dm.groupId, dm.wrappedGroupKey, dm.wrappedBy);
        } catch {
          if (__DEV__) console.warn('[ensureDmConversation] key processing failed');
        }
      }

      const conversation = mapDmResponse(dm);
      const storeNow = useAppStore.getState();
      storeNow.upsertConversation(conversation);

      storeNow.mergeContacts([{
        id: dm.recipient.id,
        username: dm.recipient.username,
        displayName: null,
        avatarPath: dm.recipient.avatarUrl ?? null,
        conversationIds: [dm.groupId],
      }]);

      return conversation;
    } finally {
      ensureDmInflight.delete(groupId);
    }
  })();

  ensureDmInflight.set(groupId, promise);
  return promise;
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

  // Self-wrap recovery: re-upload local keys the server is missing
  // MUST run as a separate loop AFTER processReceivedGroupKey completes
  await Promise.all(
    dms
      .filter(d => !d.wrappedGroupKey)
      .map(d => selfWrapIfNeeded(d.groupId).catch((e) => {
        if (__DEV__) console.warn('[loadDmConversations] self-wrap failed', d.groupId, e);
      }))
  );

  const conversations = dms.map(mapDmResponse);

  const store = useAppStore.getState();
  for (const conversation of conversations) {
    store.upsertConversation(conversation);
  }

  // Merge DM recipients into the contacts store so they're discoverable
  // in the New Chat contact picker
  const dmContacts: Contact[] = dms.map((dm) => ({
    id: dm.recipient.id,
    username: dm.recipient.username,
    displayName: null,
    avatarPath: dm.recipient.avatarUrl ?? null,
    conversationIds: [dm.groupId],
  }));
  if (dmContacts.length > 0) {
    store.mergeContacts(dmContacts);
  }

  // Fire-and-forget identity checks for ALL stored identity keys.
  // Covers both DM recipients and orbit members.
  // Lazy imports avoid pulling DB/crypto into test contexts.
  if (currentUserId) {
    Promise.all([
      import('../database/repositories/signalIdentityKeyRepository'),
      import('./verificationService'),
    ]).then(([{ getAllIdentityKeys }, { checkIdentityAndNotify }]) => {
      const allKeys = getAllIdentityKeys();
      for (const key of allKeys) {
        if (key.address !== 'local' && key.address !== currentUserId) {
          checkIdentityAndNotify(key.address, currentUserId).catch(() => {});
        }
      }
    }).catch(() => {});
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

export async function fetchCreatorOrbitsDecrypted(): Promise<DecryptedGroup[]> {
  const allGroups = await listGroups();
  const creatorGroups = allGroups.filter((g) => g.isCreator);

  const results: DecryptedGroup[] = [];
  for (const group of creatorGroups) {
    const name = (await decryptGroupNameSafe(group.encryptedName, group.groupId)) ?? group.groupId;
    results.push({
      groupId: group.groupId,
      name,
      inviteCode: group.activeInviteCode,
      memberCount: group.memberCount,
      isCreator: group.isCreator,
    });
  }
  return results;
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

  const decryptedName = await decryptGroupNameSafe(response.encryptedName ?? null, response.groupId);

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

// ---------------------------------------------------------------------------
// Self-wrap recovery (post-migration key re-upload)
// ---------------------------------------------------------------------------

const selfWrapInflight = new Map<string, Promise<void>>();

export async function selfWrapIfNeeded(groupId: string): Promise<void> {
  // Inflight dedup
  const existing = selfWrapInflight.get(groupId);
  if (existing) return existing;

  const p = _doSelfWrap(groupId);
  selfWrapInflight.set(groupId, p);
  try {
    await p;
  } finally {
    selfWrapInflight.delete(groupId);
  }
}

async function _doSelfWrap(groupId: string): Promise<void> {
  // Check if local key exists
  const localKey = loadPersistedGroupKey(groupId);
  if (!localKey) return;

  // Check if identity key pair is available
  let ownPubKey: ArrayBuffer;
  try {
    const { publicKey } = getIdentityKeyPair();
    ownPubKey = publicKey;
  } catch {
    return; // Identity keys not loaded yet
  }

  // Populate in-memory cache BEFORE network call
  setCachedGroupKey(groupId, localKey);

  // ECIES-wrap to self
  const wrapped = wrapGroupKey(localKey, ownPubKey, groupId);

  try {
    await selfWrapGroupKey(groupId, wrapped);
    evictPendingCache(groupId);
  } catch (e) {
    // 409 = another device beat us, silently ignore
    if (e instanceof ApiError && e.statusCode === 409) return;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Pending wraps fulfillment
// ---------------------------------------------------------------------------

let lastPendingWrapsSweep = 0;
const PENDING_WRAPS_DEBOUNCE_MS = 60_000;

/**
 * Proactively wrap and deliver group keys to members who are still waiting.
 * Debounced to at most once per minute to avoid hammering the API.
 *
 * Follows the same pattern as handleWrapKeyRequest in messageHandler.ts:
 * resolve the target's identity key via the pre-key bundle API, then ECIES-wrap.
 */
export async function fulfillPendingWraps(): Promise<void> {
  const now = Date.now();
  if (now - lastPendingWrapsSweep < PENDING_WRAPS_DEBOUNCE_MS) return;
  lastPendingWrapsSweep = now;

  const currentUserId = useAppStore.getState().userId;
  if (!currentUserId) return;

  const conversations = useAppStore.getState().conversations;
  const groupIds = Object.values(conversations)
    .filter(c => c.type === 'group')
    .map(c => c.id);

  for (const groupId of groupIds.slice(0, 10)) {
    try {
      const groupKey = await getOrFetchGroupKey(groupId);
      const pending = await getPendingWraps(groupId);
      if (pending.length === 0) continue;

      for (const member of pending.slice(0, 5)) {
        try {
          const targetPubKey = await resolveRemoteIdentityKey(member.userId, currentUserId);
          const wrapped = wrapGroupKey(groupKey, targetPubKey, groupId);
          await submitWrappedKey(groupId, member.userId, wrapped);
        } catch {
          // Skip members whose identity key can't be resolved
        }
      }
    } catch {
      // Skip groups where we don't have a key (we're the pending one)
    }
  }
}

// ---------------------------------------------------------------------------
// Contact hydration from orbit membership
// ---------------------------------------------------------------------------

let lastContactHydration = 0;
const CONTACT_HYDRATION_DEBOUNCE_MS = 60_000;

/**
 * Populate the contacts store with members from all orbits.
 * Debounced to at most once per minute. Also reconciles removed members.
 */
export async function hydrateContactsFromOrbits(): Promise<void> {
  const now = Date.now();
  if (now - lastContactHydration < CONTACT_HYDRATION_DEBOUNCE_MS) return;
  lastContactHydration = now;

  const store = useAppStore.getState();
  const currentUserId = store.userId;
  if (!currentUserId) return;

  const groupConvs = Object.values(store.conversations).filter(
    (c) => c.type === 'group',
  );
  if (groupConvs.length === 0) return;

  const results = await Promise.all(
    groupConvs.map((conv) =>
      getGroupMembers(conv.id)
        .then((members) => ({ convId: conv.id, members, ok: true }))
        .catch(() => ({ convId: conv.id, members: [] as GroupMember[], ok: false })),
    ),
  );

  const incoming: Contact[] = [];
  const serverMemberIds = new Set<string>();
  const succeededConvIds = new Set<string>();

  for (const { convId, members, ok } of results) {
    if (ok) succeededConvIds.add(convId);
    for (const member of members) {
      if (member.userId === currentUserId) continue;
      serverMemberIds.add(member.userId);
      incoming.push({
        id: member.userId,
        username: member.username,
        displayName: member.displayName || member.username,
        avatarPath: member.avatarUrl ?? null,
        conversationIds: [convId],
      });
    }
  }

  if (incoming.length > 0) {
    store.mergeContacts(incoming);
  }

  // Reconcile: remove contacts whose only conversationIds were successfully
  // fetched orbits and who are no longer in any of those orbits on the server.
  // Skip orbits where the fetch failed to avoid false-positive deletions.
  if (succeededConvIds.size === 0) return;
  const latestContacts = useAppStore.getState().contacts;
  for (const [id, contact] of Object.entries(latestContacts)) {
    if (
      !serverMemberIds.has(id) &&
      (contact.conversationIds ?? []).every((cid) =>
        succeededConvIds.has(cid),
      )
    ) {
      useAppStore.getState().removeContact(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Session cleanup
// ---------------------------------------------------------------------------

export function clearConversationServiceState(): void {
  selfWrapInflight.clear();
  ensureDmInflight.clear();
  lastPendingWrapsSweep = 0;
  lastContactHydration = 0;
}
