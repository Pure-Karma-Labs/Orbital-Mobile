export { useAppStore } from './useAppStore';

// ---------------------------------------------------------------------------
// Selector hooks — ergonomic access for components
// Each hook subscribes only to the fields it selects, minimising re-renders.
// ---------------------------------------------------------------------------

import { useAppStore } from './useAppStore';

export const useAuth = () =>
  useAppStore((s) => ({
    isAuthenticated: s.isAuthenticated,
    userId: s.userId,
    username: s.username,
    displayName: s.displayName,
    avatarPath: s.avatarPath,
    setUser: s.setUser,
    clearAuth: s.clearAuth,
    setAuthenticated: s.setAuthenticated,
  }));

export const useConversations = () =>
  useAppStore((s) => ({
    conversations: s.conversations,
    conversationIds: s.conversationIds,
    activeConversationId: s.activeConversationId,
    setConversations: s.setConversations,
    upsertConversation: s.upsertConversation,
    removeConversation: s.removeConversation,
    setActiveConversation: s.setActiveConversation,
    updateUnreadCount: s.updateUnreadCount,
    markConversationRead: s.markConversationRead,
  }));

export const useThreads = () =>
  useAppStore((s) => ({
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
    upsertReply: s.upsertReply,
    addOptimisticThread: s.addOptimisticThread,
    addOptimisticReply: s.addOptimisticReply,
    updateThreadSyncStatus: s.updateThreadSyncStatus,
    updateReplySyncStatus: s.updateReplySyncStatus,
  }));

export const useMessages = () =>
  useAppStore((s) => ({
    messages: s.messages,
    messageIdsByConversation: s.messageIdsByConversation,
    hasMoreMessages: s.hasMoreMessages,
    setMessages: s.setMessages,
    addMessage: s.addMessage,
    addOptimisticMessage: s.addOptimisticMessage,
    updateMessageSyncStatus: s.updateMessageSyncStatus,
    markMessageRead: s.markMessageRead,
    setHasMore: s.setHasMore,
  }));

export const useContacts = () =>
  useAppStore((s) => ({
    contacts: s.contacts,
    setContacts: s.setContacts,
    upsertContact: s.upsertContact,
    removeContact: s.removeContact,
  }));

export const useUI = () =>
  useAppStore((s) => ({
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
  }));
