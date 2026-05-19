---
name: project-process-media-metadata
description: processMediaMetadata orchestration pattern — 7 call sites, session dedup, store-before-DB lookup, upload-service ownership guard
metadata:
  type: project
---

## processMediaMetadata Pattern (verified 2026-05-15)

`processMediaMetadata` in `src/services/threadService.ts` is the single funnel for turning backend `MediaMetadata` into runtime `MediaItem` objects in the Zustand store (and persisting to SQLite).

### Call Sites (7 total)

In `src/services/threadService.ts`:
1. `mapThreadResponse` — maps a single ThreadResponse
2. `mapReplyResponse` — maps a single ReplyResponse
3. `loadReplies` — processes thread-level media from the list-replies endpoint
4. `postReply` — processes media returned in CreateReplyResponse
5. `createNewThread` — processes media returned in CreateThreadResponse

In `src/services/websocket/messageHandler.ts`:
6. `handleNewThread` — real-time push for new threads
7. `handleNewReply` — real-time push for new replies

All calls are fire-and-forget (`.catch(warn)`) so they never block thread/reply rendering.

### Session-Level Dedup

A module-scope `Set<string>` (`processedMediaIds`) prevents redundant processing when multiple call sites fire for the same mediaId in one session. After dedup, the function still wires the existing `MediaItem` into the correct thread/reply index via `setMediaForThread`/`setMediaForReply`.

**Why:** The same media can arrive through `mapThreadResponse` (initial load), `loadReplies` (pagination), and `handleNewThread` (WebSocket push) within seconds. Without dedup, each would decrypt metadata and hit DB unnecessarily.

**How to apply:** When adding a new call site (e.g., a thread-refresh or prefetch path), call `processMediaMetadata` with the same fire-and-forget pattern. The dedup Set handles the rest. Do NOT reset the Set — it lives for the session lifetime.

### Store-Before-DB Invariant

The lookup order inside `processMediaMetadata` is:
1. Check Zustand store (`store.media[mediaId]`) — if found, use it as-is
2. Check SQLite DB (`getMedia(mediaId)`) — if found, convert and use
3. Otherwise, decrypt metadata envelope and create a new row

**Why:** The upload service (`mediaUploadService.ts`) creates the initial `MediaItem` with `hasKeys: true`, `localPath` set, and `downloadState: 'downloaded'`. If processMediaMetadata checked DB first or re-derived from the server response, it would overwrite this with `hasKeys: false`, `localPath: null`, `downloadState: 'pending'` — destroying the sender's ability to view their own upload.

**How to apply:** Never reorder the store-then-DB lookup. The Zustand store is authoritative at runtime; DB is for cross-session persistence only. See also [[project-media-state-ownership]].

### Retroactive Key Recovery (added 2026-05-18)

When an existing DB row has `attachment_key == null` and the incoming media has `encryptedMetadata`, the function now attempts to decrypt the metadata envelope, validate the embedded key (64-byte length check), and update the row. This covers the case where rows were created before attachment keys were embedded in the envelope.

### Metadata Envelope v1 Format

After group-key decryption, the `encryptedMetadata` payload is now a versioned envelope:
```
{ v: 1, fileName, contentType, width, height, duration, blurHash, attachmentKey }
```
- `attachmentKey` is base64-encoded (64 bytes decoded = 32 AES + 32 HMAC)
- `v: 1` distinguishes from pre-envelope data that lacked `attachmentKey`
- Extraction and validation happens in `decryptMediaMetadataEnvelope()` and `normalizeAttachmentKey()` in threadService.ts

See also [[project-media-upload-pipeline]].

### Related

- [[project-media-upload-pipeline]] — upstream: upload service creates the initial MediaItem
- [[project-media-download-service]] — downstream: download service consumes MediaItems with `downloadState: 'pending'`
- [[project-db-resilience-pattern]] — `isDatabaseInitialized()` guard wraps all DB calls in this function
