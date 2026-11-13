export const VERSION = 9;

// Migration 009: Meta import tables (#921)
//
// Three tables for the resumable Facebook/Instagram import: `import_jobs`,
// `import_items` and the child `import_item_media`. The #926 runner parses an
// archive ONCE, persists the result here before any network call, and resumes
// from these rows after a restart without re-parsing.
//
// FORWARD-ONLY. Migrations 001-008 are untouched: this one only CREATEs, so
// there is no table rebuild and the runner does NOT set `disableForeignKeys`
// for it (`migrations/index.ts`).
//
// ## `sourceItemId` is deliberately absent
//
// The parser's `sourceItemId` (#925, `metaImport/sourceItemId.ts`) is the v1
// identity frame, and the v1 framing embeds the post's repaired text verbatim
// — those bytes ARE the member's content. It is PLAINTEXT-CLASS and must never
// be persisted, logged, thrown or sent. The only thing derived from it that
// leaves the parser is the 16-byte `import_key` (#924), which is what these
// tables store and what the server dedups on. A security invariant
// ([meta-import-no-source-item-id]) bans the identifier from this directory.
//
// ## Column handling classes
//
//  - `import_items.body` is PLAINTEXT-CLASS: the member's post text, same
//    posture as `orbital_threads.body` (migration 004) — plaintext inside
//    SQLCipher. Never logged, never in a thrown message, breadcrumb or
//    telemetry. Written only for importable posts at parse time, and set to
//    NULL once the item reaches `created`/`duplicate` (the thread exists
//    server-side by then).
//  - `import_items.source_file` / `source_index` are LOCAL-UI-class (F18): a
//    basename out of the member's own export, carried so #928 can say WHICH
//    item did not migrate. Never telemetry, never an error message, never a
//    request body.
//  - `import_jobs.key_fingerprint` is a LOCAL-ONLY generation + account stamp
//    (`ImportKeySession.keyFingerprint`). Never logged, never in a Sentry
//    breadcrumb or error message, never sent to the server. It is NOT NULL
//    from job creation so that keys written by a `ready` job still carry their
//    generation; every resume transition re-opens a key session and compares.
//  - `import_jobs.archive_bookmark` is a CAPABILITY HANDLE. Never logged.
//
// ## Bookmark rules (`archive_bookmark`)
//
// It holds `JSON.stringify(ArchiveSession.parts)` and is written ONLY from a
// live session's `parts` — never from `pickArchiveParts()` output, which is
// uncapped (that is what bounds the value to 64 entries). The array order is
// the part-index space (`openParts` order, `ARCHIVE_CHANGED{partIndex}`), so
// it is never reordered or de-duplicated, and a token's interior is never
// inspected. Rewrite it on a whole-value comparison only.
//
// RELEASE BEFORE FINISH: the runner releases the parts, THEN calls
// `finishImportJob`, which nulls the bookmark and returns the JSON it cleared
// as a backstop for a runner that has not released yet.
//
// ## Removal trigger
//
// When #926 and #928 merge, delete any column here — and any exported
// `importRepository` function — with zero call sites outside its own tests.
//
// No CHECK constraints, matching 001-008: `SkipReason` grows when video import
// ships, and a CHECK would force a table rebuild under forward-only migrations.

export const SQL = `
-- ============================================================
-- import_jobs: one Meta archive import run
-- ============================================================

CREATE TABLE import_jobs (
  id                 TEXT    NOT NULL,
  conversation_id    TEXT    NOT NULL,          -- the orbit; no FK (003/004 precedent)
  source             TEXT    NOT NULL,          -- 'facebook' | 'instagram'
  status             TEXT    NOT NULL DEFAULT 'parsing',
  session_id         TEXT,                      -- server import_id; NULL until start
  key_fingerprint    TEXT    NOT NULL,          -- ImportKeySession.keyFingerprint; LOCAL ONLY, never logged/sent
  declared_posts     INTEGER,                   -- NULL until parsed; excludes held
  declared_bytes     INTEGER,                   -- NULL until parsed; excludes held
  dropped_duplicates INTEGER NOT NULL DEFAULT 0,-- stored home of SkipReason duplicate_in_archive
  archive_bookmark   TEXT,                      -- JSON ArchiveSession.parts; capability handle; NULLed at terminal
  created_at         INTEGER NOT NULL,          -- epoch MS
  updated_at         INTEGER NOT NULL,          -- epoch MS
  PRIMARY KEY (id)
);

-- NOT a partial index, deliberately. Every reader of this table BINDS its
-- status list (IN (?, ?, ?)), and SQLite can only use a partial index when it
-- can prove the index predicate from the query's own terms -- which it cannot
-- do through a parameter it has not seen. A copy of the status list in a
-- WHERE clause here would therefore make this index dead: measured
-- SCAN import_jobs with it, SEARCH ... USING INDEX idx_import_jobs_active
-- (status=?) without it (migrations.ddl.test.ts pins the plan). Free to fix
-- now under forward-only migrations; a migration 010 once a device has
-- applied 009.
CREATE INDEX idx_import_jobs_active ON import_jobs (status, created_at DESC);

-- ============================================================
-- import_items: one parsed post (importable or skipped)
-- ============================================================

CREATE TABLE import_items (
  id            TEXT    NOT NULL,
  job_id        TEXT    NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  import_key    BLOB,                           -- 16 bytes; NULL for the 3 pre-frame skips
  status        TEXT    NOT NULL DEFAULT 'pending',
  skip_reason   TEXT,                           -- SkipReason; NULL unless skipped
  original_date INTEGER,                        -- epoch MS UTC
  body          TEXT,                           -- PLAINTEXT-CLASS post body; NULL for skips and after created/duplicate
  source_file   TEXT,                           -- post-JSON basename; LOCAL UI ONLY (F18)
  source_index  INTEGER,
  id_kind       INTEGER,                        -- 1 content frame, 2 IG fbid
  thread_id     TEXT,
  error_code    TEXT,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX idx_import_items_job_key ON import_items (job_id, import_key)
  WHERE import_key IS NOT NULL;
CREATE INDEX idx_import_items_job_status ON import_items (job_id, status, ordinal);
CREATE INDEX idx_import_items_job_reason ON import_items (job_id, skip_reason)
  WHERE skip_reason IS NOT NULL;

-- ============================================================
-- import_item_media: one media attachment of a parsed post
-- ============================================================

CREATE TABLE import_item_media (
  item_id       TEXT    NOT NULL REFERENCES import_items(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,               -- display order within the post
  media_id      TEXT    NOT NULL,               -- lowercase UUIDv4 (generateUUID), stable across retries
  entry_id      TEXT    NOT NULL,               -- opaque; never parsed or truncated
  original_date INTEGER,                        -- epoch MS UTC, per media
  upload_state  TEXT    NOT NULL DEFAULT 'pending',  -- pending | uploaded (request-saving cache)
  PRIMARY KEY (item_id, ordinal)
);
`;
