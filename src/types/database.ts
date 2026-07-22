/**
 * TypeScript interfaces for all 17 Orbital-Mobile database tables.
 *
 * Conventions:
 * - `Uint8Array` for BLOB columns (key material, encrypted content, protobuf records)
 * - Enums for constrained integer values
 * - String unions for status/type columns
 * - All timestamps are Unix epoch seconds (number)
 * - JSDoc notes desktop column equivalents where they differ
 */

// ============================================================
// Enums
// ============================================================

/** Maps to signal_identity_keys.verified (INTEGER) */
export enum VerifiedStatus {
  Default = 0,
  Verified = 1,
  Unverified = 2,
}

// ============================================================
// Signal Protocol Store Rows (6)
// ============================================================

/**
 * signal_identity_keys row.
 * Own key pair stored at address='local'; remote identity keys at address=serviceId.
 *
 * Desktop equivalent: identityKeys table (uses composite PK `ourServiceId:serviceId`).
 */
export interface SignalIdentityKeyRow {
  address: string;
  /** 33-byte public key, or 64-byte key pair for address='local' */
  identity_key: Uint8Array;
  verified: VerifiedStatus;
  /** Unix epoch seconds — when key was first seen */
  first_use: number;
  /** 1 = approved without blocking */
  nonblocking_approval: number;
}

/**
 * signal_sessions row.
 * Desktop PK: composite string `ourServiceId:serviceId:deviceId`.
 * Reconstruct: `our_service_id + ':' + service_id + ':' + device_id`
 */
export interface SignalSessionRow {
  our_service_id: string;
  service_id: string;
  device_id: number;
  /** Protobuf session record — same binary format as desktop v1220+ */
  record: Uint8Array;
  version: number;
}

/** signal_pre_keys row — one-time pre-keys for X3DH. */
export interface SignalPreKeyRow {
  id: number;
  /** Serialized pre-key pair */
  key_data: Uint8Array;
  /** Unix epoch seconds */
  created_at: number;
}

/** signal_signed_pre_keys row — signed pre-keys (30-day rotation). */
export interface SignalSignedPreKeyRow {
  id: number;
  /** Serialized signed pre-key pair */
  key_data: Uint8Array;
  /** Unix epoch seconds */
  created_at: number;
  /** 1 = confirmed by server */
  confirmed: number;
}

/** signal_kyber_pre_keys row — post-quantum pre-keys. */
export interface SignalKyberPreKeyRow {
  id: number;
  /** Serialized Kyber key pair */
  key_data: Uint8Array;
  /** 1 = last resort key (not deleted after use) */
  is_last_resort: number;
  /** Unix epoch seconds */
  created_at: number;
}

/**
 * signal_sender_keys row — group messaging sender keys.
 * Desktop PK: composite string `ourServiceId:senderId:distributionId`.
 * Reconstruct: `our_service_id + ':' + sender_id + ':' + distribution_id`
 */
export interface SignalSenderKeyRow {
  our_service_id: string;
  sender_id: string;
  distribution_id: string;
  /** Serialized sender key state */
  record: Uint8Array;
  /** Unix epoch seconds */
  created_at: number;
}

// ============================================================
// Orbital App Table Rows (6)
// ============================================================

export type ConversationType = 'group' | 'direct';

export interface ConversationRow {
  id: string;
  type: ConversationType;
  name: string | null;
  avatar_path: string | null;
  /** 32-byte group master key */
  group_master_key: Uint8Array | null;
  group_secret_params: Uint8Array | null;
  group_public_params: Uint8Array | null;
  group_version: number;
  member_count: number;
  /** 1 = active, 0 = archived/left */
  active: number;
  /** Unix epoch seconds, null = not muted */
  mute_until: number | null;
  /** Unix epoch seconds */
  last_message_at: number | null;
  unread_count: number;
  /** Unix epoch seconds */
  created_at: number;
  /** Unix epoch seconds */
  updated_at: number;
}

export type ThreadContentType = 'text' | 'media' | 'link';

