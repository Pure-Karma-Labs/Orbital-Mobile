---
name: audit-coverage-phase2
description: Phase 2 security audit coverage — media upload pipeline, attachment crypto FFI, backend fixes
metadata:
  type: project
---

## Phase 2 Audit Coverage (2026-05-14)

### PRs/Commits Reviewed
- #113: Media foundation (attachment crypto, API client, repository, store)
- #117: Media upload pipeline + picker integration (Chunk 2)
- #121: Reply media picker integration
- #124: Rust native bindings for attachment crypto

### Positive Verifications
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

### Open Items
- #114: Key zeroization (`Vec<u8>` not wrapped in `Zeroizing`)
- #115: `plaintextHash` branded type guard
- #122: `attachment_key` stored as base64 TEXT not BLOB
- No FFI boundary integration test (Jest mocks the FFI)
- No `AbortController` wired for upload cancellation on unmount

### Backend Notes
- `completeUpload` fixed to use client `media_id` (was generating new UUID)
- Rate limit raised 100→500 req/15min (per-endpoint limits deferred)
