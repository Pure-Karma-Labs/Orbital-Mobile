/**
 * Decrypted, UI-ready types for Orbital-Mobile store layer.
 *
 * These are what components consume — they hold plain strings for titles/bodies
 * (decrypted from the Uint8Array encrypted versions in database.ts).
 *
 * The encryption boundary is: database rows hold encrypted Uint8Array blobs;
 * these store types hold the post-decryption strings used in the UI.
 */

import type {
  ConversationType,
  ThreadContentType,
  DraftContextType,
} from './database';

// ============================================================
// Shared
// ============================================================

export type SyncStatus = 'synced' | 'pending' | 'syncing' | 'failed';

// ============================================================
// Domain types (decrypted, UI-ready)
// ============================================================

export interface Conversation {
  id: string;
  type: ConversationType;
  name: string | null;
  memberCount: number;
  /** Converted from 0|1 integer in database */
  active: boolean;
  muteUntil: number | null;
  lastMessageAt: number | null;
  unreadCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Thread {
  id: string;
  conversationId: string;
  authorId: string;
  /** Decrypted from title_encrypted + title_iv in database */
  title: string | null;
  /** Decrypted from body_encrypted + body_iv in database */
  body: string | null;
  contentType: ThreadContentType;
  /** Converted from 0|1 integer in database */
  pinned: boolean;
  replyCount: number;
  lastReplyAt: number | null;
  createdAt: number;
  updatedAt: number;
  syncStatus: SyncStatus;
}

export interface Reply {
  id: string;
  threadId: string;
  authorId: string;
  /** Decrypted from body_encrypted + body_iv in database */
  body: string | null;
  parentReplyId: string | null;
  /** Computed depth for UI rendering — not stored in database */
  depth: number;
  createdAt: number;
  updatedAt: number;
  syncStatus: SyncStatus;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  type: 'message' | 'thread_update' | 'reaction' | 'system';
  /** Decrypted from body_encrypted + body_iv in database */
  body: string | null;
  serverTimestamp: number;
  receivedAt: number;
  /** Converted from 0|1 integer in database */
  read: boolean;
  expiresAt: number | null;
  syncStatus: SyncStatus;
}

export interface Contact {
  /** Service ID — matches service_id in signal tables */
  id: string;
  displayName: string | null;
  avatarPath: string | null;
  /** IDs of conversations (groups) this contact is a member of */
  conversationIds: string[];
}

export interface Draft {
  contextId: string;
  contextType: DraftContextType;
  body: string | null;
  updatedAt: number;
}

// ============================================================
// Auth slice state
// ============================================================

export interface AuthState {
  isAuthenticated: boolean;
  userId: string | null;
  username: string | null;
  displayName: string | null;
  avatarPath: string | null;
}

/** Auth actions — JWT tokens and encryption keys are NOT stored here */
export interface AuthActions {
  setUser: (user: {
    userId: string;
    username: string;
    displayName: string | null;
    avatarPath: string | null;
  }) => void;
  clearAuth: () => void;
  setAuthenticated: (authenticated: boolean) => void;
}

export type AuthSlice = AuthState & AuthActions;

// ============================================================
// Conversations slice state
// ============================================================

export interface ConversationsState {
  conversations: Record<string, Conversation>;
  /** Ordered by lastMessageAt descending */
  conversationIds: string[];
  activeConversationId: string | null;
}

export interface ConversationsActions {
  setConversations: (conversations: Conversation[]) => void;
  upsertConversation: (conversation: Conversation) => void;
  removeConversation: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  updateUnreadCount: (id: string, count: number) => void;
  markConversationRead: (id: string) => void;
}

export type ConversationsSlice = ConversationsState & ConversationsActions;

// ============================================================
// Threads slice state
// ============================================================

export interface ThreadsState {
  threads: Record<string, Thread>;
  /** Maps conversationId -> ordered thread IDs */
  threadIdsByConversation: Record<string, string[]>;
  replies: Record<string, Reply>;
  /** Maps threadId -> ordered reply IDs */
  replyIdsByThread: Record<string, string[]>;
  activeThreadId: string | null;
}

export interface ThreadsActions {
  setThreads: (conversationId: string, threads: Thread[]) => void;
  upsertThread: (thread: Thread) => void;
  removeThread: (id: string) => void;
  setActiveThread: (id: string | null) => void;
  setReplies: (threadId: string, replies: Reply[]) => void;
  upsertReply: (reply: Reply) => void;
  addOptimisticThread: (thread: Thread) => void;
  addOptimisticReply: (reply: Reply) => void;
  updateThreadSyncStatus: (id: string, status: SyncStatus) => void;
  updateReplySyncStatus: (id: string, status: SyncStatus) => void;
}

export type ThreadsSlice = ThreadsState & ThreadsActions;

// ============================================================
// Messages slice state
// ============================================================

export interface MessagesState {
  messages: Record<string, Message>;
  /** Maps conversationId -> ordered message IDs */
  messageIdsByConversation: Record<string, string[]>;
  hasMoreMessages: Record<string, boolean>;
}

export interface MessagesActions {
  setMessages: (conversationId: string, messages: Message[]) => void;
  addMessage: (message: Message) => void;
  addOptimisticMessage: (message: Message) => void;
  updateMessageSyncStatus: (id: string, status: SyncStatus) => void;
  markMessageRead: (id: string) => void;
  setHasMore: (conversationId: string, hasMore: boolean) => void;
}

export type MessagesSlice = MessagesState & MessagesActions;

// ============================================================
// Contacts slice state
// ============================================================

export interface ContactsState {
  contacts: Record<string, Contact>;
}

export interface ContactsActions {
  setContacts: (contacts: Contact[]) => void;
  upsertContact: (contact: Contact) => void;
  removeContact: (id: string) => void;
}

export type ContactsSlice = ContactsState & ContactsActions;

// ============================================================
// UI slice state
// ============================================================

export interface UIState {
  colorScheme: 'light' | 'dark' | 'system';
  activeTab: 'threads' | 'chats' | 'settings';
  composerDraft: Draft | null;
  isComposerOpen: boolean;
  syncOverallStatus: SyncStatus;
}

export interface UIActions {
  setColorScheme: (scheme: 'light' | 'dark' | 'system') => void;
  setActiveTab: (tab: 'threads' | 'chats' | 'settings') => void;
  setComposerDraft: (draft: Draft | null) => void;
  toggleComposer: () => void;
  setSyncStatus: (status: SyncStatus) => void;
}

export type UISlice = UIState & UIActions;

// ============================================================
// Combined app state
// ============================================================

export type AppState = AuthSlice &
  ConversationsSlice &
  ThreadsSlice &
  MessagesSlice &
  ContactsSlice &
  UISlice;
