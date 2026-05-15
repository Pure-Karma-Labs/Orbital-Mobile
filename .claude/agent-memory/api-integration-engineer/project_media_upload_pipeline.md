---
name: project-media-upload-pipeline
description: End-to-end media upload pipeline — encryption, chunking, temp files, backend integration
metadata:
  type: project
---

## Media Upload Pipeline (verified 2026-05-14)

### Flow
1. Pick photo (react-native-image-picker, includeBase64: true)
2. Decode base64 → Uint8Array
3. Generate 64-byte attachment keys (CSPRNG)
4. Encrypt via Rust FFI (`attachmentEncrypt`) → ciphertext + digest + plaintextHash
5. Encrypt metadata (fileName, contentType, dimensions) with group key (AES-256-GCM)
6. Extract IV from ciphertext (first 16 bytes)
7. Chunk ciphertext into 5MB pieces
8. Write each chunk to temp file (`@dr.pogodin/react-native-fs`)
9. Upload via FormData with file-URI pattern: `{ uri: 'file://...', type, name }`
10. `POST /api/media/upload/complete` → media record created with client's `media_id`
11. Pass `mediaIds` to `postReply()` or `createNewThread()`

### Hermes Blob Workaround
Hermes does NOT support `new Blob([ArrayBuffer])`. Temp file + file-URI FormData pattern required.
Same pattern as avatar uploads in `profileService.ts`.

### Key Files
- `src/services/mediaUploadService.ts` — orchestration, `uploadMediaBatch` helper
- `src/services/api/media.ts` — `uploadChunk` (FormData), `completeUpload` (JSON)
- `src/services/crypto/attachmentCrypto.ts` — wraps Rust FFI
- `__mocks__/@dr.pogodin/react-native-fs.ts` — Jest mock

### Backend Contract
- `POST /api/media/upload/chunk` — multipart, field `chunk` as file part
- `POST /api/media/upload/complete` — JSON `{ media_id }`, uses client's ID as `media.id`
- Rate limit: 500 req/15min (raised from 100)
- Backend repo: `Pure-Karma-Labs/Orbital-Backend` (deployed at api.orbitl.org)

### DB Guard
`saveMedia()` wrapped in try/catch — Metro Fast Refresh resets DB singleton.
`setGroupMasterKey()` also guarded. Non-fatal in dev, no impact in production.
