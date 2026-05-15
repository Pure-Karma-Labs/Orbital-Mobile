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

  // Auto-trigger download when pending and has keys
  useEffect(() => {
    if (!mediaId || !item) return;
    if (item.downloadState !== 'pending' || !item.hasKeys) return;

    const controller = new AbortController();
    abortRef.current = controller;

    downloadAndDecryptMedia(mediaId, controller.signal).catch(() => {
      // Errors are handled by the download service (state set to 'failed')
    });

    return () => {
      controller.abort();
      abortRef.current = null;
    };
  }, [mediaId, item?.downloadState, item?.hasKeys]); // eslint-disable-line react-hooks/exhaustive-deps

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
