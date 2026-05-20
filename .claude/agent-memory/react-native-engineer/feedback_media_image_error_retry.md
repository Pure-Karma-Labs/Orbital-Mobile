---
name: media-image-error-retry
description: MediaItemView uses onError with useRef retry counter — max 1 auto-retry then sets 'failed' state to prevent infinite render loops on corrupt image files
metadata:
  type: feedback
---

`MediaItemView` has an `onError` handler on `<Image>` that uses a `useRef` counter (`imageErrorCount`). On first error, it resets the media to 'pending' + null localPath (triggers re-download). On second error (counter > 1), it sets downloadState to 'failed' to break the loop.

Pattern:
```
imageErrorCount.current += 1;
if (imageErrorCount.current > 1) {
  updateMediaDownloadState(mediaId, 'failed');  // stop the loop
  return;
}
upsertMedia({ ...existing, downloadState: 'pending', localPath: null });
```

`processMediaMetadata` also checks file existence via `exists()` when the DB row says 'downloaded' — resets to 'pending' if the file is missing (handles simulator switches, reinstalls, or OS cache eviction).

The "Unavailable" fallback state should always show "Tap to retry" with the retry function from useMediaDownload.

**Why:** Without the counter cap, a corrupt file would cycle between download -> render error -> re-download infinitely. Without the file existence check, stale DB rows from prior simulator sessions would show broken images.

**How to apply:** Any component rendering downloaded files should have an error handler with a retry cap. Never assume a 'downloaded' DB state means the file actually exists on disk.

Related: [[media-display-layer]], [[use-media-download-deps]]
