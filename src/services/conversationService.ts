/**
 * Conversation data service — orchestrates group fetch, transform, and store operations.
 *
 * Mirrors the threadService pattern: API fetch → transform → store upsert.
 * Components never call the groups API or store directly.
 */

import { listGroups } from './api/groups';
import { useAppStore } from '../stores/useAppStore';
import type { Conversation } from '../types/store';
import type { GroupResponse } from '../types/api';

function mapGroupResponse(response: GroupResponse): Conversation {
  return {
    id: response.groupId,
    type: 'group',
    // TODO: Decrypt encryptedName with group key when key distribution pipeline is ready.
    // Backend currently sends plaintext in this field.
    name: response.encryptedName ?? null,
    memberCount: response.memberCount,
    active: true,
    muteUntil: null,
    lastMessageAt: null,
    unreadCount: 0,
    createdAt: new Date(response.joinedAt).getTime(),
    updatedAt: new Date(response.joinedAt).getTime(),
  };
}

/**
 * Fetch the user's groups from the API and populate the conversation store.
 * Auto-selects the first group if no conversation is currently active.
 */
export async function loadConversations(): Promise<void> {
  const groups = await listGroups();
  const conversations = groups.map(mapGroupResponse);

  const store = useAppStore.getState();
  store.setConversations(conversations);

  if (store.activeConversationId === null && conversations.length > 0) {
    store.setActiveConversation(conversations[0].id);
  }
}
