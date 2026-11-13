/**
 * TypeScript interfaces for all 15 Orbital-Mobile database tables.
 *
 * Conventions:
 * - `Uint8Array` for BLOB columns (key material, encrypted content, protobuf records)
 * - Enums for constrained integer values
 * - String unions for status/type columns
 * - All timestamps are Unix epoch seconds (number)
 * - JSDoc notes desktop column equivalents where they differ
 *
 * ## One deliberate type-only edge (#921)
 *
 * The Meta import rows below `import type` `ImportSource`, `SkipReason` and
 * `IdKind` from `services/metaImport/types.ts`. That module imports NOTHING —
 * it is a contract leaf by construction — and the alternative was re-declaring
 * the same unions here, where a new `SkipReason` would silently diverge. This
 * is NOT a licence for `src/types` → `src/services` edges in general: any
 * other such import drags the service graph into the type layer. `archive_bookmark`
 * in particular is typed `string | null` and never imports `ArchivePartToken`
 * (security invariant 29a's single-importer rule).
 */

import type { ImportSource, SkipReason, IdKind } from '../services/metaImport/types';

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
// Orbital App Table Rows (4)
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
  /** Unix epoch MILLISECONDS (conversationRepository stamps Date.now()) */
  created_at: number;
  /** Unix epoch MILLISECONDS (conversationRepository stamps Date.now()) */
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
  /**
   * Unix epoch MILLISECONDS since #844. Rows written before that hold epoch
   * seconds; threadRepository.mapRowToThread reads either
   * (timestampUnits.toMillis).
   */
  last_reply_at: number | null;
  /**
   * Unix epoch MILLISECONDS since #844. Rows written before that hold epoch
   * seconds; threadRepository.mapRowToThread reads either
   * (timestampUnits.toMillis).
   */
  created_at: number;
  /**
   * Unix epoch MILLISECONDS since #844. Rows written before that hold epoch
   * seconds; threadRepository.mapRowToThread reads either
   * (timestampUnits.toMillis).
   */
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
  /**
   * Unix epoch MILLISECONDS since #821. Rows written before that hold epoch
   * seconds; replyRepository.mapRowToReply reads either (timestampUnits.toMillis).
   */
  created_at: number;
  /** Unix epoch MILLISECONDS since #821 — see created_at. */
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
  /**
   * Unix epoch MILLISECONDS — not seconds, despite the file header. Every
   * writer stamps Date.now() (mediaUploadService's buildMediaRow,
   * threadService's two thumbnail materializers), and the #724c orphan reaper
   * binds a Date.now() offset against it.
   */
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

// ============================================================
// Meta Import Table Rows (3) — migration 009 (#921)
// ============================================================

/**
 * `import_jobs.status`.
 *
 * There is NO `paused` status: pause is in-process runtime state only, and a
 * job found in a non-terminal status at launch is resumed (or deleted) by the
 * #926 runner. `parsing` at launch means a torn parse.
 */
export type ImportJobStatus =
  'parsing' | 'ready' | 'in_progress' | 'completed' | 'cancelled' | 'failed';

/** `import_items.status` — the six states one parsed post moves through. */
export type ImportItemStatus =
  'pending' | 'uploading' | 'created' | 'duplicate' | 'failed' | 'skipped';

/** `import_item_media.upload_state` — a request-saving cache, not a source of truth. */
export type ImportMediaUploadState = 'pending' | 'uploaded';

/**
 * import_jobs row — one Meta archive import run (#921).
 */
export interface ImportJobRow {
  id: string;
  /** The orbit this import posts into. No FK (003/004 precedent). */
  conversation_id: string;
  source: ImportSource;
  status: ImportJobStatus;
  /** Server `import_id`. NULL until the run starts. */
  session_id: string | null;
  /**
   * `ImportKeySession.keyFingerprint` — the key generation AND account stamp.
   * LOCAL ONLY: never logged, never in a breadcrumb or error message, never
   * sent to the server.
   */
  key_fingerprint: string;
  /** NULL until parsed; excludes held items. */
  declared_posts: number | null;
  /** NULL until parsed; excludes held items. */
  declared_bytes: number | null;
  /** The stored home of SkipReason `duplicate_in_archive`. */
  dropped_duplicates: number;
  /**
   * `JSON.stringify(ArchiveSession.parts)` — a CAPABILITY HANDLE, never
   * logged. Typed as the stored JSON string, deliberately NOT
   * `ArchivePartToken[]`: the token type has a single importer
   * (`metaImport/archiveAccess`), and nothing may parse a token's interior.
   * NULLed when the job reaches a terminal status.
   */
  archive_bookmark: string | null;
  /** Unix epoch MILLISECONDS */
  created_at: number;
  /** Unix epoch MILLISECONDS */
  updated_at: number;
}

/**
 * import_items row — one parsed post, importable or skipped (#921).
 *
 * There is deliberately no `sourceItemId` field: the v1 identity frame is
 * plaintext-class and is never persisted (see migration 009's header).
 */
export interface ImportItemRow {
  id: string;
  job_id: string;
  /** 0-based parse order within the job. Gaps from dropped duplicates are fine. */
  ordinal: number;
  /** 16 bytes (#924). NULL for exactly the three pre-frame skips. */
  import_key: Uint8Array | null;
  status: ImportItemStatus;
  /** NULL unless the item is `skipped`. */
  skip_reason: SkipReason | null;
  /** Unix epoch MILLISECONDS UTC */
  original_date: number | null;
  /**
   * PLAINTEXT-CLASS post body (same posture as `orbital_threads.body`:
   * plaintext inside SQLCipher). NULL for skips, and NULLed once the item
   * reaches `created`/`duplicate`. Never logged, thrown or sent to telemetry.
   */
  body: string | null;
  /** Post-JSON basename. LOCAL UI ONLY (F18). */
  source_file: string | null;
  source_index: number | null;
  /** The `kind` byte of the v1 frame: 1 content frame, 2 Instagram fbid. */
  id_kind: IdKind | null;
  /** Server thread id, once the item is `created`/`duplicate`. */
  thread_id: string | null;
  /** Server reason code, once the item is `failed`. */
  error_code: string | null;
}

/** import_item_media row — one media attachment of a parsed post (#921). */
export interface ImportItemMediaRow {
  item_id: string;
  /** Display order within the post. Composite PK part 2. */
  ordinal: number;
  /** Lowercase UUIDv4 (`generateUUID`), stable across retries. */
  media_id: string;
  /** Opaque archive entry id — never parsed, split or truncated. */
  entry_id: string;
  /** Unix epoch MILLISECONDS UTC */
  original_date: number | null;
  upload_state: ImportMediaUploadState;
}
