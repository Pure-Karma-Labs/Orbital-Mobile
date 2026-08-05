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
import type { NotificationPrefs, MuteTargetType } from './api';
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
  // NOTE (#449): the dead `muteUntil` field was removed here — it was always
  // hardcoded null and never read. Per-target muting lives in
  // NotificationState.mutedTargets (server-authoritative). The SQLite
  // `conversations.mute_until` column is retained untouched.
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
  /**
   * Server-authoritative flag: true when the user must accept the current ToS
   * before accessing the app. Hydrated from login/verify-token responses;
   * cleared by acceptCurrentTerms() on successful POST /api/terms/accept.
   * NOT persisted — re-derived from the server on each session.
   */
  needsTermsAcceptance: boolean;
  /**
   * True when the server returned a 409 on key upload, indicating this device's
   * identity key conflicts with the server's record. Gates the app behind
   * KeyConflictScreen until recovery completes.
   * NOT persisted — transient, reset in setUser/clearAuth.
   */
  identityKeyConflict: boolean;
  /**
   * True while keyRecoveryService.recoverIdentityKeys() is executing.
   * Gates the app on a recovery progress screen (outranks key-conflict).
   * NOT persisted — transient, reset in setUser/clearAuth.
   */
  keyRecoveryInProgress: boolean;
  /**
   * Transient email captured from the login/signup INPUT parameter.
   * Used by key recovery to re-login (LoginResponse has no email field).
   * NOT persisted (PII) — nulled in setUser/clearAuth.
   */
  email: string | null;
  /**
   * How the identity key conflict was detected:
   * - 'local': 409 from this device's key upload or settings-row recovery
   * - 'push': identity_key_reset push from another device
   * Drives skipServerReset in recovery and KeyConflictScreen copy.
   * NOT persisted — transient, reset in setUser/clearAuth.
   */
  conflictSource: 'push' | 'local' | null;
  /**
   * Last non-success result from key recovery, hoisted to the store so the
   * UI can display it even after the screen unmounts/remounts during recovery.
   * NOT persisted — transient, reset in setUser/clearAuth.
   */
  keyRecoveryError: {
    status: 'incorrect_password' | 'rate_limited' | 'needs_email' | 'error';
    message?: string;
  } | null;
  /**
   * True when identity restore was deferred due to a transient network failure.
   * Drives a non-blocking retry banner in the UI. Cleared on successful retry
   * or on setUser/clearAuth.
   * NOT persisted — transient, reset in setUser/clearAuth.
   */
  identityRestoreDeferred: boolean;
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
  setNeedsTermsAcceptance: (needs: boolean) => void;
  setIdentityKeyConflict: (conflict: boolean) => void;
  setKeyRecoveryInProgress: (inProgress: boolean) => void;
  setEmail: (email: string | null) => void;
  setConflictSource: (source: 'push' | 'local' | null) => void;
  setKeyRecoveryError: (error: AuthState['keyRecoveryError']) => void;
  setIdentityRestoreDeferred: (deferred: boolean) => void;
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
  downloadState: 'pending' | 'downloading' | 'downloaded' | 'failed' | 'unavailable';
  uploadState: 'pending' | 'uploading' | 'done' | 'failed';
  expiresAt: number | null;
  /** Whether current user has attachment keys (own-media-only for v1) */
  hasKeys: boolean;
  /** Media ID of the thumbnail child (for video parent items) */
  thumbnailMediaId: string | null;
  /** True if this item is a thumbnail child row (excluded from library views) */
  isThumbnail: boolean;
}

export interface MediaState {
  media: Record<string, MediaItem>;
  mediaIdsByThread: Record<string, string[]>;
  mediaIdsByReply: Record<string, string[]>;
}

