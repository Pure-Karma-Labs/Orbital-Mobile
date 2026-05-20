---
name: feedback-image-onerror-retry
description: React Native Image onError must have a retry counter to prevent infinite render loops on corrupt files
metadata:
  type: feedback
---

## Image onError Retry Counter Pattern

`onError` on `<Image>` components that trigger automatic re-download must include a retry counter (typically `useRef<number>`) to prevent infinite render loops when the local file is corrupt.

**Why:** Without the counter, corrupt-but-existing files cause an infinite loop: Image error -> reset state to 'pending' -> re-download returns same corrupt path -> Image error -> repeat. This is a tight synchronous render loop that freezes the UI.

**How to apply:** When reviewing any `<Image>` component with an `onError` handler that triggers a re-download or state reset:
- Verify there is a `useRef` counter limiting retries (max 1 auto-retry is sufficient)
- After the retry limit is hit, the state must be set to `'failed'` (not reset to `'pending'`)
- Flag missing retry counters as Medium severity (denial-of-service via corrupt media)
- This applies to `FileLibraryCell`, `MediaThumbnail`, and any future image display components with auto-retry behavior
