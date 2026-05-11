export { useAppStore } from './useAppStore';

// ---------------------------------------------------------------------------
// Selector hooks — ergonomic access for components.
// Each hook uses useShallow so it only triggers re-renders when the selected
// fields actually change (shallow equality), not on every store update.
// ---------------------------------------------------------------------------

import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from './useAppStore';

export const useAuth = () =>
  useAppStore(useShallow((s) => ({
    isAuthenticated: s.isAuthenticated,
    userId: s.userId,
    username: s.username,
    displayName: s.displayName,
    avatarPath: s.avatarPath,
    setUser: s.setUser,
    clearAuth: s.clearAuth,
    setAuthenticated: s.setAuthenticated,
  })));

export const useConversations = () =>
  useAppStore(useShallow((s) => ({
    conversations: s.conversations,
    conversationIds: s.conversationIds,
    activeConversationId: s.activeConversationId,
    setConversations: s.setConversations,
    upsertConversation: s.upsertConversation,
    removeConversation: s.removeConversation,
    setActiveConversation: s.setActiveConversation,
    updateUnreadCount: s.updateUnreadCount,
    markConversationRead: s.markConversationRead,
  })));

export const useThreads = () =>
  useAppStore(useShallow((s) => ({
    threads: s.threads,
    threadIdsByConversation: s.threadIdsByConversation,
    replies: s.replies,
    replyIdsByThread: s.replyIdsByThread,
    activeThreadId: s.activeThreadId,
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
  })));

export const useContacts = () =>
  useAppStore(useShallow((s) => ({
    contacts: s.contacts,
    setContacts: s.setContacts,
    upsertContact: s.upsertContact,
    removeContact: s.removeContact,
  })));

export const useUI = () =>
  useAppStore(useShallow((s) => ({
    colorScheme: s.colorScheme,
    activeTab: s.activeTab,
    composerDraft: s.composerDraft,
    isComposerOpen: s.isComposerOpen,
    syncOverallStatus: s.syncOverallStatus,
    setColorScheme: s.setColorScheme,
    setActiveTab: s.setActiveTab,
    setComposerDraft: s.setComposerDraft,
    toggleComposer: s.toggleComposer,
    setSyncStatus: s.setSyncStatus,
  })));
