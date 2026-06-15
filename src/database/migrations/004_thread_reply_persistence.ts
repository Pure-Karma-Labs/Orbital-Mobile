export const VERSION = 4;

// Migration 004: Thread & Reply Persistence
//
// 1. Add plaintext columns (title, body, author_username, sync_status, depth)
//    to orbital_threads and orbital_replies for local cache/hydration.
// 2. Drop FK constraints on both tables using the 12-step table rebuild pattern.
//    FKs cause INSERT failures when WS data arrives out-of-order (thread before
//    the conversation row exists in SQLCipher). Keep NOT NULL on conversation_id
//    and thread_id.
//
// Runner sets disableForeignKeys: true for this migration.

export const SQL = `
-- ============================================================
-- orbital_threads: rebuild without FK, add plaintext columns
-- ============================================================

CREATE TABLE orbital_threads_new (
  id                TEXT    NOT NULL,
  conversation_id   TEXT    NOT NULL,
  author_id         TEXT    NOT NULL,
  title_encrypted   BLOB,
  title_iv          BLOB,
  body_encrypted    BLOB,
  body_iv           BLOB,
  title             TEXT,
  body              TEXT,
  author_username   TEXT,
  content_type      TEXT    NOT NULL DEFAULT 'text',
  pinned            INTEGER NOT NULL DEFAULT 0,
  reply_count       INTEGER NOT NULL DEFAULT 0,
  last_reply_at     INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  sync_status       TEXT    NOT NULL DEFAULT 'synced',
  PRIMARY KEY (id)
);

INSERT INTO orbital_threads_new (
  id, conversation_id, author_id, title_encrypted, title_iv,
  body_encrypted, body_iv, content_type, pinned, reply_count,
  last_reply_at, created_at, updated_at
)
SELECT
  id, conversation_id, author_id, title_encrypted, title_iv,
  body_encrypted, body_iv, content_type, pinned, reply_count,
  last_reply_at, created_at, updated_at
FROM orbital_threads;

DROP TABLE orbital_threads;

ALTER TABLE orbital_threads_new RENAME TO orbital_threads;

CREATE INDEX idx_threads_conversation ON orbital_threads (conversation_id, created_at DESC);
CREATE INDEX idx_threads_author ON orbital_threads (author_id);

-- ============================================================
-- orbital_replies: rebuild without FK, add plaintext columns
-- ============================================================

CREATE TABLE orbital_replies_new (
  id                TEXT    NOT NULL,
  thread_id         TEXT    NOT NULL,
  author_id         TEXT    NOT NULL,
  body_encrypted    BLOB,
  body_iv           BLOB,
  body              TEXT,
  author_username   TEXT,
  parent_reply_id   TEXT,
  depth             INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  sync_status       TEXT    NOT NULL DEFAULT 'synced',
  PRIMARY KEY (id)
);

INSERT INTO orbital_replies_new (
  id, thread_id, author_id, body_encrypted, body_iv,
  parent_reply_id, created_at, updated_at
)
SELECT
  id, thread_id, author_id, body_encrypted, body_iv,
  parent_reply_id, created_at, updated_at
FROM orbital_replies;

DROP TABLE orbital_replies;

ALTER TABLE orbital_replies_new RENAME TO orbital_replies;

CREATE INDEX idx_replies_thread ON orbital_replies (thread_id, created_at ASC);
`;
