export const VERSION = 3;

// SQLite 12-step table rebuild: drop FK constraints on thread_id, reply_id,
// message_id. These FKs cause INSERT failures when parent rows haven't been
// persisted locally yet (data arrives out-of-order from API).
//
// Note: ON DELETE SET NULL behavior is also removed. If local parent deletion
// is added in the future, the deletion flow must handle orphaned media refs.
export const SQL = `
PRAGMA defer_foreign_keys = ON;

CREATE TABLE orbital_media_new (
  id                TEXT    NOT NULL,
  thread_id         TEXT,
  reply_id          TEXT,
  message_id        TEXT,
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
  blur_hash         TEXT,
  expires_at        INTEGER,
  PRIMARY KEY (id)
);

INSERT INTO orbital_media_new (
  id, thread_id, reply_id, message_id, content_type, file_name, file_size,
  width, height, duration, attachment_key, attachment_digest, cdn_number,
  cdn_key, local_path, thumbnail_path, download_state, upload_state,
  created_at, blur_hash, expires_at
)
SELECT
  id, thread_id, reply_id, message_id, content_type, file_name, file_size,
  width, height, duration, attachment_key, attachment_digest, cdn_number,
  cdn_key, local_path, thumbnail_path, download_state, upload_state,
  created_at, blur_hash, expires_at
FROM orbital_media;

DROP TABLE orbital_media;

ALTER TABLE orbital_media_new RENAME TO orbital_media;

CREATE INDEX idx_media_thread ON orbital_media (thread_id);
CREATE INDEX idx_media_download_state ON orbital_media (download_state) WHERE download_state != 'downloaded';

PRAGMA foreign_key_check;
`;
