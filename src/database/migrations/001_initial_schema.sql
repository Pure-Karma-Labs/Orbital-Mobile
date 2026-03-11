-- Migration 001: Initial Schema
-- Orbital-Mobile database schema (17 tables)
-- Compatible with Orbital-Desktop migration baseline v1513
--
-- Design:
--   - Normalized columns (no JSON blobs)
--   - Explicit typed columns instead of composite string PKs
--   - BLOB for all key material (SQLCipher encrypts entire DB)
--   - All timestamps: Unix epoch seconds (INTEGER)
--   - WAL mode set at connection time, not in migration

-- ============================================================
-- Signal Protocol Stores (6 tables)
-- ============================================================

-- Identity keys: own key pair (address='local') + remote identity keys
-- Desktop equivalent: signalapp/Signal-Desktop identityKeys table
-- Desktop PK: composite string `ourServiceId:serviceId`
CREATE TABLE signal_identity_keys (
  address       TEXT    NOT NULL,  -- 'local' for own key pair, or remote serviceId (UUID)
  identity_key  BLOB    NOT NULL,  -- 33-byte Curve25519 public key (or 64-byte key pair for 'local')
  verified      INTEGER NOT NULL DEFAULT 0,  -- 0=default, 1=verified, 2=unverified
  first_use     INTEGER NOT NULL DEFAULT 0,  -- Unix epoch seconds, when key was first seen
  nonblocking_approval INTEGER NOT NULL DEFAULT 0,  -- 1=approved without blocking
  PRIMARY KEY (address)
);

-- Sessions: Double Ratchet session state
-- Desktop PK: composite string `ourServiceId:serviceId:deviceId`
-- Reconstruct desktop key: our_service_id || ':' || service_id || ':' || device_id
CREATE TABLE signal_sessions (
  our_service_id TEXT    NOT NULL,  -- our UUID
  service_id     TEXT    NOT NULL,  -- remote party UUID
  device_id      INTEGER NOT NULL,  -- remote device ID
  record         BLOB    NOT NULL,  -- protobuf session record (same format as desktop v1220+)
  version        INTEGER NOT NULL DEFAULT 2,  -- session version
  PRIMARY KEY (our_service_id, service_id, device_id)
);

CREATE INDEX idx_sessions_service ON signal_sessions (service_id);

-- One-time pre-keys for X3DH key exchange
CREATE TABLE signal_pre_keys (
  id         INTEGER NOT NULL,
  key_data   BLOB    NOT NULL,  -- serialized pre-key pair
  created_at INTEGER NOT NULL,  -- Unix epoch seconds
  PRIMARY KEY (id)
);

-- Signed pre-keys (30-day rotation)
CREATE TABLE signal_signed_pre_keys (
  id           INTEGER NOT NULL,
  key_data     BLOB    NOT NULL,  -- serialized signed pre-key pair
  created_at   INTEGER NOT NULL,  -- Unix epoch seconds
  confirmed    INTEGER NOT NULL DEFAULT 0,  -- 1=confirmed by server
  PRIMARY KEY (id)
);

-- Post-quantum (Kyber) pre-keys
CREATE TABLE signal_kyber_pre_keys (
  id           INTEGER NOT NULL,
  key_data     BLOB    NOT NULL,  -- serialized Kyber key pair
  is_last_resort INTEGER NOT NULL DEFAULT 0,  -- 1=last resort key (not deleted after use)
  created_at   INTEGER NOT NULL,  -- Unix epoch seconds
  PRIMARY KEY (id)
);

-- Sender keys for group messaging (Sealed Sender v2)
-- Desktop PK: composite string `ourServiceId:senderId:distributionId`
-- Reconstruct desktop key: our_service_id || ':' || sender_id || ':' || distribution_id
CREATE TABLE signal_sender_keys (
  our_service_id  TEXT NOT NULL,  -- our UUID
  sender_id       TEXT NOT NULL,  -- sender's UUID
  distribution_id TEXT NOT NULL,  -- distribution UUID for this group
  record          BLOB NOT NULL,  -- serialized sender key state
  created_at      INTEGER NOT NULL,  -- Unix epoch seconds
  PRIMARY KEY (our_service_id, sender_id, distribution_id)
);

-- ============================================================
-- Orbital App Tables (6 tables)
-- ============================================================

-- Conversations: groups and DM metadata
CREATE TABLE conversations (
  id                TEXT    NOT NULL,  -- UUID
  type              TEXT    NOT NULL DEFAULT 'group',  -- 'group' | 'direct'
  name              TEXT,              -- plaintext group name (encrypted at rest by SQLCipher)
  avatar_path       TEXT,              -- local file path to avatar
  group_master_key  BLOB,             -- group master key (32 bytes)
  group_secret_params BLOB,           -- group secret params
  group_public_params BLOB,           -- group public params
  group_version     INTEGER NOT NULL DEFAULT 2,
  member_count      INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,  -- 1=active, 0=archived/left
  mute_until        INTEGER,          -- Unix epoch seconds, NULL=not muted
  last_message_at   INTEGER,          -- Unix epoch seconds, for sort order
  unread_count      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,  -- Unix epoch seconds
  updated_at        INTEGER NOT NULL,  -- Unix epoch seconds
  PRIMARY KEY (id)
);

