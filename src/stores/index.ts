export { useAppStore } from './useAppStore';

// ---------------------------------------------------------------------------
// Selector hooks — ergonomic access for components.
// Each hook uses useShallow so it only triggers re-renders when the selected
// fields actually change (shallow equality), not on every store update.
// ---------------------------------------------------------------------------

import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from './useAppStore';
import type { Contact, MediaItem, TypingEntry } from '../types/store';

export const useAuth = () =>
  useAppStore(useShallow((s) => ({
    isAuthenticated: s.isAuthenticated,
    userId: s.userId,
    username: s.username,
    displayName: s.displayName,
    avatarPath: s.avatarPath,
    avatarDigest: s.avatarDigest,
    needsTermsAcceptance: s.needsTermsAcceptance,
    setUser: s.setUser,
    clearAuth: s.clearAuth,
    setAuthenticated: s.setAuthenticated,
    updateProfile: s.updateProfile,
    setNeedsTermsAcceptance: s.setNeedsTermsAcceptance,
  })));

export const useConversations = () =>
  useAppStore(useShallow((s) => ({
    conversations: s.conversations,
    conversationIds: s.conversationIds,
    activeConversationId: s.activeConversationId,
    viewingConversationId: s.viewingConversationId,
    setConversations: s.setConversations,
    setGroupConversations: s.setGroupConversations,
    upsertConversation: s.upsertConversation,
    removeConversation: s.removeConversation,
    setActiveConversation: s.setActiveConversation,
    updateUnreadCount: s.updateUnreadCount,
    incrementUnreadCount: s.incrementUnreadCount,
    markConversationRead: s.markConversationRead,
    setViewingConversation: s.setViewingConversation,
  })));

export const useThreads = () =>
  useAppStore(useShallow((s) => ({
    threads: s.threads,
    threadIdsByConversation: s.threadIdsByConversation,
    replies: s.replies,
    replyIdsByThread: s.replyIdsByThread,
    activeThreadId: s.activeThreadId,
    threadLastViewedAt: s.threadLastViewedAt,
    setThreads: s.setThreads,
    upsertThread: s.upsertThread,
    removeThread: s.removeThread,
    setActiveThread: s.setActiveThread,
    setReplies: s.setReplies,
    appendReplies: s.appendReplies,
    upsertReply: s.upsertReply,
    removeReply: s.removeReply,
    addOptimisticThread: s.addOptimisticThread,
    addOptimisticReply: s.addOptimisticReply,
    updateThreadSyncStatus: s.updateThreadSyncStatus,
    updateReplySyncStatus: s.updateReplySyncStatus,
    markThreadViewed: s.markThreadViewed,
  })));

export const useContacts = () =>
  useAppStore(useShallow((s) => ({
    contacts: s.contacts,
    setContacts: s.setContacts,
    mergeContacts: s.mergeContacts,
    upsertContact: s.upsertContact,
    removeContact: s.removeContact,
    setContactVerifiedStatus: s.setContactVerifiedStatus,
  })));

export const useUI = () =>
  useAppStore(useShallow((s) => ({
    colorScheme: s.colorScheme,
    activeTab: s.activeTab,
    composerDraft: s.composerDraft,
    isComposerOpen: s.isComposerOpen,
    syncOverallStatus: s.syncOverallStatus,
    soundEnabled: s.soundEnabled,
    setColorScheme: s.setColorScheme,
    setActiveTab: s.setActiveTab,
    setComposerDraft: s.setComposerDraft,
    toggleComposer: s.toggleComposer,
    setSyncStatus: s.setSyncStatus,
    setSoundEnabled: s.setSoundEnabled,
  })));

export const useNotifications = () =>
  useAppStore(useShallow((s) => ({
    pushPermissionGranted: s.pushPermissionGranted,
    pushToken: s.pushToken,
    setPushPermission: s.setPushPermission,
    setPushToken: s.setPushToken,
  })));

export const useConnection = () =>
  useAppStore(useShallow((s) => ({
    connectionStatus: s.connectionStatus,
    lastConnectedAt: s.lastConnectedAt,
    reconnectAttempt: s.reconnectAttempt,
    setConnectionStatus: s.setConnectionStatus,
    setLastConnectedAt: s.setLastConnectedAt,
    setReconnectAttempt: s.setReconnectAttempt,
    clearTypingUsers: s.clearTypingUsers,
  })));

/**
 * Scoped selector for typing users in a single conversation.
 * Only re-renders when typing entries for *this* conversation change,
 * not when other conversations' typing state updates.
 */
export const useTypingUsers = (conversationId: string | null): TypingEntry[] =>
  useAppStore(
    useShallow((s) =>
      conversationId ? (s.typingUsers[conversationId] ?? []) : [],
    ),
  );

/**
 * Scoped selector for media items attached to a specific thread.
 * Only re-renders when the media IDs for *this* thread change.
 */
export const useMediaForThread = (threadId: string | null): MediaItem[] =>
  useAppStore(
    useShallow((s) => {
      if (!threadId) return [];
      const ids = s.mediaIdsByThread[threadId] ?? [];
      return ids.map((id) => s.media[id]).filter(Boolean);
    }),
  );

/**
 * Scoped selector for media items attached to a specific reply.
 * Only re-renders when the media IDs for *this* reply change.
 */
export const useMediaForReply = (replyId: string | null): MediaItem[] =>
  useAppStore(
    useShallow((s) => {
      if (!replyId) return [];
      const ids = s.mediaIdsByReply[replyId] ?? [];
      return ids.map((id) => s.media[id]).filter(Boolean);
    }),
  );

/**
 * Reverse-lookup: find the contact whose conversationIds includes
 * the given conversationId. Used by DM screens to access the
 * recipient's contact record (including verifiedStatus).
 */
export const useContactForConversation = (conversationId: string | null): Contact | null =>
  useAppStore(
    useShallow((s) => {
      if (!conversationId) return null;
      for (const contact of Object.values(s.contacts)) {
        if (contact.conversationIds.includes(conversationId)) {
          return contact;
        }
      }
      return null;
    }),
  );
