/**
 * Wire-format DTOs for the Orbital backend REST API.
 *
 * SECURITY: All content fields in these types are CIPHERTEXT — never plaintext.
 * Field names like `encryptedTitle`, `encryptedBody`, `titleIv`, etc. reflect
 * the encrypted bytes sent to/from the server. Decryption happens in the
 * service layer before values reach the UI or Zustand stores.
 *
 * Property names use camelCase throughout — the API client automatically
 * transforms server snake_case to camelCase on response, and camelCase to
 * snake_case on request bodies.
 */

// ============================================================
// Auth
// ============================================================

export interface SignupRequest {
  username: string;
  password: string;
  email: string;
  inviteCode: string;
  /**
   * Client-generated public key material for initial Signal key registration.
   * Backend requires this as a JWK object (JSON), NOT a string.
   * Validated server-side: `typeof public_key !== 'object'` → 400.
   */
  // TODO: Make required once signup flow sends the JWK public key.
  // Backend requires it (400 if missing) but mobile generates keys post-signup.
  publicKey?: Record<string, unknown>;
}

/**
 * POST /api/signup response.
 *
 * Backend returns: { user_id, username, email, token, groupId }
 * Note: groupId is already camelCase in the backend response (not snake_case).
 */
export interface SignupResponse {
  userId: string;
  username: string;
  email: string;
  token: string;
  groupId: string | null;
}

export interface LoginRequest {
  username: string;
  password: string;
}

/**
 * POST /api/login response.
 *
 * Backend returns: { user_id, username, public_key, token }
 */
export interface LoginResponse {
  userId: string;
  username: string;
  publicKey: unknown;
  token: string;
}

/**
 * POST /api/verify-token response.
 *
 * Backend PR-B1 changes verify-token to use `authenticate` middleware.
 * A 200 means the token is valid; no `valid` boolean is needed.
 * Note: until PR-B1 ships, the backend still returns `valid: true` alongside
 * these fields — the extra field is harmless (TS ignores surplus properties).
 */
export interface VerifyTokenResponse {
  userId: string;
  username: string;
}

/**
 * GET /api/users/:username/public-key response.
 *
 * Backend returns: { user_id, username, public_key }
 */
