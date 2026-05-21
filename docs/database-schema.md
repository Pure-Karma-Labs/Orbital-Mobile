# Orbital-Mobile Database Schema

## Design Principles

1. **Normalized columns** — Desktop's `json TEXT` blobs are replaced with explicit BLOB/TEXT/INTEGER columns for type safety, indexability, and no `JSON.parse` overhead.

2. **Normalized primary keys** — Desktop's composite string keys (e.g., `ourServiceId:serviceId:deviceId`) are split into separate columns with SQL composite PKs. Desktop key format is documented inline for interop.

3. **BLOB for key material** — Pre-keys, identity keys, session records, and attachment keys are stored as raw BLOB. SQLCipher encrypts the entire database file.

4. **WAL mode** — Set at connection time (`PRAGMA journal_mode=WAL`), not in migrations. Single writer, concurrent readers.

5. **Integer migration versioning** — `PRAGMA user_version` tracks the current schema version. Migration files named `001_*.sql`, `002_*.sql`, etc.

6. **All timestamps** — Unix epoch seconds as `INTEGER`. Per-column documentation notes the unit.

---

## Desktop Compatibility Mapping

Mobile normalizes desktop's composite keys into explicit columns. To reconstruct desktop-format keys for interop:

| Mobile Table | Desktop Key Format | Reconstruction |
|---|---|---|
| `signal_sessions` | `ourServiceId:serviceId:deviceId` | `our_service_id \|\| ':' \|\| service_id \|\| ':' \|\| device_id` |
| `signal_sender_keys` | `ourServiceId:senderId:distributionId` | `our_service_id \|\| ':' \|\| sender_id \|\| ':' \|\| distribution_id` |
| `signal_identity_keys` | `ourServiceId:serviceId` | `address` column ('local' for own, serviceId for remote) |

**Attachment keys:** Desktop stores as base64 TEXT, mobile stores as 64-byte BLOB. Convert at the API boundary when syncing.

**Session records:** Same protobuf BLOB format as desktop v1220+. No conversion needed.

**Schema baseline:** Designed against desktop migration v1513.

---

## Tables (17 total)

### Signal Protocol Stores (6)

#### `signal_identity_keys`
Own key pair (address='local') + remote identity keys.

| Column | Type | Notes |
|--------|------|-------|
| `address` | TEXT PK | 'local' for own key pair, serviceId UUID for remotes |
| `identity_key` | BLOB NOT NULL | 33-byte public key (64-byte key pair for 'local') |
| `verified` | INTEGER NOT NULL | 0=default, 1=verified, 2=unverified |
| `first_use` | INTEGER NOT NULL | Unix epoch seconds |
| `nonblocking_approval` | INTEGER NOT NULL | 1=approved without blocking |

#### `signal_sessions`
Double Ratchet session state.

| Column | Type | Notes |
|--------|------|-------|
| `our_service_id` | TEXT | Composite PK part 1 — our UUID |
| `service_id` | TEXT | Composite PK part 2 — remote UUID |
| `device_id` | INTEGER | Composite PK part 3 |
| `record` | BLOB NOT NULL | Protobuf session record (desktop v1220+ format) |
| `version` | INTEGER NOT NULL | Session version (default 2) |

**Indexes:** `idx_sessions_service (service_id)`

#### `signal_pre_keys`
One-time pre-keys for X3DH.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Pre-key ID |
| `key_data` | BLOB NOT NULL | Serialized pre-key pair |
| `created_at` | INTEGER NOT NULL | Unix epoch seconds |

#### `signal_signed_pre_keys`
Signed pre-keys (30-day rotation).

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Signed pre-key ID |
| `key_data` | BLOB NOT NULL | Serialized signed pre-key pair |
| `created_at` | INTEGER NOT NULL | Unix epoch seconds |
| `confirmed` | INTEGER NOT NULL | 1=confirmed by server |

