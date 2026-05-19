---
name: media-display-layer
description: Media display UI layer — MediaItemView, MediaGallery, MediaLightbox, barrel export caution, useMediaDownload ref guard, store selectors, adaptive gallery layouts
metadata:
  type: project
---

Media display layer landed as part of Media Chunk 3 implementation. Covers rendering downloaded media in threads and replies.

**Components (all in `src/components/`, imported directly — NOT via barrel):**
- `MediaItemView` — single media item renderer (image with blur hash placeholder, download state overlay). AUTO-DOWNLOADS on mount via useMediaDownload — only suitable for bounded lists (thread/reply inline media, 1-4 items)
- `MediaGallery` — adaptive layout grid for 1-N media items
- `MediaLightbox` — full-screen modal with paging ScrollView for swiping through media

**Barrel export caution:** These three components are deliberately excluded from `src/components/index.ts`. They import `useMediaDownload` which pulls in the download service chain (download service -> store -> MMKV -> NitroModules). Adding them to the barrel causes cascading test failures in unrelated screens that import from the barrel. Consuming components (ReplyItem, ThreadHeader) import them directly with relative paths.

**Why:** Barrel re-exports mean every test file that imports *any* component from the barrel also transitively imports the media download chain. Mocking becomes fragile and test isolation breaks.

**How to apply:** When building new media-consuming components, import MediaItemView/MediaGallery/MediaLightbox directly. Do not add them to the barrel. Same principle applies to any future component that imports heavy service chains.

**MediaGallery adaptive layouts:**
- 1 photo: full width, aspect ratio preserved (150-300px height cap)
- 2 photos: side-by-side equal squares
- 3 photos: L-shape layout (60/40 split)
- 4+ photos: 2x2 grid with "+N" overlay on the 4th cell when more than 4

**MediaLightbox known issue:** Currently eagerly renders all pages in the paging ScrollView. Tracked as issue #127 for lazy rendering optimization.

**useMediaDownload hook pattern:** Effect dependency array must NOT include `downloadState`. The download service synchronously updates store state to 'downloading', which triggers React re-render and effect cleanup, aborting the in-flight download request. Solution: use a `downloadingRef` ref guard to prevent re-entry, and only include `mediaId` and `hasKeys` in deps.

**Store selectors:** `useMediaForReply(replyId)` and `useMediaForThread(threadId)` exported from `src/stores/index.ts` using `useShallow`. These must be included in store mocks when testing screens that display media (ThreadHeader, ReplyItem).

**Store-first guard (setMediaBatch/setMediaForThread/setMediaForReply):** All three media store setters now check `existing?.downloadState === 'downloading'` and skip clobbering those entries. This prevents list reloads (FileLibraryScreen loadPage, thread detail refresh) from resetting in-flight download state, which would cause abort/restart loops in useMediaDownload.

**Screen integration:**
- `src/screens/threadDetail/ReplyItem.tsx` — uses `useMediaForReply`, renders MediaGallery + MediaLightbox below reply content
- `src/screens/threadDetail/ThreadHeader.tsx` — uses `useMediaForThread`, renders MediaGallery + MediaLightbox below thread content
- `src/screens/FileLibraryScreen.tsx` — does NOT use MediaItemView (auto-download unsafe for unbounded lists). Uses FileLibraryCell with download-on-tap pattern instead. See [[file-library-screen]].

Related: [[media-upload-pipeline]], [[file-library-screen]], [[zustand-stable-selectors]]
