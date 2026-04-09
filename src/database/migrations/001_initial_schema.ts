/**
 * Migration 001: Initial Schema
 * Orbital-Mobile database schema (17 tables)
 * Compatible with Orbital-Desktop migration baseline v1513
 *
 * NOTE: PRAGMA user_version is intentionally omitted here.
 * The migration runner in index.ts manages version tracking.
 */

export const VERSION = 1;

export const SQL = `
-- ============================================================
-- Signal Protocol Stores (6 tables)
-- ============================================================

-- Identity keys: own key pair (address='local') + remote identity keys
-- Desktop equivalent: signalapp/Signal-Desktop identityKeys table
-- Desktop PK: composite string 'ourServiceId:serviceId'
CREATE TABLE signal_identity_keys (
  address       TEXT    NOT NULL,
  identity_key  BLOB    NOT NULL,
  verified      INTEGER NOT NULL DEFAULT 0,
  first_use     INTEGER NOT NULL DEFAULT 0,
  nonblocking_approval INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (address)
);

-- Sessions: Double Ratchet session state
-- Desktop PK: composite string 'ourServiceId:serviceId:deviceId'
CREATE TABLE signal_sessions (
  our_service_id TEXT    NOT NULL,
  service_id     TEXT    NOT NULL,
  device_id      INTEGER NOT NULL,
  record         BLOB    NOT NULL,
  version        INTEGER NOT NULL DEFAULT 2,
  PRIMARY KEY (our_service_id, service_id, device_id)
);

CREATE INDEX idx_sessions_service ON signal_sessions (service_id);

-- One-time pre-keys for X3DH key exchange
CREATE TABLE signal_pre_keys (
  id         INTEGER NOT NULL,
  key_data   BLOB    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id)
);

-- Signed pre-keys (30-day rotation)
CREATE TABLE signal_signed_pre_keys (
  id           INTEGER NOT NULL,
  key_data     BLOB    NOT NULL,
  created_at   INTEGER NOT NULL,
  confirmed    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);

-- Post-quantum (Kyber) pre-keys
CREATE TABLE signal_kyber_pre_keys (
  id           INTEGER NOT NULL,
  key_data     BLOB    NOT NULL,
  is_last_resort INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (id)
);

-- Sender keys for group messaging (Sealed Sender v2)
-- Desktop PK: composite string 'ourServiceId:senderId:distributionId'
CREATE TABLE signal_sender_keys (
  our_service_id  TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  distribution_id TEXT NOT NULL,
  record          BLOB NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (our_service_id, sender_id, distribution_id)
);

-- ============================================================
-- Orbital App Tables (6 tables)
-- ============================================================

-- Conversations: groups and DM metadata
CREATE TABLE conversations (
  id                TEXT    NOT NULL,
  type              TEXT    NOT NULL DEFAULT 'group',
  name              TEXT,
  avatar_path       TEXT,
  group_master_key  BLOB,
  group_secret_params BLOB,
  group_public_params BLOB,
  group_version     INTEGER NOT NULL DEFAULT 2,
  member_count      INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  mute_until        INTEGER,
  last_message_at   INTEGER,
  unread_count      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX idx_conversations_last_message ON conversations (last_message_at DESC);
CREATE INDEX idx_conversations_active ON conversations (active, last_message_at DESC);

-- Threads: thread posts (encrypted title/body with IVs)
CREATE TABLE orbital_threads (
  id                TEXT    NOT NULL,
  conversation_id   TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id         TEXT    NOT NULL,
  title_encrypted   BLOB,
  title_iv          BLOB,
  body_encrypted    BLOB,
  body_iv           BLOB,
  content_type      TEXT    NOT NULL DEFAULT 'text',
  pinned            INTEGER NOT NULL DEFAULT 0,
  reply_count       INTEGER NOT NULL DEFAULT 0,
  last_reply_at     INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX idx_threads_conversation ON orbital_threads (conversation_id, created_at DESC);
CREATE INDEX idx_threads_author ON orbital_threads (author_id);

-- Replies: thread replies (mobile-normalized from desktop messages)
CREATE TABLE orbital_replies (
  id                TEXT    NOT NULL,
  thread_id         TEXT    NOT NULL REFERENCES orbital_threads(id) ON DELETE CASCADE,
  author_id         TEXT    NOT NULL,
  body_encrypted    BLOB,
  body_iv           BLOB,
  parent_reply_id   TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX idx_replies_thread ON orbital_replies (thread_id, created_at ASC);

-- Media: metadata, attachment keys, download state
CREATE TABLE orbital_media (
  id                TEXT    NOT NULL,
  thread_id         TEXT    REFERENCES orbital_threads(id) ON DELETE SET NULL,
  reply_id          TEXT    REFERENCES orbital_replies(id) ON DELETE SET NULL,
  message_id        TEXT    REFERENCES messages(id) ON DELETE SET NULL,
  content_type      TEXT    NOT NULL,
  file_name         TEXT,
  file_size         INTEGER,
  width             INTEGER,
  height            INTEGER,
  duration          INTEGER,
  attachment_key    BLOB,
  attachment_digest BLOB,
  cdn_number        INTEGER,
  cdn_key           TEXT,
  local_path        TEXT,
  thumbnail_path    TEXT,
  download_state    TEXT    NOT NULL DEFAULT 'pending',
  upload_state      TEXT    NOT NULL DEFAULT 'done',
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX idx_media_thread ON orbital_media (thread_id);
CREATE INDEX idx_media_download_state ON orbital_media (download_state) WHERE download_state != 'downloaded';

-- Media sync requests: async media recovery
CREATE TABLE orbital_media_sync_requests (
  id                TEXT    NOT NULL,
  media_id          TEXT    NOT NULL REFERENCES orbital_media(id) ON DELETE CASCADE,
  status            TEXT    NOT NULL DEFAULT 'pending',
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   INTEGER,
  error             TEXT,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX idx_media_sync_status ON orbital_media_sync_requests (status) WHERE status != 'completed';

-- Media sync pending uploads: pending upload responses
CREATE TABLE orbital_media_sync_pending_uploads (
  id                TEXT    NOT NULL,
  media_id          TEXT    NOT NULL REFERENCES orbital_media(id) ON DELETE CASCADE,
  upload_url        TEXT    NOT NULL,
  upload_headers    TEXT,
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (id)
);

-- ============================================================
-- Messaging Tables (2 tables)
-- ============================================================

-- Messages: Signal Protocol message envelopes
CREATE TABLE messages (
  id                TEXT    NOT NULL,
  conversation_id   TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id         TEXT    NOT NULL,
  type              TEXT    NOT NULL DEFAULT 'message',
  body_encrypted    BLOB,
  body_iv           BLOB,
  server_timestamp  INTEGER NOT NULL,
  received_at       INTEGER NOT NULL,
  read              INTEGER NOT NULL DEFAULT 0,
  expires_at        INTEGER,
  PRIMARY KEY (id)
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, server_timestamp DESC);
CREATE INDEX idx_messages_unread ON messages (conversation_id, read) WHERE read = 0;
CREATE INDEX idx_messages_expires ON messages (expires_at) WHERE expires_at IS NOT NULL;

-- Message attachments: per-message attachment metadata
CREATE TABLE message_attachments (
  message_id        TEXT    NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_index  INTEGER NOT NULL,
  media_id          TEXT    REFERENCES orbital_media(id) ON DELETE SET NULL,
  content_type      TEXT    NOT NULL,
  file_name         TEXT,
  file_size         INTEGER,
  PRIMARY KEY (message_id, attachment_index)
);

-- ============================================================
-- Infrastructure Tables (3 tables + drafts)
-- ============================================================

-- Key-value store for app state (registration ID, profile key, etc.)
CREATE TABLE items (
  id    TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (id)
);

-- Incoming envelope queue: unprocessed messages awaiting decryption
CREATE TABLE unprocessed (
  id                TEXT    NOT NULL,
  envelope          BLOB    NOT NULL,
  server_timestamp  INTEGER NOT NULL,
  source_service_id TEXT,
  source_device     INTEGER,
  attempts          INTEGER NOT NULL DEFAULT 0,
  received_at       INTEGER NOT NULL,
  urgent            INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
);

CREATE INDEX idx_unprocessed_timestamp ON unprocessed (server_timestamp ASC);

-- Outgoing sync operation queue
CREATE TABLE sync_tasks (
  id                TEXT    NOT NULL,
  type              TEXT    NOT NULL,
  data              TEXT,
  status            TEXT    NOT NULL DEFAULT 'pending',
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   INTEGER,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX idx_sync_tasks_status ON sync_tasks (status) WHERE status != 'completed';

-- Draft persistence: saves in-progress compositions
CREATE TABLE drafts (
  context_id        TEXT NOT NULL,
  context_type      TEXT NOT NULL,
  body              TEXT,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (context_id, context_type)
);
`;
