---
name: audit-coverage-phase2
description: Phase 2 security audit coverage — media upload pipeline, download pipeline, attachment crypto FFI, backend fixes
metadata:
  type: project
---

## Phase 2 Audit Coverage

### Chunk 2 (Upload) — 2026-05-14

#### PRs/Commits Reviewed
- #113: Media foundation (attachment crypto, API client, repository, store)
- #117: Media upload pipeline + picker integration (Chunk 2)
- #121: Reply media picker integration
- #124: Rust native bindings for attachment crypto

#### Positive Verifications
1. HMAC verified before CBC decryption (`attachment_crypto.rs:145-157`)
2. Opaque error messages for all decryption failures
3. CSPRNG IV generation (16-byte, `rand::fill`)
4. 64-byte key length strictly enforced
5. `plaintextHash` discarded at `mediaUploadService.ts:310` (`void plaintextHash`)
6. Release profile strips symbols (`Cargo.toml: strip = "symbols"`)
7. iOS file protection inherits `NSFileProtectionCompleteUntilFirstUserAuthentication`
8. Temp chunk files contain ciphertext only, cleaned in finally blocks
9. Metadata encrypted with group key before server upload (zero-knowledge filenames)
10. No console logging in crypto path

### Chunk 3 (Download + Post-Merge Fixes) — 2026-05-15

#### Commits Reviewed
- Media download pipeline (`mediaDownloadService.ts`)
- Post-merge DB guard fixes (commit `8049701`)
- Lazy-import fix for `cleanupOrphanedChunks` (commit `4f13be3`)
- Temp file pattern for chunk upload (commit `a55bd19`)

#### Positive Verifications
11. Path injection mitigated — `mediaId` validated against UUID regex (`SAFE_ID_RE`), extensions against alphanumeric regex (`SAFE_EXT_RE`), both in `mediaDownloadService.ts:86-97`
12. Atomic plaintext write — decrypted media written to `.tmp` then `moveFile()` to final path (`mediaDownloadService.ts:170,202-205`); prevents partial plaintext on crash
13. Inflight download dedup — `Map<string, Promise<string>>` prevents duplicate concurrent downloads; cleared in finally block (`mediaDownloadService.ts:80`)
14. Concurrency limited — semaphore caps at 3 concurrent downloads (`MAX_CONCURRENT`)
15. `processMediaMetadata` preserves upload-side keys — checks in-memory store before DB to avoid overwriting `hasKeys: true` with server-response `hasKeys: false` (`threadService.ts:194-216`)
16. DB guard for hot reload — `isDatabaseInitialized()` check before DB calls in `processMediaMetadata` (`threadService.ts:169`)
17. Stale `.tmp` file sweep — download service cleanup sweeps `.tmp` files older than 1 hour (`mediaDownloadService.ts:306-307`)
18. Directory-level backup exclusion — `mkdir({ NSURLIsExcludedFromBackupKey: true })` applied to media dir in both upload and download services (best-effort; per-file exclusion needs native bridge)
19. Ciphertext ArrayBuffer released before base64 encoding — noted in service header comment (F5/T2)
20. Error state cleanup — failed downloads set 'failed' state, clean up temp file, release semaphore slot

#### Open Items (new)
- Per-file `NSURLIsExcludedFromBackupKey` needs native bridge (Low) — tracked in open_security_items.md

### All Open Items (Phase 2 cumulative)
- #114: Key zeroization (`Vec<u8>` not wrapped in `Zeroizing`) — Medium
- #115: `plaintextHash` branded type guard — Low
- #122: `attachment_key` stored as base64 TEXT not BLOB — Low
- No FFI boundary integration test (Jest mocks the FFI) — Low
- No `AbortController` wired for upload cancellation on unmount — Low
- Per-file `NSURLIsExcludedFromBackupKey` needs native bridge — Low

### Backend Notes
- `completeUpload` fixed to use client `media_id` (was generating new UUID)
- Rate limit raised 100→500 req/15min (per-endpoint limits deferred)
- `express-rate-limit` v7 needs `validate: { xForwardedForHeader: false }` when behind nginx; `trust proxy: 1` alone is not sufficient for v7's stricter validation
