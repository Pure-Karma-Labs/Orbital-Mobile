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
import { VerifiedStatus } from './database';

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
  /** Epoch ms snapshot from server load — when the user last read this conversation */
  lastReadAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Whether the current user is the orbit creator/owner. Updated via WS owner_changed. */
  isCreator?: boolean;
}

export interface Thread {
  id: string;
  conversationId: string;
  authorId: string;
  /** Author's username — sourced from the API response */
  authorUsername: string;
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
  /** Author's username — sourced from the API response */
  authorUsername: string;
  /** Decrypted from body_encrypted + body_iv in database */
  body: string | null;
  parentReplyId: string | null;
  /** Reply nesting depth (0 = top-level). Persisted to SQLCipher. */
  depth: number;
  createdAt: number;
  updatedAt: number;
  syncStatus: SyncStatus;
}

export interface Contact {
  /** Service ID — matches service_id in signal tables */
  id: string;
  /** Backend username — used for DM contact lookup */
  username: string | null;
  displayName: string | null;
  avatarPath: string | null;
  /** IDs of conversations (groups) this contact is a member of */
  conversationIds: string[];
  /** Identity key verification status — synced from SQLCipher identity store */
  verifiedStatus?: VerifiedStatus;
  /** Encrypted avatar attachment key (AES-GCM ciphertext, base64) */
  avatarEncryptedKey?: string | null;
  /** IV for avatar key decryption (base64) */
  avatarKeyIv?: string | null;
  /** SHA-256 digest of encrypted avatar blob (base64) — presence means encrypted avatar exists */
  avatarDigest?: string | null;
  /** Local file URI for the decrypted avatar image */
  localAvatarUri?: string | null;
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
  avatarDigest: string | null;
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
  updateProfile: (patch: Partial<Pick<AuthState, 'displayName' | 'avatarPath' | 'avatarDigest'>>) => void;
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
  /** The conversation the user is currently viewing (for unread suppression) */
  viewingConversationId: string | null;
}

export interface ConversationsActions {
  setConversations: (conversations: Conversation[]) => void;
  /**
   * Replace all group-type conversations while preserving existing DM conversations.
   * Fixes the load-wipe bug where loadConversations() would erase DM unread counts.
   */
  setGroupConversations: (groupConversations: Conversation[]) => void;
  upsertConversation: (conversation: Conversation) => void;
  removeConversation: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  updateUnreadCount: (id: string, count: number) => void;
  incrementUnreadCount: (id: string) => void;
  markConversationRead: (id: string) => void;
  setViewingConversation: (id: string | null) => void;
  bumpLastMessageAt: (id: string, timestamp: number) => void;
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
  /** Epoch ms of when the user last viewed each thread (persisted for per-thread unread) */
  threadLastViewedAt: Record<string, number>;
}

export interface ThreadsActions {
  setThreads: (conversationId: string, threads: Thread[]) => void;
  upsertThread: (thread: Thread) => void;
  removeThread: (id: string) => void;
  setActiveThread: (id: string | null) => void;
  setReplies: (threadId: string, replies: Reply[]) => void;
  /** Append replies without replacing existing ones — used for pagination */
  appendReplies: (threadId: string, replies: Reply[]) => void;
  upsertReply: (reply: Reply) => void;
  removeReply: (id: string) => void;
  addOptimisticThread: (thread: Thread) => void;
  addOptimisticReply: (reply: Reply) => void;
  updateThreadSyncStatus: (id: string, status: SyncStatus) => void;
  updateReplySyncStatus: (id: string, status: SyncStatus) => void;
  /** Record the user's last view time for a thread (for per-thread unread) */
  markThreadViewed: (threadId: string) => void;
}

export type ThreadsSlice = ThreadsState & ThreadsActions;

// ============================================================
// Contacts slice state
// ============================================================

export interface ContactsState {
  contacts: Record<string, Contact>;
}

export interface ContactsActions {
  setContacts: (contacts: Contact[]) => void;
  /** Additive field-level merge — unions conversationIds, preserves existing fields. */
  mergeContacts: (contacts: Contact[]) => void;
  upsertContact: (contact: Contact) => void;
  removeContact: (id: string) => void;
  /** Update verification status for a contact. No-op for unknown contacts. */
  setContactVerifiedStatus: (contactId: string, status: VerifiedStatus) => void;
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
  soundEnabled: boolean;
}

