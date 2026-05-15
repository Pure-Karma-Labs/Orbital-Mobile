---
name: media-upload-pipeline
description: Media upload pipeline — useMediaPicker, uploadMediaBatch, temp file pattern for Hermes Blob workaround, ReplyComposer + ComposeThreadScreen integration
metadata:
  type: project
---

Media upload pipeline landed (PRs #117, #120, #121, #124 and follow-up fixes through commit 8049701).

**Architecture:**
- `useMediaPicker` hook wraps `react-native-image-picker` for photo library and camera access
- `MediaThumbnailStrip` renders selected media as horizontal thumbnail strip with remove buttons
- `uploadMediaBatch()` (in service layer) handles chunked upload with attachment crypto
- Screens use upload-then-post pattern: pick media -> upload batch -> post with mediaIds

**Hermes workaround:** Hermes cannot create `Blob` from `ArrayBuffer`, so media chunks are written to temp files via `@dr.pogodin/react-native-fs` and uploaded using file URIs in FormData. See [[hermes-no-blob-workaround]].

**ReplyComposer changes:** 3 new optional props (`media`, `onPickMedia`, `onRemoveMedia`). Camera emoji button added to input row. `sending` prop receives folded `sending || uploading` from parent — no separate uploading prop exposed. Text clear moved to parent (on success only).

**iOS permissions:** `NSPhotoLibraryUsageDescription` and `NSCameraUsageDescription` added to Info.plist.

**How to apply:** When building features that attach media to threads or replies, follow the established upload-then-post pattern. Do not attempt Blob-based uploads on Hermes — always use the temp file approach.
