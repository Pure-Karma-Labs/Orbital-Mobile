---
name: use-media-download-deps
description: useMediaDownload effect deps must NOT include downloadState — causes abort loop; use ref guard instead
metadata:
  type: feedback
---

In `useMediaDownload` (and similar download/upload hooks), the useEffect dependency array must NOT include the reactive state being updated by the async operation (e.g., `downloadState`).

**Why:** The download service synchronously updates the Zustand store state to 'downloading' when a download starts. This triggers a React re-render, which runs effect cleanup, which aborts the in-flight download request. The effect then re-runs, sees 'pending' again (because the download was aborted), and starts a new download — creating an infinite abort-restart loop.

**How to apply:** Use a ref guard (`downloadingRef = useRef(false)`) to prevent re-entry into the download effect. Only include stable identifiers (`mediaId`, `hasKeys`) in the effect deps — not the download state itself. The ref guard pattern:
1. Check `if (downloadingRef.current) return;` at effect start
2. Set `downloadingRef.current = true` before starting download
3. Set `downloadingRef.current = false` in both success and error paths

This pattern applies to any hook where an async operation updates the same store state that the hook observes.

Related: [[media-display-layer]]
