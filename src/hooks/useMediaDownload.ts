/**
 * useMediaDownload — auto-download hook for media items.
 *
 * Reads a MediaItem from the Zustand store reactively and auto-triggers
 * download when the item is pending and has attachment keys.
 *
 * Exposes a retry() function for failed downloads.
 * Cleanup via AbortController on unmount.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { downloadAndDecryptMedia, retryDownload } from '../services/mediaDownloadService';
import type { MediaItem } from '../types/store';

export interface UseMediaDownloadResult {
  downloadState: MediaItem['downloadState'];
  localPath: string | null;
  hasKeys: boolean;
  retry: () => void;
}

/**
 * Hook that manages media download lifecycle for a single media item.
 *
 * @param mediaId - The media ID to track, or null to skip.
 * @returns Current download state, local path, key availability, and retry function.
 */
export function useMediaDownload(
  mediaId: string | null,
): UseMediaDownloadResult {
  const item = useAppStore(
    (state) => (mediaId ? state.media[mediaId] : undefined),
  );

  const abortRef = useRef<AbortController | null>(null);
  const downloadingRef = useRef(false);

  // Auto-trigger download when pending and has keys.
  // Only mediaId and hasKeys in deps — NOT downloadState, because the
  // download service synchronously updates state to 'downloading' which
  // would cause React to re-run cleanup (aborting the in-flight request).
  const shouldDownload = item?.downloadState === 'pending' && item?.hasKeys;

  useEffect(() => {
    if (!mediaId || !shouldDownload) return;
    if (downloadingRef.current) return;

    downloadingRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;

    downloadAndDecryptMedia(mediaId, controller.signal)
      .catch(() => {
        // Errors are handled by the download service (state set to 'failed')
      })
      .finally(() => {
        downloadingRef.current = false;
      });

    return () => {
      if (!downloadingRef.current) {
        controller.abort();
      }
      abortRef.current = null;
    };
  }, [mediaId, shouldDownload]);

  const retry = useCallback(() => {
    if (!mediaId) return;

    // Cancel any in-flight request
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;

    retryDownload(mediaId, controller.signal).catch(() => {
      // Errors are handled by the download service (state set to 'failed')
    });
  }, [mediaId]);

  return {
    downloadState: item?.downloadState ?? 'pending',
    localPath: item?.localPath ?? null,
    hasKeys: item?.hasKeys ?? false,
    retry,
  };
}
