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
 *
 * The hook also owns the one-session REUSE CACHE (#749): a send whose media
 * upload succeeded but whose create call failed keeps its media ids, so pressing
 * Send again attaches the SAME ids instead of re-uploading the batch (#724
 * amplifier). The cache is deliberately narrow -- see `uploadBatch` for the
 * hit conditions and `releaseUploadCache` for who drops it.
 *
 * #724b: ids that leave this hook without ever reaching a post are rolled back
 * rather than abandoned. Uploaded media commits locally with a NULL parent, and
 * FileLibrary surfaces every upload_state='done' row regardless of parent, so
 * an abandoned id is a permanent ghost. Three paths produce them: an item
 * deselected mid-upload, a cache entry superseded by a changed selection, and a
 * discarded post. All three funnel through `rollbackUploadedMedia`, which skips
 * anything that turns out to be attached.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  uploadMediaBatch,
  rollbackUploadedMedia,
  type UploadPhase,
} from '../services/mediaUploadService';
import type { UploadCacheDisposition } from '../services/media/uploadCacheDisposition';
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
     *
     * The same invariant is why the reuse cache keys on BOTH the array identity
     * of `items` and its uri sequence: a selection edit produces a new array, so
     * identity alone would already miss, and the uri check keeps a screen that
     * reuses an array reference from reattaching a deselected item's id.
     */
    getSelectedItems?: () => PickedMedia[],
    /**
     * Screen-scope discriminator for the reuse cache (thread id on
     * ThreadDetail, group id on Compose). A params-in-place `navigate` to
     * another thread keeps this component mounted, so without it the cached ids
     * would be attached to the wrong conversation's post.
     */
    scopeKey?: string,
  ) => Promise<string[]>;
  /**
   * Release the reuse cache, saying WHAT BECAME of the ids it holds. The
   * argument is required precisely so that every call site has to answer that
   * question (#724b): the previous `clearUploadCache()` dropped the ids
   * silently, which is what stranded them.
   *
   * | disposition | cache | hasUnsentUpload | rollback |
   * |---|---|---|---|
   * | `attached` | dropped | false | none |
   * | `discard` | dropped | false | yes, unless the entry is flagged |
   * | `committed` | KEPT + flagged | false | none |
   * | `maybe-committed` | KEPT + flagged | left as it was | none |
   *
   * The two "keep" arms differ ONLY in the guard, and that difference is the
   * point (Alex, PR #840 review): a 409 (`committed`) means the post almost
   * certainly exists, so there is nothing left for the discard guard to protect
   * and prompting on Back would be noise. A network or 5xx failure
   * (`maybe-committed`) leaves the user genuinely holding media that may never
   * have been attached, so the prompt must still appear — `hasUnsentUpload` is
   * left exactly as the batch set it rather than forced true, since a batch
   * whose ids were all deselected has nothing to warn about either.
   *
   * Both flag the entry, so a later `discard` drops the cache WITHOUT rolling
   * the ids back. Rolling back an id that WAS attached without the client
   * knowing is recoverable, but not free: `processMediaMetadata` re-materializes
   * the row and its `attachment_key` from the metadata envelope on the next
   * sync, so the media returns — the local plaintext copy has to be
   * re-downloaded.
   */
  releaseUploadCache: (disposition: UploadCacheDisposition) => void;
  /**
   * True while the cache holds uploaded-but-unattached media ids, i.e. the
   * post-failure state where leaving the screen would strand the upload. Drives
   * `useDiscardUploadGuard`'s `unsent` arm, so it is state-backed, not a ref.
   */
  hasUnsentUpload: boolean;
}

/** One-session reuse cache entry. Never persisted; dies with the screen. */
interface UploadCacheEntry {
  /** Identity of the array the ids were uploaded from. */
  source: PickedMedia[];
  /** Uri sequence of that array, captured at upload time. */
  uris: string[];
  groupId: string;
  scopeKey: string | undefined;
  /** The POST-FILTER ids -- exactly what the previous send would have attached. */
  mediaIds: string[];
  /**
   * A create carrying these ids failed in a way that may still have committed
   * (409 / network / 5xx). Suppresses the rollback on a later `discard`.
   */
  mayBeAttached?: boolean;
}

/**
 * Fire-and-forget rollback of ids that will never reach a post.
 *
 * Isolated from the caller twice over: the `Promise.resolve().then(...)` means
 * a SYNCHRONOUS throw from the service cannot unwind the send path, and the
 * `.catch` means a rejection cannot either. `rollbackUploadedMedia` already
 * swallows its own errors -- this is belt and braces on a path where a failure
 * to clean up must never become a failure to post.
 */
