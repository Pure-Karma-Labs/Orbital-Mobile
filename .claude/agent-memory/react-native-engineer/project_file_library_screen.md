---
name: file-library-screen
description: FileLibraryScreen — browse all media across orbits with download-on-tap, paginated DB queries, server quota, and filter/sort pills
metadata:
  type: project
---

FileLibraryScreen is a new screen accessible from Settings > File Library (pushed via SettingsStackNavigator). It displays all media across all orbits in a paginated 3-column grid.

**Key architectural decision: download-on-tap, not auto-download.**
FileLibraryCell is a lightweight grid cell that does NOT use MediaItemView or the useMediaDownload hook. Instead it shows blurHash/placeholder for non-downloaded items and triggers `downloadAndDecryptMedia` only when the user taps a cell. After download completes, the lightbox opens automatically.

**Why:** MediaItemView auto-downloads on mount via useMediaDownload. In an unbounded paginated list, this would trigger mass concurrent downloads as the user scrolls. Download-on-tap ensures only user-requested media is downloaded.

**How to apply:** When building any new screen that displays an unbounded list of media (search results, shared media view, etc.), follow the FileLibraryCell pattern — render placeholder/thumbnail, download only on tap. Reserve MediaItemView for bounded inline contexts (thread/reply media, typically 1-4 items).

**Data flow:**
- DB queries: `getAllMedia()` with pagination (PAGE_SIZE=30), content type filter, orbit filter, and sort (date/size x asc/desc)
- Store hydration: `setMediaBatch(items)` after each page load so MediaLightbox (which uses useMediaDownload internally) can find items
- Server quota: `getGroupQuota(activeConversationId)` fetched on mount, rendered via QuotaBar
- Orbit filter options: `getMediaConversationIds()` resolves which conversations have media, then names from store

**recoverStalePaths reconciliation:** After each loadPage, async calls `recoverStalePaths(rows)` which checks if files exist on disk for items not marked as downloaded. Updates DB + store + local component state for any recovered files. Handles edge case of reinstall/cache clear where DB was restored but download_state wasn't updated.

**mediaMapper.ts extraction:** `mediaRowToItem` and `normalizeAttachmentKey` were extracted from threadService.ts into `src/database/repositories/mediaMapper.ts` so FileLibraryScreen can convert DB rows to store items without importing the full crypto/API service chain.

Related: [[media-display-layer]], [[zustand-stable-selectors]]
