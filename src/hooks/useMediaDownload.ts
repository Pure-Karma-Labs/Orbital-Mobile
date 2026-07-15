/**
 * useMediaDownload — auto-download hook for media items.
 *
 * Reads a MediaItem from the Zustand store reactively and auto-triggers
 * download when the item is pending and has attachment keys.
 *
 * Exposes a retry() function for failed downloads.
 * Cleanup via AbortController on unmount.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { downloadAndDecryptMedia, retryDownload } from '../services/mediaDownloadService';
import type { MediaItem } from '../types/store';

export interface UseMediaDownloadOptions {
  /**
   * Abort queued downloads on unmount.
   *
   * Invariant: abortRef is nulled at the pending->downloading transition
   * (post-acquire), so this only cancels downloads still waiting for a
   * semaphore slot. Under React 19 concurrent batching an in-flight abort
   * is theoretically possible but benign (state restores to 'pending' and
   * the next mount self-heals).
   *
   * This option must be static for the component instance's lifetime --
   * a runtime true->false toggle would fire a spurious abort via the
   * true-phase cleanup.
   */
  cancelOnUnmount?: boolean;
}

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
 * @param options - Optional configuration for unmount cancellation behavior.
 * @returns Current download state, local path, key availability, and retry function.
 */
export function useMediaDownload(
  mediaId: string | null,
  options?: UseMediaDownloadOptions,
): UseMediaDownloadResult {
  const cancelOnUnmount = options?.cancelOnUnmount ?? false;

  const item = useAppStore(
    (state) => (mediaId ? state.media[mediaId] : undefined),
  );

  const abortRef = useRef<AbortController | null>(null);
  const downloadingRef = useRef(false);

  // Bumped when an abort-then-remount joins a stale inflight promise that
  // rejects. Forces the download effect to re-run against a clean inflight map.
  const [retryAttempt, setRetryAttempt] = useState(0);

  // Auto-trigger download when pending and has keys.
  // Only mediaId and hasKeys in deps — NOT downloadState, because the
  // download service synchronously updates state to 'downloading' which
  // would cause React to re-run cleanup (aborting the in-flight request).
  const shouldDownload = item?.downloadState === 'pending' && item?.hasKeys;

  // Unmount-cancel effect -- declared BEFORE the download effect because
  // React runs cleanup functions in declaration order. The download effect's
  // cleanup nulls abortRef, so cancel must run first.
  useEffect(() => {
    if (!cancelOnUnmount) return undefined;
    return () => {
      abortRef.current?.abort();
    };
  }, [cancelOnUnmount]);

  useEffect(() => {
    if (!mediaId || !shouldDownload) return;
    if (downloadingRef.current) return;

    downloadingRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;

    let rejected = false;

    downloadAndDecryptMedia(mediaId, controller.signal)
      .catch(() => {
        // Errors are handled by the download service (state set to 'failed'
        // or restored to 'pending' for aborted downloads).
        rejected = true;
      })
      .finally(() => {
        downloadingRef.current = false;
        // If cancelOnUnmount is active, the promise rejected, and our OWN
        // controller was not the one aborted (we joined someone else's
        // stale inflight entry), bump retryAttempt so the effect re-runs
        // against a now-clean inflight map. Naturally bounded: each re-run
        // creates a fresh controller; if the item is no longer 'pending'
        // the effect no-ops via shouldDownload.
        if (cancelOnUnmount && rejected && !controller.signal.aborted) {
          setRetryAttempt((n) => n + 1);
        }
      });

    return () => {
      if (!downloadingRef.current) {
        controller.abort();
      }
      abortRef.current = null;
    };
  }, [mediaId, shouldDownload, retryAttempt, cancelOnUnmount]);

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