export interface OrbitalThreadRow {
  id: string;
  conversation_id: string;
  author_id: string;
  title_encrypted: Uint8Array | null;
  /** 12-byte IV (AES-256-GCM nonce) */
  title_iv: Uint8Array | null;
  body_encrypted: Uint8Array | null;
  /** 12-byte IV (AES-256-GCM nonce) */
  body_iv: Uint8Array | null;
  content_type: ThreadContentType;
  pinned: number;
  reply_count: number;
  /** Unix epoch seconds */
  last_reply_at: number | null;
  /** Unix epoch seconds */
  created_at: number;
  /** Unix epoch seconds */
  updated_at: number;
}

export interface OrbitalReplyRow {
  id: string;
  thread_id: string;
  author_id: string;
  body_encrypted: Uint8Array | null;
  /** 12-byte IV (AES-256-GCM nonce) */
  body_iv: Uint8Array | null;
  /** Null for top-level replies */
  parent_reply_id: string | null;
  /** Unix epoch seconds */
  created_at: number;
  /** Unix epoch seconds */
  updated_at: number;
}

export type DownloadState = 'pending' | 'downloading' | 'downloaded' | 'failed' | 'unavailable';
export type UploadState = 'pending' | 'uploading' | 'done' | 'failed';

/**
 * orbital_media row.
 * Desktop stores attachment_key as base64 TEXT; mobile stores as 64-byte BLOB.
 * Convert at API boundary.
 */
export interface OrbitalMediaRow {
  id: string;
  thread_id: string | null;
  reply_id: string | null;
  message_id: string | null;
  /** MIME type */
  content_type: string;
  file_name: string | null;
  /** Bytes */
  file_size: number | null;
  /** Pixels */
  width: number | null;
  /** Pixels */
  height: number | null;
  /** Milliseconds (for audio/video) */
  duration: number | null;
  /** 64-byte attachment key — desktop uses base64 TEXT */
  attachment_key: Uint8Array | null;
  /** SHA-256 digest */
  attachment_digest: Uint8Array | null;
  cdn_number: number | null;
  cdn_key: string | null;
  local_path: string | null;
  thumbnail_path: string | null;
  download_state: DownloadState;
  upload_state: UploadState;
  /** Unix epoch seconds */
  created_at: number;
}

// ============================================================
// Messaging Table Rows (2)
// ============================================================

export type MessageType = 'message' | 'thread_update' | 'reaction' | 'system';

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  type: MessageType;
  body_encrypted: Uint8Array | null;
  body_iv: Uint8Array | null;
  /** Unix epoch seconds — from server */
  server_timestamp: number;
  /** Unix epoch seconds — local receipt time */
  received_at: number;
  /** 1 = read */
  read: number;
  /** Unix epoch seconds, null if no expiration */
  expires_at: number | null;
}

export interface MessageAttachmentRow {
  message_id: string;
  /** 0-based index within message */
  attachment_index: number;
  media_id: string | null;
  /** MIME type */
  content_type: string;
  file_name: string | null;
  /** Bytes */
  file_size: number | null;
}

// ============================================================
// Infrastructure Table Rows (3 + drafts)
// ============================================================

/**
 * items row — key-value store for app state.
 * Desktop equivalent: items table.
 * Value is JSON-encoded (matches desktop pattern for this table).
 */
export interface ItemRow {
  id: string;
  /** JSON-encoded value */
  value: string;
}

/**
 * unprocessed row — incoming envelope queue.
 * Desktop equivalent: unprocessed table.
 */
export interface UnprocessedRow {
  id: string;
  /** Raw protobuf envelope */
  envelope: Uint8Array;
  /** Unix epoch seconds */
  server_timestamp: number;
  source_service_id: string | null;
  source_device: number | null;
  attempts: number;
  /** Unix epoch seconds */
  received_at: number;
  /** 1 = process immediately */
  urgent: number;
}

export type SyncTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface SyncTaskRow {
  id: string;
  /** Sync type (e.g., 'keys', 'contacts', 'groups') */
  type: string;
  /** JSON task payload */
  data: string | null;
  status: SyncTaskStatus;
  attempts: number;
  /** Unix epoch seconds */
  last_attempt_at: number | null;
  /** Unix epoch seconds */
  created_at: number;
}

export type DraftContextType = 'conversation' | 'thread' | 'reply';

export interface DraftRow {
  context_id: string;
  context_type: DraftContextType;
  /** Draft text (plaintext; encrypted at rest by SQLCipher) */
  body: string | null;
  /** Unix epoch seconds */
  updated_at: number;
}