#### `signal_kyber_pre_keys`
Post-quantum pre-keys.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Kyber pre-key ID |
| `key_data` | BLOB NOT NULL | Serialized Kyber key pair |
| `is_last_resort` | INTEGER NOT NULL | 1=last resort (not deleted after use) |
| `created_at` | INTEGER NOT NULL | Unix epoch seconds |

#### `signal_sender_keys`
Group messaging sender keys (Sealed Sender v2).

| Column | Type | Notes |
|--------|------|-------|
| `our_service_id` | TEXT | Composite PK part 1 |
| `sender_id` | TEXT | Composite PK part 2 |
| `distribution_id` | TEXT | Composite PK part 3 |
| `record` | BLOB NOT NULL | Serialized sender key state |
| `created_at` | INTEGER NOT NULL | Unix epoch seconds |

### Orbital App Tables (6)

#### `conversations`
Groups and DM metadata.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `type` | TEXT NOT NULL | 'group' or 'direct' |
| `name` | TEXT | Group name |
| `avatar_path` | TEXT | Local file path |
| `group_master_key` | BLOB | 32 bytes |
| `group_secret_params` | BLOB | |
| `group_public_params` | BLOB | |
| `group_version` | INTEGER NOT NULL | Default 2 |
| `member_count` | INTEGER NOT NULL | |
| `active` | INTEGER NOT NULL | 1=active, 0=archived/left |
| `mute_until` | INTEGER | Unix epoch seconds |
| `last_message_at` | INTEGER | Unix epoch seconds |
| `unread_count` | INTEGER NOT NULL | |
| `created_at` | INTEGER NOT NULL | Unix epoch seconds |
| `updated_at` | INTEGER NOT NULL | Unix epoch seconds |

**Indexes:** `idx_conversations_last_message (last_message_at DESC)`, `idx_conversations_active (active, last_message_at DESC)`

#### `orbital_threads`
Thread posts with encrypted title/body.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `conversation_id` | TEXT NOT NULL | FK → conversations |
| `author_id` | TEXT NOT NULL | Author's serviceId |
| `title_encrypted` | BLOB | AES-256-CBC encrypted |
| `title_iv` | BLOB | 16-byte IV |
| `body_encrypted` | BLOB | AES-256-CBC encrypted |
| `body_iv` | BLOB | 16-byte IV |
| `content_type` | TEXT NOT NULL | 'text', 'media', or 'link' |
| `pinned` | INTEGER NOT NULL | |
| `reply_count` | INTEGER NOT NULL | |
| `last_reply_at` | INTEGER | Unix epoch seconds |
| `created_at` | INTEGER NOT NULL | Unix epoch seconds |
| `updated_at` | INTEGER NOT NULL | Unix epoch seconds |

**Indexes:** `idx_threads_conversation (conversation_id, created_at DESC)`, `idx_threads_author (author_id)`

#### `orbital_replies`
Thread replies.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `thread_id` | TEXT NOT NULL | FK → orbital_threads |
| `author_id` | TEXT NOT NULL | Author's serviceId |
| `body_encrypted` | BLOB | AES-256-CBC encrypted |
| `body_iv` | BLOB | 16-byte IV |
| `parent_reply_id` | TEXT | Null for top-level |
| `created_at` | INTEGER NOT NULL | Unix epoch seconds |
| `updated_at` | INTEGER NOT NULL | Unix epoch seconds |

**Indexes:** `idx_replies_thread (thread_id, created_at ASC)`

