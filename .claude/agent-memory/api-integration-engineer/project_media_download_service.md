---
name: project-media-download-service
description: mediaDownloadService.ts and useMediaDownload.ts — download/decrypt/cache pipeline with semaphore, dedup, atomic writes
metadata:
  type: project
---

## Media Download Service (added 2026-05-15)

### Key Files

- `src/services/mediaDownloadService.ts` — orchestration: download, decrypt, cache
- `src/hooks/useMediaDownload.ts` — React hook for components to trigger/observe downloads

### Download Flow

1. Cache check — if `local_path` set in DB and file exists on disk, return immediately
2. Key check — if `attachment_key` is null, throw (caller shows "no keys" placeholder)
3. Inflight dedup — `Map<string, Promise<string>>` prevents duplicate concurrent downloads
4. Semaphore — max 3 concurrent downloads (`MAX_CONCURRENT = 3`)
5. State update to `'downloading'` in both DB and Zustand store
6. Download via `downloadMedia()` from `src/services/api/media.ts` → `ArrayBuffer`
7. Decrypt via `decryptAttachment(ciphertext, keys, digest)`
8. Atomic write — `.tmp` file + `moveFile` to final path (prevents partial plaintext on crash)
9. Persist `'downloaded'` + `localPath` in both DB and store
10. Error → set `'failed'` state, clean up temp file, release semaphore

### Security Properties

- Ciphertext ArrayBuffer released before base64 encoding
- Atomic write prevents partial plaintext files on crash
- Inflight dedup map clears in finally block

### Relationship to Upload Pipeline

The upload service creates `MediaItem` with `hasKeys: true`, `downloadState: 'downloaded'`, and `localPath` already set (the sender already has the file). The download service only activates for items where `downloadState === 'pending'` — i.e., media received from other users.

### Related

- [[project-process-media-metadata]] — creates the initial MediaItem that download service later processes
- [[project-media-upload-pipeline]] — upload creates items that don't need downloading
- [[project-media-state-ownership]] — store is authoritative; DB is persistence