export interface MediaActions {
  mergeMediaForThread: (threadId: string, items: MediaItem[]) => void;
  mergeMediaForReply: (replyId: string, items: MediaItem[]) => void;
  /** Batch merge media + indexes in a single set() call (local hydration). */
  mergeMediaBatch: (byParent: Map<string, { type: 'thread' | 'reply'; items: MediaItem[] }>) => void;
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

/**
 * A queued mute intent awaiting server confirmation (#678).
 *
 * Ids and a type discriminator only — never content, titles, or key material.
 * `ownerUserId` binds the entry to the account that created it: a queue that
 * outlives its account (interrupted key recovery deletes `lastUserId` without
 * running localWipe) must be discarded, never replayed under another user's
 * JWT. `attempts` counts failed drains so a permanently failing entry cannot
 * pin the sync overlay over server truth forever.
 */
export interface PendingMuteOp {
  targetType: MuteTargetType;
  muted: boolean;
  ownerUserId: string;
  attempts: number;
}

export interface NotificationState {
  pushPermissionGranted: boolean;
  pushToken: string | null;
  /**
   * Explicit user opt-out from push, i.e. the master Push toggle read as Off by
   * deliberate choice (#683). Distinct from `pushPermissionGranted`, which is
   * OS-derived and re-read every launch: intent must survive a restart, OS state
   * must not.
   *
   * PERSISTED (partialize allowlist), and ACCOUNT-scoped: it is reset to `false`
   * by `resetNotificationSettings()` on localWipe, so an opt-out survives a
   * restart but NOT a logout — a fresh login registers by default rather than
   * inheriting the previous account's intent.
   */
  pushOptOut: boolean;
  /** Per-type push preferences (#449). Defaults all-true; persisted. */
  notificationPrefs: NotificationPrefs;
  /**
   * Muted targets keyed by target id (thread id or group id) (#449).
   * Presence of a key means "muted"; the value records what kind of target
   * it is so the UI can render the right affordance. Persisted.
   */
  mutedTargets: Record<string, MuteTargetType>;
  /**
   * Write-ahead queue of unconfirmed mute intents, keyed by target id (#678).
   * Persisted, so a toggle made offline survives a restart; drained before the
   * next sync and overlaid on the server snapshot until it converges.
   */
  pendingMuteOps: Record<string, PendingMuteOp>;
}

export interface NotificationActions {
  setPushPermission: (granted: boolean) => void;
  setPushToken: (token: string | null) => void;
  /**
   * Record the user's master-push intent (#683). Written only by
   * notificationService's `setPushEnabled` — pure store mutation, no network.
   */
  setPushOptOut: (value: boolean) => void;
  /** Merge a partial pref patch into the current prefs (pure — no API call). */
  setNotificationPrefs: (prefs: Partial<NotificationPrefs>) => void;
  /** Replace the whole muted-target map (server-authoritative sync). */
  setMutedTargets: (targets: Record<string, MuteTargetType>) => void;
  addMutedTarget: (targetId: string, targetType: MuteTargetType) => void;
  removeMutedTarget: (targetId: string) => void;
  /**
   * Record a mute intent in ONE set(): flips `mutedTargets` and writes the
   * queue entry together (#678). Two persisted keys in one write — every set()
   * on a persisted key re-serializes the whole partialized blob into MMKV.
   *
   * At MAX_PENDING_MUTE_OPS a *new* target is flipped but not enqueued; the
   * caller's runner is seeded with its own intent, so the request still goes
   * out once — only the survive-a-restart guarantee is dropped.
   */
  applyMuteIntent: (targetId: string, op: PendingMuteOp) => void;
  /** Drop one queue entry; identity-preserving no-op when absent. */
  clearPendingMuteOp: (targetId: string) => void;
  /** Drop many queue entries in one set() — the drain's batched clear. */
  clearPendingMuteOps: (targetIds: string[]) => void;
  /** Increment a queue entry's failed-drain counter; no-op when absent. */
  bumpPendingMuteAttempts: (targetId: string) => void;
  /**
   * Reset prefs to all-true and clear mutes and the pending queue — called
   * from localWipe.
   *
   * Also clears `pushOptOut` (#683): master-push intent is ACCOUNT-scoped, so
   * it must not be inherited across a logout. `pushPermissionGranted`/
   * `pushToken` are deliberately left alone — they are DEVICE-scoped OS state,
   * re-derived at the next registration attempt.
   */
  resetNotificationSettings: () => void;
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