#### `orbital_media`
Media metadata, attachment keys, download state.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `thread_id` | TEXT | Logical ref → orbital_threads (no FK constraint) |
| `reply_id` | TEXT | Logical ref → orbital_replies (no FK constraint) |
| `message_id` | TEXT | Logical ref → messages (no FK constraint) |
| `content_type` | TEXT NOT NULL | MIME type |
| `file_name` | TEXT | |
| `file_size` | INTEGER | Bytes |
| `width` | INTEGER | Pixels |
| `height` | INTEGER | Pixels |
| `duration` | INTEGER | Milliseconds |
| `attachment_key` | BLOB | 64-byte key (desktop: base64 TEXT) |
| `attachment_digest` | BLOB | SHA-256 |
| `cdn_number` | INTEGER | |
| `cdn_key` | TEXT | |
| `local_path` | TEXT | |
| `thumbnail_path` | TEXT | |
| `download_state` | TEXT NOT NULL | 'pending', 'downloading', 'downloaded', 'failed' |
| `upload_state` | TEXT NOT NULL | 'pending', 'uploading', 'done', 'failed' |
| `created_at` | INTEGER NOT NULL | Unix epoch seconds |

**Indexes:** `idx_media_thread (thread_id)`, `idx_media_download_state (download_state) WHERE download_state != 'downloaded'`

#### `orbital_media_sync_requests`
Async media recovery requests.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `media_id` | TEXT NOT NULL | FK → orbital_media |
| `status` | TEXT NOT NULL | 'pending', 'in_progress', 'completed', 'failed' |
| `attempts` | INTEGER NOT NULL | |
| `last_attempt_at` | INTEGER | Unix epoch seconds |
| `error` | TEXT | |
| `created_at` | INTEGER NOT NULL | Unix epoch seconds |

**Indexes:** `idx_media_sync_status (status) WHERE status != 'completed'`

#### `orbital_media_sync_pending_uploads`
Pending upload responses.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `media_id` | TEXT NOT NULL | FK → orbital_media |
| `upload_url` | TEXT NOT NULL | |
| `upload_headers` | TEXT | JSON (ephemeral, not key material) |
| `expires_at` | INTEGER NOT NULL | Unix epoch seconds |
| `created_at` | INTEGER NOT NULL | Unix epoch seconds |

### Messaging Tables (2)

#### `messages`
Signal Protocol message envelopes.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `conversation_id` | TEXT NOT NULL | FK → conversations |
| `sender_id` | TEXT NOT NULL | Sender's serviceId |
| `type` | TEXT NOT NULL | 'message', 'thread_update', 'reaction', 'system' |
| `body_encrypted` | BLOB | |
| `body_iv` | BLOB | |
| `server_timestamp` | INTEGER NOT NULL | Unix epoch seconds (from server) |
| `received_at` | INTEGER NOT NULL | Unix epoch seconds (local) |
| `read` | INTEGER NOT NULL | 1=read |
| `expires_at` | INTEGER | Unix epoch seconds |

**Indexes:** `idx_messages_conversation (conversation_id, server_timestamp DESC)`, `idx_messages_unread (conversation_id, read) WHERE read = 0`, `idx_messages_expires (expires_at) WHERE expires_at IS NOT NULL`

#### `message_attachments`
Per-message attachment metadata.

| Column | Type | Notes |
|--------|------|-------|
| `message_id` | TEXT | Composite PK part 1, FK → messages |
| `attachment_index` | INTEGER | Composite PK part 2 (0-based) |
| `media_id` | TEXT | FK → orbital_media |
| `content_type` | TEXT NOT NULL | MIME type |
| `file_name` | TEXT | |
| `file_size` | INTEGER | Bytes |

### Infrastructure Tables (3 + drafts)

#### `items`
Key-value store for app state.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Key name (e.g., 'registrationIdMap') |
| `value` | TEXT NOT NULL | JSON-encoded value (matches desktop) |

#### `unprocessed`
Incoming envelope queue.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `envelope` | BLOB NOT NULL | Raw protobuf envelope |
| `server_timestamp` | INTEGER NOT NULL | Unix epoch seconds |
| `source_service_id` | TEXT | Sender's serviceId |
| `source_device` | INTEGER | Sender's device ID |
| `attempts` | INTEGER NOT NULL | |
| `received_at` | INTEGER NOT NULL | Unix epoch seconds |
| `urgent` | INTEGER NOT NULL | 1=process immediately |

