/**
 * Migration 005: FTS5 Full-Text Search
 *
 * Creates FTS5 virtual tables for thread and reply full-text search,
 * plus auto-sync triggers on INSERT/UPDATE/DELETE to keep FTS in sync
 * with the source tables. Backfills existing data from Phase A persistence.
 *
 * FTS5 UNINDEXED columns (thread_id, reply_id, conversation_id) are stored
 * in the FTS table for filtering but are not indexed for MATCH queries.
 */

export const VERSION = 5;

export const SQL = `
-- FTS5 virtual tables for full-text search
CREATE VIRTUAL TABLE thread_fts USING fts5(
  thread_id UNINDEXED,
  conversation_id UNINDEXED,
  title,
  body,
  author_username
);

CREATE VIRTUAL TABLE reply_fts USING fts5(
  reply_id UNINDEXED,
  thread_id UNINDEXED,
  conversation_id UNINDEXED,
  body,
  author_username
);

-- Auto-sync triggers: INSERT
CREATE TRIGGER thread_fts_ai AFTER INSERT ON orbital_threads WHEN new.body IS NOT NULL BEGIN
  INSERT INTO thread_fts(thread_id, conversation_id, title, body, author_username)
  VALUES (new.id, new.conversation_id, new.title, new.body, new.author_username);
END;

CREATE TRIGGER reply_fts_ai AFTER INSERT ON orbital_replies WHEN new.body IS NOT NULL BEGIN
  INSERT INTO reply_fts(reply_id, thread_id, conversation_id, body, author_username)
  VALUES (new.id, new.thread_id,
    (SELECT conversation_id FROM orbital_threads WHERE id = new.thread_id),
    new.body, new.author_username);
END;

-- Auto-sync triggers: UPDATE
CREATE TRIGGER thread_fts_au AFTER UPDATE OF title, body ON orbital_threads BEGIN
  DELETE FROM thread_fts WHERE thread_id = old.id;
  INSERT INTO thread_fts(thread_id, conversation_id, title, body, author_username)
  VALUES (new.id, new.conversation_id, new.title, new.body, new.author_username);
END;

CREATE TRIGGER reply_fts_au AFTER UPDATE OF body ON orbital_replies BEGIN
  DELETE FROM reply_fts WHERE reply_id = old.id;
  INSERT INTO reply_fts(reply_id, thread_id, conversation_id, body, author_username)
  VALUES (new.id, new.thread_id,
    (SELECT conversation_id FROM orbital_threads WHERE id = new.thread_id),
    new.body, new.author_username);
END;

-- Auto-sync triggers: DELETE
CREATE TRIGGER thread_fts_ad AFTER DELETE ON orbital_threads BEGIN
  DELETE FROM thread_fts WHERE thread_id = old.id;
END;

CREATE TRIGGER reply_fts_ad AFTER DELETE ON orbital_replies BEGIN
  DELETE FROM reply_fts WHERE reply_id = old.id;
END;

-- Backfill existing data from Phase A
INSERT INTO thread_fts(thread_id, conversation_id, title, body, author_username)
  SELECT id, conversation_id, title, body, author_username
  FROM orbital_threads WHERE body IS NOT NULL;

INSERT INTO reply_fts(reply_id, thread_id, conversation_id, body, author_username)
  SELECT r.id, r.thread_id, t.conversation_id, r.body, r.author_username
  FROM orbital_replies r
  JOIN orbital_threads t ON r.thread_id = t.id
  WHERE r.body IS NOT NULL;
`;