export interface PublicKeyResponse {
  userId: string;
  username: string;
  publicKey: unknown;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ForgotPasswordResponse {
  message: string;
}

export interface ResetPasswordWithCodeRequest {
  email: string;
  code: string;
  newPassword: string;
}

export interface ResetPasswordWithCodeResponse {
  success: boolean;
}

// ============================================================
// Groups / Orbits
// ============================================================

/**
 * POST /api/groups request.
 *
 * Backend expects: { encrypted_name, wrapped_group_key }
 */
export interface CreateGroupRequest {
  groupId?: string;
  encryptedName: string;
  wrappedGroupKey: string;
}

/**
 * POST /api/groups response.
 *
 * Backend returns: { group_id, invite_code, expires_at, created_at }
 */
export interface CreateGroupResponse {
  groupId: string;
  inviteCode: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * GET /api/groups response item (from getUserGroups).
 *
 * Backend returns per group:
 * { group_id, encrypted_name, wrapped_group_key, member_count,
 *   max_members, is_creator, active_invite_code, joined_at }
 */
export interface GroupResponse {
  groupId: string;
  encryptedName: string | null;
  wrappedGroupKey: string | null;
  wrappedBy: string | null;
  memberCount: number;
  maxMembers: number;
  isCreator: boolean;
  activeInviteCode: string | null;
  joinedAt: string;
}

/**
 * POST /api/groups/join request.
 *
 * Backend expects: { invite_code }
 */
export interface JoinGroupRequest {
  inviteCode: string;
}

/**
 * POST /api/groups/join response.
 *
 * Backend returns: { group_id, encrypted_name, member_count, joined_at, wrapped_group_key }
 */
export interface JoinGroupResponse {
  groupId: string;
  encryptedName: string | null;
  memberCount: number;
  joinedAt: string;
  wrappedGroupKey: string | null;
  wrappedBy?: string | null;
}

/**
 * Member object from GET /api/groups/:groupId/members.
 *
 * Backend returns: { user_id, username, public_key, avatar_url, display_name, joined_at }
 * Note: no 'role' field — creator status is determined via group.created_by.
 */
export interface GroupMember {
  userId: string;
  username: string;
  displayName: string;
  publicKey: string;
  avatarUrl: string | null;
  joinedAt: string;
}

export interface GroupMembersResponse {
  members: GroupMember[];
}

export interface GenerateInviteCodeResponse {
  inviteCode: string;
  expiresAt: string;
  createdAt: string;
  targetEmail: string;
}

/**
 * GET /api/groups/:groupId/key response.
 *
 * Backend returns: { wrapped_group_key }
 */
export interface GroupKeyResponse {
  wrappedGroupKey: string | null;
  wrappedBy: string | null;
}

/**
 * GET /api/groups/:groupId/pending-wraps response.
 */
export interface PendingWrapsResponse {
  pending: Array<{ userId: string; identityPublicKey: string }>;
}

/**
 * GET /api/groups/:groupId/quota response.
 *
 * Backend returns: { group_id, storage: { used, limit, percentage, warning },
 *   files: { count, limit, percentage, warning } }
 */
export interface GroupQuotaResponse {
  groupId: string;
  storage: {
    used: number;
    limit: number;
    percentage: number;
    warning: boolean;
  };
  files: {
    count: number;
    limit: number;
    percentage: number;
    warning: boolean;
  };
}

/**
 * POST /api/groups/dm request.
 *
 * Backend expects: { recipient_id, wrapped_group_key, recipient_wrapped_group_key? }
 */
export interface CreateDmRequest {
  groupId?: string;
  recipientId: string;
  wrappedGroupKey: string;
  recipientWrappedGroupKey?: string | null;
}

/**
 * POST /api/groups/dm response.
 *
 * Backend returns: { group_id, is_new, wrapped_group_key, recipient: { id, username } }
 */
export interface CreateDmResponse {
  groupId: string;
  isNew: boolean;
  wrappedGroupKey: string | null;
  wrappedBy: string | null;
  recipient: {
    id: string;
    username: string;
  };
}

/**
 * GET /api/groups/dms response item (from getDMGroups).
 *
 * Backend returns per DM:
 * { group_id, recipient: { id, username, avatar_url }, wrapped_group_key,
 *   last_message_at, created_at }
 */
export interface DmResponse {
  groupId: string;
  recipient: {
    id: string;
    username: string;
    avatarUrl: string | null;
  };
  wrappedGroupKey: string | null;
  wrappedBy: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

// ============================================================
// Threads
// ============================================================

/**
 * POST /api/threads request.
 *
 * Backend expects: { thread_id?, group_id, encrypted_title, encrypted_body,
 *   title_iv?, body_iv?, root_message_id?, media_ids? }
 */
export interface CreateThreadRequest {
  threadId?: string;
  groupId: string;
  encryptedTitle: string;
  titleIv?: string | null;
  encryptedBody: string | null;
  bodyIv?: string | null;
  rootMessageId?: string | null;
  mediaIds?: string[];
}

/**
 * POST /api/threads response.
 *
 * Backend returns: { thread_id, group_id, created_at, media }
 */
export interface CreateThreadResponse {
  threadId: string;
  groupId: string;
  createdAt: string;
  media: MediaMetadata[];
}

/**
 * GET /api/threads/:threadId response.
 *
 * Backend returns: { thread_id, group_id, author_id, author_username,
 *   author_display_name, encrypted_title, encrypted_body, title_iv, body_iv,
 *   reply_count, created_at, media }
 */
export interface ThreadResponse {
  threadId: string;
  groupId: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string;
  encryptedTitle: string | null;
  titleIv: string | null;
  encryptedBody: string | null;
  bodyIv: string | null;
  replyCount: number;
  createdAt: string;
  media: MediaMetadata[];
}

/**
 * Thread item in the GET /api/groups/:groupId/threads list response.
 *
 * Note: list items include media_count (not the full media array).
 */
export interface ThreadListItem {
  threadId: string;
  groupId: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string;
  encryptedTitle: string | null;
  encryptedBody: string | null;
  titleIv: string | null;
  bodyIv: string | null;
  replyCount: number;
  mediaCount: number;
  createdAt: string;
}

/**
 * GET /api/groups/:groupId/threads response.
 *
 * Backend returns: { threads, total_count, has_more }
 * Uses offset pagination (limit + offset query params).
 */
export interface ListThreadsResponse {
  threads: ThreadListItem[];
  totalCount: number;
  hasMore: boolean;
}

/**
 * Query params for GET /api/groups/:groupId/threads.
 *
 * Backend accepts: { limit, offset, sort }
 */
export interface GetGroupThreadsRequest {
  limit?: number;
  offset?: number;
  sort?: 'created_asc' | 'created_desc';
}

/**
 * POST /api/threads/:threadId/replies request.
 *
 * Backend expects: { encrypted_body, body_iv?, message_id?, media_ids?, parent_reply_id? }
 *
 * Note: the backend does NOT accept a client-provided reply id — reply UUIDs are
 * always server-generated.
 */
export interface CreateReplyRequest {
  encryptedBody: string;
  bodyIv?: string | null;
  messageId?: string | null;
  mediaIds?: string[];
  parentReplyId?: string | null;
}

/**
 * POST /api/threads/:threadId/replies response.
 *
 * Backend returns: { reply_id, thread_id, created_at, media }
 */
export interface CreateReplyResponse {
  replyId: string;
  threadId: string;
  createdAt: string;
  media: MediaMetadata[];
}

/**
 * Reply item from GET /api/threads/:threadId/replies.
 *
 * Backend returns per reply: { reply_id, thread_id, author_id, author_username,
 *   author_display_name, encrypted_body, body_iv, created_at, parent_reply_id,
 *   level, media }
 */
export interface ReplyResponse {
  replyId: string;
  threadId: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string;
  encryptedBody: string;
  bodyIv: string | null;
  parentReplyId: string | null;
  level: number;
  createdAt: string;
  media: MediaMetadata[];
}

/**
 * GET /api/threads/:threadId/replies response.
 *
 * Backend returns: { replies, media (thread-level), total_count, has_more }
 * Uses offset pagination (limit + offset query params).
 */
export interface ListRepliesResponse {
  replies: ReplyResponse[];
  media: MediaMetadata[];
  totalCount: number;
  hasMore: boolean;
}

// ============================================================
// Media
// ============================================================

/**
 * Media metadata object returned inline with threads and replies.
 */
export interface MediaMetadata {
  mediaId: string;
  encryptedMetadata: string | null;
  sizeBytes: number;
  uploadedAt: string;
  expiresAt: string | null;
  contentType: string | undefined;
  fileName: string | undefined;
  blurHash: string | undefined;
  width: number | undefined;
  height: number | undefined;
  duration: number | undefined;
}

/**
 * POST /api/media/upload/chunk response.
 *
 * Backend returns (media.js:249-256): { media_id, chunk_index,
 *   chunks_received, total_chunks, progress, complete }
 */
export interface UploadChunkResponse {
  mediaId: string;
  chunkIndex: number;
  chunksReceived: number;
  totalChunks: number;
  progress: string;
  complete: boolean;
}

// ============================================================
// Users
// ============================================================

/**
 * User profile from GET /api/users/me or GET /api/users/:userId.
 *
 * displayName falls back to username server-side if not set.
 */
export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt?: string;
}

export interface UpdateDisplayNameResponse {
  displayName: string;
  updatedAt: string;
}

export interface UploadAvatarResponse {
  avatarUrl: string;
  updatedAt: string;
}

// ============================================================
// Devices (push notifications)
// ============================================================

export interface RegisterDeviceRequest {
  platform: 'ios' | 'android';
  pushToken: string;
  deviceId: string;
}

export interface RegisterDeviceResponse {
  deviceId: string;
  platform: 'ios' | 'android';
  registeredAt: string;
}

// ============================================================
// Signal Keys
// ============================================================

export interface PreKeyPublicUpload {
  keyId: number;
  publicKey: string;
}

export interface SignedPreKeyPublicUpload {
  keyId: number;
  publicKey: string;
  signature: string;
}

export interface KyberPreKeyPublicUpload {
  keyId: number;
  publicKey: string;
  signature: string;
  lastResort?: boolean;
}

export interface UploadPreKeyBundleRequest {
  registrationId: number;
  deviceId: number;
  identityKey: string;
  signedPreKey: SignedPreKeyPublicUpload;
  preKeys: PreKeyPublicUpload[];
  kyberPreKeys: KyberPreKeyPublicUpload[];
  lastResortKyberPreKey: KyberPreKeyPublicUpload;
}

export interface UploadPreKeyBundleResponse {
  success: boolean;
}

/** GET /v1/keys/bundle/:userId -- returns identity key only for ECIES wrapping. */
export interface IdentityKeyResponse {
  identityKey: string;
}

export interface PreKeyCountResponse {
  count: number;
}
