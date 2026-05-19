---
name: Established security patterns
description: Eleven mandatory security patterns validated during Phase 1-2 audits that must be preserved in all future crypto and media code
metadata:
  type: feedback
---

## Established Security Patterns

These patterns were validated and confirmed correct during security audits. Any regression is a security finding.

1. **`BEGIN IMMEDIATE` for all crypto transactions** — Never use `BEGIN TRANSACTION` or bare `BEGIN` for operations touching Signal Protocol state. `BEGIN IMMEDIATE` acquires a reserved lock immediately, preventing TOCTOU races in the preloaded store architecture.
   **Why:** F-03 found `BEGIN TRANSACTION` in three places in `keyGenerationService.ts`. With SQLCipher WAL mode and the preloaded store pattern (read from SQLCipher -> process in Rust -> write back), a deferred lock allows another operation to interleave between read and write-back.
   **How to apply:** Flag any new `BEGIN TRANSACTION` or `BEGIN` (without IMMEDIATE) in crypto or Signal Protocol code as High severity.

2. **Per-address lock map for operation serialization** — All protocol operations to the same address (recipient) must be serialized. No concurrent encrypt/decrypt for the same session.
   **Why:** The Double Ratchet is stateful — concurrent operations would corrupt ratchet state. React Native's single JS thread helps, but async yields between read and write-back can still interleave.
   **How to apply:** When reviewing message encryption/decryption, verify that operations to the same recipient cannot run concurrently.

3. **No private key material in FFI Result types** — Only public keys should cross the Rust/TS boundary in function return values. Private keys stay in Rust or go directly to secure storage.
   **Why:** The FFI boundary is a serialization point — private key material transiting through JS heap increases exposure surface, especially with the preloaded store pattern.
   **How to apply:** Review any new uniffi function signatures. If a return type contains private key bytes, flag as High.

4. **No console.log in crypto code paths** — Zero console.log/warn/error in `src/services/crypto/`.
   **Why:** Console output on mobile can be captured by system logs, crash reporters, and diagnostic tools. Crypto state in logs is a data leak vector.
   **How to apply:** Grep `src/services/crypto/` for console.* in any PR touching that directory. Any match is Medium severity.

5. **Pre-key consumption atomicity** — Session creation + identity key trust check + pre-key deletion must happen in a single `BEGIN IMMEDIATE` transaction.
   **Why:** Partial completion (e.g., session saved but pre-key not deleted) would allow pre-key reuse, breaking forward secrecy guarantees.
   **How to apply:** When reviewing session establishment code, verify all three operations are within the same transaction boundary.

6. **HMAC-before-decrypt for attachments** — Rust `attachment_decrypt` verifies HMAC-SHA256 before CBC decryption. Opaque errors prevent padding oracle. Verified in `attachment_crypto.rs:145-157`.
   **Why:** CBC mode is vulnerable to padding oracle attacks if decryption is attempted before MAC verification. The HMAC-then-decrypt order ensures tampered ciphertext is rejected before any decryption occurs.
   **How to apply:** If any new decryption path is added for attachments or media, verify it follows HMAC-before-decrypt. Any decrypt-before-verify is Critical severity.

7. **plaintext hash is local-only** — `plaintextHash` must never be included in API payloads. Currently discarded in `mediaUploadService.ts:310`. Branded type guard pending (#115).
   **Why:** Sending the SHA-256 hash of the original plaintext file to the server would break zero-knowledge guarantees — the server could use the hash to identify content without decrypting.
   **How to apply:** If any API payload construction references `plaintextHash`, flag as High. Watch for it in upload metadata, media creation requests, and sync payloads.

8. **Server-controlled IDs validated before path construction** — Any value originating from the server (e.g., `mediaId`, file extension) that flows into a file system path must be validated against a strict allowlist regex before use. `mediaId` validated against `SAFE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`. Extensions validated against `SAFE_EXT_RE = /^[a-zA-Z0-9]{1,10}$/`. Implemented in `src/services/mediaDownloadService.ts:86-97` (`validatePathComponents`).
   **Why:** A malicious or compromised server could send a `mediaId` like `../../Library/Preferences/com.orbital` to escape the media directory via path traversal, overwriting app preferences or other sensitive files. This is an OWASP M1 (Improper Platform Usage) vector.
   **How to apply:** Any new code that constructs file paths from server-supplied data (download paths, cache paths, export paths) must validate all components with strict regex. A missing validation is High severity. The `validatePathComponents` function in `mediaDownloadService.ts` is the reference implementation.

9. **Upload-side attachment keys must never be overwritten by server responses** — `processMediaMetadata` in `src/services/threadService.ts:161` checks the in-memory Zustand store before the database. If a `MediaItem` already exists in the store (e.g., from a successful upload with `hasKeys: true` and `localPath` set), it is preserved as-is. The server response may arrive with no attachment key (because keys are never sent to the server), and blindly creating a new DB/store entry would overwrite `hasKeys: true` with `hasKeys: false`, losing the decryption keys.
   **Why:** Attachment keys are generated client-side and never leave the device. If `processMediaMetadata` clobbers the store entry from an upload with a server-response entry that lacks keys, the media becomes permanently undecryptable. This is a data-loss / confidentiality invariant.
   **How to apply:** Any code path that merges server-returned media metadata into local state must check for existing entries with attachment keys first. The lookup order is: (1) in-memory store, (2) database row, (3) create new. Skipping step 1 or 2 is High severity. Note: existing rows with null attachment_key now attempt envelope-based recovery — see pattern 10.

10. **Attachment key distribution via versioned metadata envelope** — Attachment keys (64 bytes: 32 AES + 32 HMAC) are embedded as base64 inside the AES-256-GCM encrypted metadata envelope (`v: 1`). The key is encrypted with the group key before upload and extracted by recipients via `decryptMediaMetadataEnvelope()` in `threadService.ts`. Input validation: `typeof` check + 64-byte decoded length check. Legacy rows with null keys attempt retroactive recovery from the envelope.
   **Why:** Attachment keys were previously stored only in local SQLCipher and never distributed. Fresh installs or new group members lost all keys, making media permanently undecryptable. Embedding the key in the group-key-encrypted envelope preserves zero-knowledge (server never sees plaintext) while ensuring all group members with the group key can decrypt media.
   **How to apply:** Any new metadata field added to the envelope must be inside the group-key-encrypted payload. Never send attachment keys in cleartext API fields. The `v` field enables forward-compatible envelope evolution — bump to `v: 2` if the schema changes. Always validate extracted keys (64-byte length) before use.

11. **op-sqlite encryptionKey quoting is bridge-handled** — op-sqlite's C++ bridge wraps the `encryptionKey` parameter in single quotes when issuing `PRAGMA key = '<key>'`. Application code must NOT add its own quoting (e.g., `x'...'` wrapper). Double-quoting produces a broken PRAGMA and a 0-byte database file with no WAL/SHM — the DB silently appears to work in-memory but never persists. Reference: `src/database/connection.ts:25`.
   **Why:** This bug caused complete data loss on every app restart — the 0-byte file was overwritten on each launch. The in-memory illusion (SQLite operations succeed against a non-persisted DB) makes this extremely hard to detect via functional testing.
   **How to apply:** When reviewing any changes to database connection setup or encryption key handling, verify that the key is passed as a raw string (hex or passphrase) without SQL-level quoting. If op-sqlite is ever replaced with another SQLite wrapper, verify how that wrapper handles `PRAGMA key` formatting at the native bridge layer.
