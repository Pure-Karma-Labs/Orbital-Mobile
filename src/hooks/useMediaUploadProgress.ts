/**
 * useMediaUploadProgress -- owns the composer-side upload lifecycle: the abort
 * controller, the progress snapshot, cancellation, and the mount guard.
 *
 * Both composers (ComposeThreadScreen and ThreadDetailScreen/ReplyComposer)
 * use this so their semantics cannot drift apart again -- ComposeThreadScreen
 * previously had no mount guard and no unmount abort at all.
 *
 * Behaviour change this introduces, deliberately: navigating away mid-upload now
 * ABORTS the upload, so the post/reply that was waiting on it is never created.
 * Previously both completed silently after the screen was gone. The service
 * rolls the local half of any completed batch items back, so a cancel leaves no
 * thread-less ghost rows in the file library.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  uploadMediaBatch,
  type UploadPhase,
} from '../services/mediaUploadService';
import type { PickedMedia } from './useMediaPicker';

export interface UploadProgressState {
  /** Batch-overall 0-1: (itemIndex + itemFraction) / itemCount. Monotonic across the post. */
  fraction: number;
  phase: UploadPhase;
  /** Ciphertext bytes sent for the CURRENT item, or null outside the upload phase. */
  bytesSent: number | null;
  /** Total ciphertext bytes for the CURRENT item, or null before it is known. */
  totalBytes: number | null;
  itemIndex: number;
  itemCount: number;
  /** Cancel requested; the current item may still be finishing (completeUpload is unsignalled). */
  cancelling: boolean;
}

export interface UseMediaUploadProgressResult {
  /** Null when idle. */
  progress: UploadProgressState | null;
  cancel: () => void;
  uploadBatch: (
    items: PickedMedia[],
    groupId: string,
    /**
     * Live view of the still-selected items, read AFTER the batch resolves.
     * Ids whose source item is no longer selected are dropped from the result:
     * the batch captured `items` by reference, so without this a thumbnail
     * removed mid-upload would still be attached to the post. The strip's
     * `disabled` prop is the UI guard; this filter is the invariant.
     */
    getSelectedItems?: () => PickedMedia[],
  ) => Promise<string[]>;
}

export function useMediaUploadProgress(): UseMediaUploadProgressResult {
  const [progress, setProgress] = useState<UploadProgressState | null>(null);

  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Reentrancy epoch. A second batch started while one is in flight would
   * orphan batch 1's controller, and batch 1's `finally` would then wipe batch
   * 2's progress. Every async callback no-ops unless its captured generation is
   * still current. (Same epoch-abort shape as the notification-settings hooks.)
   */
  const generationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Dedicated unmount-abort effect, declared separately from the mount guard so
  // the abort is not coupled to any dependency change (see useMediaDownload's
  // cleanup-race notes -- a cleanup that also runs on a dep change would fire a
  // spurious abort mid-upload).
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const cancel = useCallback(() => {
    const controller = abortRef.current;
    if (!controller || controller.signal.aborted) return;
    // Flip the label FIRST: completeUpload() takes no signal, so an abort after
    // the last chunk cannot stop the item. The UI must say "Cancelling…" rather
    // than pretend it already stopped.
    if (mountedRef.current) {
      setProgress((prev) => (prev ? { ...prev, cancelling: true } : prev));
    }
    controller.abort();
  }, []);

  const uploadBatch = useCallback(
    async (
      items: PickedMedia[],
      groupId: string,
      getSelectedItems?: () => PickedMedia[],
    ): Promise<string[]> => {
      // Nothing to upload: seeding progress here would divide by an itemCount of 0.
      if (items.length === 0) return [];

      if (abortRef.current !== null) {
        throw new Error('An upload is already in progress.');
      }

      const generation = ++generationRef.current;
      const isCurrent = (): boolean => generationRef.current === generation;

      const controller = new AbortController();
      abortRef.current = controller;

      // Snapshot: the service iterates this exact array, so the returned ids are
      // positionally aligned with it regardless of what the picker does next.
      const snapshot = items.slice();

      if (mountedRef.current) {
        setProgress({
          fraction: 0,
          phase: snapshot[0].type.startsWith('video/') ? 'compressing' : 'encrypting',
          bytesSent: null,
          totalBytes: null,
          itemIndex: 0,
          itemCount: snapshot.length,
          cancelling: false,
        });
      }

      try {
        const ids = await uploadMediaBatch(snapshot, groupId, {
          signal: controller.signal,
          onProgress: (e) => {
            if (!mountedRef.current || !isCurrent()) return;
            setProgress((prev) => ({
              fraction: e.itemCount > 0 ? (e.itemIndex + e.fraction) / e.itemCount : 0,
              phase: e.phase,
              bytesSent: e.bytesSent ?? null,
              totalBytes: e.totalBytes ?? null,
              itemIndex: e.itemIndex,
              itemCount: e.itemCount,
              cancelling: prev?.cancelling ?? false,
            }));
          },
        });

        const stillSelected = getSelectedItems?.();
        if (!stillSelected) return ids;
        const selectedUris = new Set(stillSelected.map((m) => m.uri));
        return ids.filter((_id, i) => {
          const source = snapshot[i];
          return source != null && selectedUris.has(source.uri);
        });
      } finally {
        if (isCurrent()) {
          abortRef.current = null;
          if (mountedRef.current) setProgress(null);
        }
      }
    },
    [],
  );

  return { progress, cancel, uploadBatch };
}