**Indexes:** `idx_unprocessed_timestamp (server_timestamp ASC)`

#### `sync_tasks`
Outgoing sync operation queue.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `type` | TEXT NOT NULL | Sync type |
| `data` | TEXT | JSON payload |
| `status` | TEXT NOT NULL | 'pending', 'in_progress', 'completed', 'failed' |
| `attempts` | INTEGER NOT NULL | |
| `last_attempt_at` | INTEGER | Unix epoch seconds |
| `created_at` | INTEGER NOT NULL | Unix epoch seconds |

**Indexes:** `idx_sync_tasks_status (status) WHERE status != 'completed'`

#### `drafts`
Draft persistence.

| Column | Type | Notes |
|--------|------|-------|
| `context_id` | TEXT | Composite PK part 1 — conversation/thread UUID |
| `context_type` | TEXT | Composite PK part 2 — 'conversation', 'thread', 'reply' |
| `body` | TEXT | Plaintext (encrypted at rest by SQLCipher) |
| `updated_at` | INTEGER NOT NULL | Unix epoch seconds |

---

## Index Strategy

- **Conversation list** — `idx_conversations_active` covers the main inbox query (`WHERE active=1 ORDER BY last_message_at DESC`)
- **Message history** — `idx_messages_conversation` covers scrollback (`WHERE conversation_id=? ORDER BY server_timestamp DESC`)
- **Unread badges** — `idx_messages_unread` is a partial index for fast unread counts
- **Expiring messages** — `idx_messages_expires` partial index for cleanup queries
- **Queue processing** — `idx_unprocessed_timestamp`, `idx_sync_tasks_status`, `idx_media_sync_status` use partial indexes to skip completed items
- **Partial indexes** — Used where filtered queries dominate (download state, sync status, read state). Keeps index size small on mobile.

---

## Migration Strategy

- **Version tracking:** `PRAGMA user_version` (integer)
- **File naming:** `001_initial_schema.sql`, `002_fts5_search.sql`, etc.
- **Runner contract:** The migration runner reads `user_version`, runs all migrations with higher numbers in order, then sets `user_version` to the latest
- **Transactions:** Each migration runs inside a single transaction (except `PRAGMA` statements which must be outside)
- **Forward-only:** No down migrations — rollback by restoring backup

---

## Security Considerations

- **SQLCipher configuration:** 256-bit AES-CBC, PBKDF2 with 256,000 iterations (or platform keychain-derived key for zero-iteration unlock)
- **Key storage:** Database encryption key stored in iOS Keychain / Android Keystore with biometric binding where available
- **Key material columns:** All pre-keys, identity keys, session records, and attachment keys stored as BLOB — never base64 or hex TEXT
- **No plaintext secrets in `items`:** Registration IDs and profile keys are not secret per se, but sensitive values must not be stored in the `items` table without additional encryption
- **WAL mode:** WAL file contains unencrypted page data only when SQLCipher's WAL encryption is enabled (default in SQLCipher 4.x)
- **Memory:** Use `PRAGMA cipher_memory_security = ON` to wipe memory on free

---

## Migration History

| Version | File | Description |
|---------|------|-------------|
| 001 | `001_initial_schema.ts` | All 17 tables, indexes, initial schema |
| 002 | `002_media_blur_hash_expires.ts` | Add blur_hash and expires_at to orbital_media |
| 003 | `003_drop_media_fks.ts` | Drop FK constraints on orbital_media (thread_id, reply_id, message_id) |

## Planned Future Migrations

| Version | File | Description |
|---------|------|-------------|
| 004 | TBD | FTS5 virtual tables for message and thread search |
| 005 | TBD | Read receipts, typing indicators |
| 006 | TBD | Reactions table, emoji indexes |
