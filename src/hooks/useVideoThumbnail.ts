/**
 * useVideoThumbnail — resolves video thumbnail state for display components.
 *
 * Given a media item's contentType and thumbnailMediaId, determines whether
 * the item is a video and resolves the thumbnail child's download state.
 *
 * Cold-start hydration: if the thumbnail child is not in the Zustand store
 * (e.g. app restart — only the network path hydrates children), a one-time
 * DB probe loads it.
 *
 * TRAP: parent MediaItem.thumbnailPath is a DANGLING sender-side staging path.
 * Never read thumbnailPath for display — always use the thumbnail child's
 * localPath via thumbnailMediaId.
 */

import { useEffect, useRef } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useMediaDownload } from './useMediaDownload';
import { isDatabaseInitialized } from '../database/connection';
import { getMedia } from '../database/repositories/mediaRepository';
import { mediaRowToItem } from '../database/repositories/mediaMapper';
import type { MediaItem } from '../types/store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseVideoThumbnailResult {
  /** Whether the media item is a video (contentType starts with 'video/'). */
  isVideo: boolean;
  /** Thumbnail download state, or 'unavailable' if no thumbnail exists/resolvable. */
  thumbState: MediaItem['downloadState'] | 'unavailable';
  /** Local file path of the downloaded thumbnail, or null. */
  thumbLocalPath: string | null;
  /** Retry function — delegates to useMediaDownload's retry. */
  retryThumb: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVideoThumbnail(
  contentType: string | undefined,
  thumbnailMediaId: string | null | undefined,
): UseVideoThumbnailResult {
  const isVideo = !!contentType?.startsWith('video/');
  const thumbId = isVideo ? (thumbnailMediaId ?? null) : null;

  // Subscribe to thumbnail child in the store (no-ops for null thumbId)
  const thumbItem = useAppStore((s) => (thumbId ? s.media[thumbId] : undefined));

  // Cold-start DB probe — exactly once per mount
  const hasProbed = useRef(false);

  useEffect(() => {
    if (!thumbId) return;
    if (hasProbed.current) return;
    if (thumbItem) return; // already in store — no probe needed

    hasProbed.current = true;

    if (!isDatabaseInitialized()) return; // DB not ready — treat as unavailable

    try {
      const row = getMedia(thumbId);
      if (row) {
        useAppStore.getState().upsertMedia(mediaRowToItem(row));
      }
    } catch {
      // DB error — latch unavailable, don't crash
    }
  }, [thumbId, thumbItem]);

  // Delegate to useMediaDownload for auto-download of the thumbnail child.
  // No-ops for null or absent items; auto-downloads pending+hasKeys once hydrated.
  const { downloadState, localPath, retry } = useMediaDownload(thumbId);

  // Result mapping
  if (!isVideo) {
    return {
      isVideo: false,
      thumbState: 'unavailable',
      thumbLocalPath: null,
      retryThumb: noop,
    };
  }

  if (!thumbId) {
    // No thumbnail child — e.g. thumbnail extraction failed at upload
    return {
      isVideo: true,
      thumbState: 'unavailable',
      thumbLocalPath: null,
      retryThumb: noop,
    };
  }

  if (!thumbItem) {
    // Not in store (probe may have failed or DB not ready)
    return {
      isVideo: true,
      thumbState: 'unavailable',
      thumbLocalPath: null,
      retryThumb: noop,
    };
  }

  if (!thumbItem.hasKeys) {
    // Receiver hasn't received attachment keys yet
    return {
      isVideo: true,
      thumbState: 'unavailable',
      thumbLocalPath: null,
      retryThumb: noop,
    };
  }

  return {
    isVideo: true,
    thumbState: downloadState,
    thumbLocalPath: localPath,
    retryThumb: retry,
  };
}

function noop(): void {}
