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
// Generic wrappers
// ============================================================

export interface PaginatedResponse<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
  total?: number;
}

// ============================================================
// Auth
// ============================================================

export interface SignupRequest {
  username: string;
  password: string;
  email: string;
  inviteCode: string;
  /** Client-generated public key material for initial Signal key registration */
  publicKey?: string;
}

export interface SignupResponse {
  userId: string;
  username: string;
  token: string;
  refreshToken?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  refreshToken?: string;
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface VerifyTokenResponse {
  valid: boolean;
  userId: string;
  username: string;
}

export interface PublicKeyResponse {
  username: string;
  /** Base64-encoded public key */
  publicKey: string;
}

// ============================================================
// Groups / Orbits
// ============================================================

export interface CreateGroupRequest {
  /** Ciphertext of the group name, encrypted with the creator's key */
  encryptedName: string;
  encryptedNameIv: string;
}

export interface GroupResponse {
  groupId: string;
  encryptedName: string;
  encryptedGroupKey: string;
  memberCount: number;
  maxMembers: number;
  isCreator: boolean;
  activeInviteCode: string | null;
  joinedAt: string;
}

export interface JoinGroupRequest {
  inviteCode: string;
}

export interface JoinGroupResponse {
  group: GroupResponse;
}

export interface GroupMember {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: 'creator' | 'member';
  joinedAt: string;
}

export interface GroupMembersResponse {
  members: GroupMember[];
}

export interface ListGroupsResponse {
  groups: GroupResponse[];
}

export interface GroupKeyResponse {
  /** Per-member copy of the group key, encrypted with the member's public key */
  encryptedGroupKey: string;
  /** Key ID for rotation tracking */
  keyId: string;
  createdAt: string;
}

export interface GroupQuotaResponse {
  used: number;
  limit: number;
  unit: 'bytes';
}

export interface CreateDmRequest {
  targetUserId: string;
}

export interface DmResponse {
  id: string;
  type: 'direct';
  participantIds: string[];
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Threads
// ============================================================

export interface CreateThreadRequest {
  groupId: string;
  encryptedTitle: string;
  titleIv: string;
  encryptedBody: string;
  bodyIv: string;
}

export interface CreateThreadResponse {
  threadId: string;
  groupId: string;
  createdAt: string;
  media: string[];
}

export interface ThreadResponse {
  threadId: string;
  groupId: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName: string | null;
  encryptedTitle: string | null;
  titleIv: string | null;
  encryptedBody: string | null;
  bodyIv: string | null;
  replyCount: number;
  createdAt: string;
  media: string[];
}

export interface GetGroupThreadsRequest {
  cursor?: string;
  limit?: number;
  sort?: 'latest' | 'top' | 'new';
}

export interface CreateReplyRequest {
  /** Client-generated UUID — allows offline creation before sync */
  id?: string;
  /** AES-GCM ciphertext of the reply body */
  encryptedBody: string;
  /** IV used to encrypt the body */
  bodyIv: string;
  /** Parent reply ID for nested replies (null = top-level reply) */
  parentReplyId: string | null;
}

export interface ReplyResponse {
  id: string;
  threadId: string;
  authorId: string;
  authorUsername: string;
  /** Encrypted reply body ciphertext */
  encryptedBody: string;
  bodyIv: string;
  parentReplyId: string | null;
  depth: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Signal Protocol Relay
// ============================================================

export interface SendMessageRequest {
  /** Destination service ID (UUID) */
  destinationServiceId: string;
  destinationDeviceId: number;
  /** Signal Protocol serialised encrypted envelope, base64-encoded */
  encryptedEnvelope: string;
  /** Envelope type for Signal Protocol processing (1=ciphertext, 3=prekey) */
  envelopeType: number;
  timestamp: number;
}

export interface SendMessageResponse {
  id: string;
  timestamp: number;
}

export interface MessageEnvelope {
  id: string;
  sourceServiceId: string;
  sourceDeviceId: number;
  destinationServiceId: string;
  /** Base64-encoded Signal Protocol encrypted envelope */
  encryptedEnvelope: string;
  envelopeType: number;
  serverTimestamp: number;
}

export interface FetchMessagesRequest {
  since?: number;
  limit?: number;
}

export interface FetchMessagesResponse {
  messages: MessageEnvelope[];
  more: boolean;
}

// ============================================================
// Media
// ============================================================

export interface UploadChunkRequest {
  /** Opaque upload session ID (returned by server on first chunk) */
  uploadId?: string;
  chunkIndex: number;
  totalChunks: number;
  /** AES-256-CBC encrypted media chunk, base64 */
  encryptedChunk: string;
  /** HMAC-SHA256 authentication tag for this chunk */
  hmac: string;
  /** Present on first chunk only — encrypted JSON blob containing filename, type, dimensions */
  encryptedMetadata?: string;
}

export interface UploadChunkResponse {
  uploadId: string;
  received: number;
  complete: boolean;
  mediaId?: string;
}

export interface MediaDownloadResponse {
  /** Raw encrypted media bytes returned as ArrayBuffer */
  data: ArrayBuffer;
}

// ============================================================
// Users
// ============================================================

export interface UserProfile {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface UpdateDisplayNameRequest {
  /** 1–15 characters */
  displayName: string;
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
// Invites
// ============================================================

export interface GenerateInviteRequest {
  email: string;
  groupId?: string;
}

export interface InviteResponse {
  code: string;
  email: string;
  groupId: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface GenerateInviteLinkRequest {
  inviteCode: string;
}

export interface InviteLinkResponse {
  /** Deep link in the form orbital://invite/CODE */
  link: string;
  inviteCode: string;
  expiresAt: string;
}

export interface InviteStatusResponse {
  code: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  email: string;
  acceptedAt: string | null;
  expiresAt: string;
}

// ============================================================
// Devices (push notifications)
// ============================================================

export interface RegisterDeviceRequest {
  platform: 'ios' | 'android';
  /** APNs device token (iOS) or FCM registration token (Android) */
  pushToken: string;
}

export interface RegisterDeviceResponse {
  deviceId: string;
  platform: 'ios' | 'android';
  registeredAt: string;
}

// ============================================================
// Version check
// ============================================================

export interface VersionCheckResponse {
  updateRequired: boolean;
  latestVersion: string;
  /** Optional deep link to the app store */
  updateUrl?: string;
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

export interface PreKeyCountResponse {
  count: number;
}

export interface PreKeyBundleResponse {
  registrationId: number;
  deviceId: number;
  identityKey: string;
  signedPreKey: {
    keyId: number;
    publicKey: string;
    signature: string;
  };
  preKey: {
    keyId: number;
    publicKey: string;
  } | null;
  kyberPreKey: {
    keyId: number;
    publicKey: string;
    signature: string;
  } | null;
}