export interface UIActions {
  setColorScheme: (scheme: 'light' | 'dark' | 'system') => void;
  setActiveTab: (tab: 'threads' | 'chats' | 'settings') => void;
  setComposerDraft: (draft: Draft | null) => void;
  toggleComposer: () => void;
  setSyncStatus: (status: SyncStatus) => void;
  setSoundEnabled: (enabled: boolean) => void;
}

export type UISlice = UIState & UIActions;

// ============================================================
// Connection slice state (WebSocket)
// ============================================================

export interface TypingEntry {
  userId: string;
  expiresAt: number;
}

export interface ConnectionState {
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  lastConnectedAt: number | null;
  reconnectAttempt: number;
  typingUsers: Record<string, TypingEntry[]>;
}

export interface ConnectionActions {
  setConnectionStatus: (status: ConnectionState['connectionStatus']) => void;
  setLastConnectedAt: (timestamp: number | null) => void;
  setReconnectAttempt: (attempt: number) => void;
  addTypingUser: (conversationId: string, entry: TypingEntry) => void;
  removeTypingUser: (conversationId: string, userId: string) => void;
  clearTypingUsers: () => void;
}

export type ConnectionSlice = ConnectionState & ConnectionActions;

// ============================================================
// Media slice state
// ============================================================

export interface MediaItem {
  id: string;
  threadId: string | null;
  replyId: string | null;
  contentType: string;
  fileName: string | null;
  fileSize: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  blurHash: string | null;
  localPath: string | null;
  thumbnailPath: string | null;
  downloadState: 'pending' | 'downloading' | 'downloaded' | 'failed';
  uploadState: 'pending' | 'uploading' | 'done' | 'failed';
  expiresAt: number | null;
  /** Whether current user has attachment keys (own-media-only for v1) */
  hasKeys: boolean;
}

export interface MediaState {
  media: Record<string, MediaItem>;
  mediaIdsByThread: Record<string, string[]>;
  mediaIdsByReply: Record<string, string[]>;
}

export interface MediaActions {
  setMediaForThread: (threadId: string, items: MediaItem[]) => void;
  setMediaForReply: (replyId: string, items: MediaItem[]) => void;
  upsertMedia: (item: MediaItem) => void;
  /** Batch-hydrate media into the store. Skips items currently in 'downloading' state. */
  setMediaBatch: (items: MediaItem[]) => void;
  updateMediaDownloadState: (id: string, state: MediaItem['downloadState'], localPath?: string) => void;
  updateMediaUploadState: (id: string, state: MediaItem['uploadState']) => void;
  removeMedia: (id: string) => void;
}

export type MediaSlice = MediaState & MediaActions;

// ============================================================
// Notification slice state (push notifications)
// ============================================================

export interface NotificationState {
  pushPermissionGranted: boolean;
  pushToken: string | null;
}

export interface NotificationActions {
  setPushPermission: (granted: boolean) => void;
  setPushToken: (token: string | null) => void;
}

export type NotificationSlice = NotificationState & NotificationActions;

// ============================================================
// Blocked users slice state
// ============================================================

export interface BlockedUsersState {
  blockedUserIds: string[];
  /** Fallback username for display when the user is not in contacts */
  blockedUserProfiles: Record<string, string>;
}

export interface BlockedUsersActions {
  blockUser: (userId: string, username: string) => void;
  unblockUser: (userId: string) => void;
  resetBlockedUsers: () => void;
  hydrateBlockedUsers: (blockedUserIds: string[]) => void;
}

export type BlockedUsersSlice = BlockedUsersState & BlockedUsersActions;

// ============================================================
// Report slice state (transient — NOT persisted)
// ============================================================

export interface ReportTarget {
  contentType: 'user' | 'thread' | 'reply' | 'message' | 'media';
  contentId?: string;
  reportedUserId?: string;
  reportedUsername?: string;
  groupId?: string;
}

export interface ReportState {
  reportTarget: ReportTarget | null;
}

export interface ReportActions {
  openReportSheet: (target: ReportTarget) => void;
  closeReportSheet: () => void;
}

export type ReportSlice = ReportState & ReportActions;

// ============================================================
// Combined app state
// ============================================================

export type AppState = AuthSlice &
  ConversationsSlice &
  ThreadsSlice &
  ContactsSlice &
  UISlice &
  ConnectionSlice &
  MediaSlice &
  NotificationSlice &
  BlockedUsersSlice &
  ReportSlice;