CREATE INDEX idx_conversations_last_message ON conversations (last_message_at DESC);
CREATE INDEX idx_conversations_active ON conversations (active, last_message_at DESC);

-- Threads: thread posts (encrypted title/body with IVs)
CREATE TABLE orbital_threads (
  id                TEXT    NOT NULL,  -- UUID
  conversation_id   TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id         TEXT    NOT NULL,  -- author's serviceId (UUID)
  title_encrypted   BLOB,             -- AES-256-CBC encrypted title
  title_iv          BLOB,             -- 16-byte IV for title
  body_encrypted    BLOB,             -- AES-256-CBC encrypted body
  body_iv           BLOB,             -- 16-byte IV for body
  content_type      TEXT    NOT NULL DEFAULT 'text',  -- 'text' | 'media' | 'link'
  pinned            INTEGER NOT NULL DEFAULT 0,
  reply_count       INTEGER NOT NULL DEFAULT 0,
  last_reply_at     INTEGER,          -- Unix epoch seconds
  created_at        INTEGER NOT NULL,  -- Unix epoch seconds
  updated_at        INTEGER NOT NULL,  -- Unix epoch seconds
  PRIMARY KEY (id)
);

CREATE INDEX idx_threads_conversation ON orbital_threads (conversation_id, created_at DESC);
CREATE INDEX idx_threads_author ON orbital_threads (author_id);

-- Replies: thread replies (mobile-normalized from desktop messages)
CREATE TABLE orbital_replies (
  id                TEXT    NOT NULL,  -- UUID
  thread_id         TEXT    NOT NULL REFERENCES orbital_threads(id) ON DELETE CASCADE,
  author_id         TEXT    NOT NULL,  -- author's serviceId (UUID)
  body_encrypted    BLOB,             -- AES-256-CBC encrypted body
  body_iv           BLOB,             -- 16-byte IV for body
  parent_reply_id   TEXT,             -- NULL for top-level replies
  created_at        INTEGER NOT NULL,  -- Unix epoch seconds
  updated_at        INTEGER NOT NULL,  -- Unix epoch seconds
  PRIMARY KEY (id)
);

CREATE INDEX idx_replies_thread ON orbital_replies (thread_id, created_at ASC);

-- Media: metadata, attachment keys, download state
CREATE TABLE orbital_media (
  id                TEXT    NOT NULL,  -- UUID
  thread_id         TEXT    REFERENCES orbital_threads(id) ON DELETE SET NULL,
  reply_id          TEXT    REFERENCES orbital_replies(id) ON DELETE SET NULL,
  message_id        TEXT    REFERENCES messages(id) ON DELETE SET NULL,
  content_type      TEXT    NOT NULL,  -- MIME type (e.g., 'image/jpeg')
  file_name         TEXT,
  file_size         INTEGER,          -- bytes
  width             INTEGER,          -- pixels
  height            INTEGER,          -- pixels
  duration          INTEGER,          -- milliseconds (for audio/video)
  attachment_key    BLOB,             -- 64-byte key (desktop stores as base64 TEXT; convert at API boundary)
  attachment_digest BLOB,             -- SHA-256 digest
  cdn_number        INTEGER,
  cdn_key           TEXT,
  local_path        TEXT,             -- local file path after download
  thumbnail_path    TEXT,             -- local file path for thumbnail
  download_state    TEXT    NOT NULL DEFAULT 'pending',  -- 'pending' | 'downloading' | 'downloaded' | 'failed'
  upload_state      TEXT    NOT NULL DEFAULT 'done',     -- 'pending' | 'uploading' | 'done' | 'failed'
  created_at        INTEGER NOT NULL,  -- Unix epoch seconds
  PRIMARY KEY (id)
);

CREATE INDEX idx_media_thread ON orbital_media (thread_id);
CREATE INDEX idx_media_download_state ON orbital_media (download_state) WHERE download_state != 'downloaded';

-- Media sync requests: async media recovery
CREATE TABLE orbital_media_sync_requests (
  id                TEXT    NOT NULL,  -- UUID
  media_id          TEXT    NOT NULL REFERENCES orbital_media(id) ON DELETE CASCADE,
  status            TEXT    NOT NULL DEFAULT 'pending',  -- 'pending' | 'in_progress' | 'completed' | 'failed'
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   INTEGER,          -- Unix epoch seconds
  error             TEXT,
  created_at        INTEGER NOT NULL,  -- Unix epoch seconds
  PRIMARY KEY (id)
);