function scheduleRollback(mediaIds: string[]): void {
  if (mediaIds.length === 0) return;
  Promise.resolve()
    .then(() => rollbackUploadedMedia(mediaIds))
    .catch(() => {});
}

export function useMediaUploadProgress(): UseMediaUploadProgressResult {
  const [progress, setProgress] = useState<UploadProgressState | null>(null);
  const [hasUnsentUpload, setHasUnsentUpload] = useState(false);

  const mountedRef = useRef(true);
  /**
   * Reuse cache. Invalidated by a selection, uri, group or scope change (here),
   * by a successful create and by Discard (both via `releaseUploadCache`).
   * Deliberately NOT invalidated by a create failure: a 409 means the previous
   * create almost certainly committed, so a re-press must draw another 409
   * rather than upload a duplicate set, and a 404 means the thread is gone, so
   * re-uploading would only orphan more media.
   */
  const cacheRef = useRef<UploadCacheEntry | null>(null);
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

  const releaseUploadCache = useCallback((disposition: UploadCacheDisposition) => {
    const entry = cacheRef.current;
    switch (disposition) {
      case 'attached':
        cacheRef.current = null;
        if (mountedRef.current) setHasUnsentUpload(false);
        return;
      case 'discard':
        cacheRef.current = null;
        if (mountedRef.current) setHasUnsentUpload(false);
        // The flag is the whole reason the two "keep" arms exist: those ids are
        // probably on a post the client never saw confirmed, so they are left
        // alone rather than deleted and re-downloaded.
        if (entry && !entry.mayBeAttached) {
          scheduleRollback(entry.mediaIds);
        }
        return;
      case 'committed':
        // Cache KEPT -- a re-press must reuse these ids, not upload duplicates.
        // The post almost certainly exists, so the discard guard has nothing
        // left to protect and must not prompt on the way out.
        if (entry) entry.mayBeAttached = true;
        if (mountedRef.current) setHasUnsentUpload(false);
        return;
      case 'maybe-committed':
        // Same cache treatment, but hasUnsentUpload is left UNTOUCHED: the user
        // may still be holding media nothing has attached, so leaving the
        // screen must still raise "Discard unsent ...?".
        if (entry) entry.mayBeAttached = true;
        return;
    }
  }, []);

  const uploadBatch = useCallback(
    async (
      items: PickedMedia[],
      groupId: string,
      getSelectedItems?: () => PickedMedia[],
      scopeKey?: string,
    ): Promise<string[]> => {
      // Reuse check runs BEFORE the length gate, so an emptied selection still
      // drops a stale entry instead of leaving it to be hit later.
      const cached = cacheRef.current;
      if (cached) {
        const hit =
          cached.source === items
          && cached.groupId === groupId
          && cached.scopeKey === scopeKey
          && cached.uris.length === items.length
          && cached.uris.every((uri, i) => items[i]?.uri === uri);
        if (hit) {
          // No upload, so no progress is seeded and the discard guard's
          // `uploading` arm never flips -- the retry looks instant.
          return cached.mediaIds;
        }
        // Selection, uri, group or scope changed: the ids no longer describe
        // what the user is about to post, and nothing else can ever attach
        // them -- so this is a discard, rollback included (#724b).
        releaseUploadCache('discard');
      }

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
        let result = ids;
        if (stillSelected) {
          const selectedUris = new Set(stillSelected.map((m) => m.uri));
          const kept: string[] = [];
          const dropped: string[] = [];
          ids.forEach((id, i) => {
            const source = snapshot[i];
            const keep = source != null && selectedUris.has(source.uri);
            (keep ? kept : dropped).push(id);
          });
          result = kept;
          // A dropped id was uploaded and committed locally, but the post it
          // would have ridden on no longer references it -- nothing downstream
          // will ever attach it, so roll it back now (#724b).
          scheduleRollback(dropped);
        }

        // Cache the FILTERED ids: a retry must attach exactly what this send
        // would have attached. A superseded batch (isCurrent() false) never
        // writes -- its ids belong to a send the user already replaced.
        if (isCurrent()) {
          cacheRef.current = {
            source: items,
            uris: snapshot.map((m) => m.uri),
            groupId,
            scopeKey,
            mediaIds: result,
          };
          // Nothing selected survived the filter: there is no attachment left
          // to strand, so the discard guard has nothing to protect.
          if (mountedRef.current) setHasUnsentUpload(result.length > 0);
        }
        return result;
      } finally {
        if (isCurrent()) {
          abortRef.current = null;
          if (mountedRef.current) setProgress(null);
        }
      }
    },
    [releaseUploadCache],
  );

  return { progress, cancel, uploadBatch, releaseUploadCache, hasUnsentUpload };
}
