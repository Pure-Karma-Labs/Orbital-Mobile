---
name: project-media-state-ownership
description: Media state ownership rules — upload service owns initial state, Zustand is authoritative at runtime, DB is cross-session persistence
metadata:
  type: project
---

## Media State Ownership (established 2026-05-15)

### Rule

The upload service (`mediaUploadService.ts`) owns the initial `MediaItem` with `hasKeys: true`, `localPath` set, and `downloadState: 'downloaded'`. No other code path may overwrite these fields for items the upload service has already created.

**Why:** When a user sends a photo, the upload service creates a fully-resolved MediaItem (keys, local path, downloaded state) before the server even returns. If `processMediaMetadata` later receives the same mediaId from the server response and overwrites the store entry, the sender loses their local file reference and sees a "pending download" placeholder for their own photo.

**How to apply:**
- In `processMediaMetadata`: always check Zustand store first. If the item exists there, use it — do not re-derive from server metadata.
- In download service: only process items where `downloadState === 'pending'`. Never re-download items that are already `'downloaded'`.
- When persisting to DB: use upsert semantics that preserve `attachment_key`, `local_path`, and `download_state` if they already have values.

### Runtime vs Persistence

| Layer | Role | Authoritative? |
|-------|------|---------------|
| Zustand store (`store.media`) | Runtime state, fast reads | Yes, during session |
| SQLite (`media` table) | Cross-session persistence | Yes, on cold start only |

On cold start, the DB hydrates the store. During runtime, the store is the single source of truth. Any function that reads media state should check the store first.

### Related

- [[project-process-media-metadata]] — enforces store-before-DB lookup order
- [[project-media-upload-pipeline]] — creates the initial authoritative state
- [[project-media-download-service]] — consumes pending items, never overwrites downloaded items