CREATE INDEX idx_media_sync_status ON orbital_media_sync_requests (status) WHERE status != 'completed';

-- Media sync pending uploads: pending upload responses
CREATE TABLE orbital_media_sync_pending_uploads (
  id                TEXT    NOT NULL,  -- UUID
  media_id          TEXT    NOT NULL REFERENCES orbital_media(id) ON DELETE CASCADE,
  upload_url        TEXT    NOT NULL,
  upload_headers    TEXT,              -- JSON headers for upload (ephemeral, not key material)
  expires_at        INTEGER NOT NULL,  -- Unix epoch seconds
  created_at        INTEGER NOT NULL,  -- Unix epoch seconds
  PRIMARY KEY (id)
);

-- ============================================================
-- Messaging Tables (2 tables)
-- ============================================================

-- Messages: Signal Protocol message envelopes
CREATE TABLE messages (
  id                TEXT    NOT NULL,  -- UUID
  conversation_id   TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id         TEXT    NOT NULL,  -- sender's serviceId (UUID)
  type              TEXT    NOT NULL DEFAULT 'message',  -- 'message' | 'thread_update' | 'reaction' | 'system'
  body_encrypted    BLOB,             -- encrypted message body
  body_iv           BLOB,             -- IV for body
  server_timestamp  INTEGER NOT NULL,  -- Unix epoch seconds, from server
  received_at       INTEGER NOT NULL,  -- Unix epoch seconds, local receipt time
  read              INTEGER NOT NULL DEFAULT 0,  -- 1=read
  expires_at        INTEGER,          -- Unix epoch seconds, for disappearing messages
  PRIMARY KEY (id)
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, server_timestamp DESC);
CREATE INDEX idx_messages_unread ON messages (conversation_id, read) WHERE read = 0;
CREATE INDEX idx_messages_expires ON messages (expires_at) WHERE expires_at IS NOT NULL;

-- Message attachments: per-message attachment metadata
CREATE TABLE message_attachments (
  message_id        TEXT    NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_index  INTEGER NOT NULL,  -- 0-based index within message
  media_id          TEXT    REFERENCES orbital_media(id) ON DELETE SET NULL,
  content_type      TEXT    NOT NULL,  -- MIME type
  file_name         TEXT,
  file_size         INTEGER,          -- bytes
  PRIMARY KEY (message_id, attachment_index)
);

-- ============================================================
-- Infrastructure Tables (3 tables + drafts)
-- ============================================================

-- Key-value store for app state (registration ID, profile key, etc.)
-- Desktop equivalent: items table
CREATE TABLE items (
  id    TEXT NOT NULL,  -- key name (e.g., 'registrationIdMap', 'profileKey')
  value TEXT NOT NULL,  -- JSON-encoded value (matches desktop pattern for this table)
  PRIMARY KEY (id)
);

-- Incoming envelope queue: unprocessed messages awaiting decryption
-- Desktop equivalent: unprocessed table
CREATE TABLE unprocessed (
  id                TEXT    NOT NULL,  -- UUID
  envelope          BLOB    NOT NULL,  -- raw protobuf envelope
  server_timestamp  INTEGER NOT NULL,  -- Unix epoch seconds
  source_service_id TEXT,              -- sender's serviceId if known
  source_device     INTEGER,           -- sender's device ID if known
  attempts          INTEGER NOT NULL DEFAULT 0,
  received_at       INTEGER NOT NULL,  -- Unix epoch seconds
  urgent            INTEGER NOT NULL DEFAULT 1,  -- 1=process immediately
  PRIMARY KEY (id)
);

CREATE INDEX idx_unprocessed_timestamp ON unprocessed (server_timestamp ASC);

-- Outgoing sync operation queue
CREATE TABLE sync_tasks (
  id                TEXT    NOT NULL,  -- UUID
  type              TEXT    NOT NULL,  -- sync type (e.g., 'keys', 'contacts', 'groups')
  data              TEXT,              -- JSON task payload
  status            TEXT    NOT NULL DEFAULT 'pending',  -- 'pending' | 'in_progress' | 'completed' | 'failed'
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   INTEGER,          -- Unix epoch seconds
  created_at        INTEGER NOT NULL,  -- Unix epoch seconds
  PRIMARY KEY (id)
);

CREATE INDEX idx_sync_tasks_status ON sync_tasks (status) WHERE status != 'completed';

-- Draft persistence: saves in-progress compositions
CREATE TABLE drafts (
  context_id        TEXT NOT NULL,  -- conversation or thread UUID
  context_type      TEXT NOT NULL,  -- 'conversation' | 'thread' | 'reply'
  body              TEXT,           -- draft text (plaintext; encrypted at rest by SQLCipher)
  updated_at        INTEGER NOT NULL,  -- Unix epoch seconds
  PRIMARY KEY (context_id, context_type)
);

-- Set migration version
PRAGMA user_version = 1;
