/**
 * mediaExportService — saving decrypted media and files OUT of Orbital (#878).
 *
 * THIS IS THE ONLY MODULE IN THE APP THAT MAY IMPORT `orbital-media-export`.
 * Enforced by the `media-export-import-restricted` rule in
 * `scripts/check-security-invariants.mjs`. Everything above this layer —
 * MediaLightbox today, the bulk runner in PR 2 — goes through the functions
 * below, so there is exactly one place where plaintext leaves the app.
 *
 * ## The three gates, in order
 *
 *  1. **Disclosure.** `ensureExportDisclosure()` runs BEFORE anything else,
 *     including before any download. A saved copy is plaintext on the device,
 *     may be swept into the user's own cloud backup, is readable by any app
 *     with photo or file access, and survives logout and account deletion.
 *     That is a material change to the app's promise, so it is acknowledged
 *     once per signed-in user. `performExport()` re-asserts the flag
 *     synchronously, so a future caller cannot reach a native write by
 *     forgetting step 1 — the assertion throws rather than prompting, because
 *     a prompt from inside the write path would be a modal in the wrong place.
 *  2. **Permission**, also before any download: being asked for photo access
 *     only to then be told the file could not be fetched is a worse sequence,
 *     and a denied permission means there is nothing to download FOR.
 *  3. **Access.** An item may be saved iff its resolved conversation is one
 *     the signed-in user is currently in. Checked before the download and
 *     again after it, because a download is long enough for an orbit to be
 *     left, a DM to be removed, or the account to be deleted.
 *
 * ## Routing
 *
 * Closed allowlists in `media/exportFileName.ts`, keyed on `content_type`:
 * photo-library types go to the gallery, a fixed document set goes to the
 * Files picker (iOS) or `Download/Orbital` (Android), everything else is
 * REFUSED. Our composer only posts photos and videos, so any other type on a
 * row is peer-crafted — see that module's header.
 *
 * ## Labelling: declared type routes, bytes label (#880)
 *
 * Routing, refusal and the permission prompt all run on the DECLARED
 * `content_type`, before the download. The copy's MIME and extension are then
 * corrected from the decrypted bytes by `resolveExportLabel` below, which is
 * the ONLY place a label is computed: ANY entry point that reaches
 * `performExport` — `saveMediaItem` today, the bulk runner in PR 2 — must
 * label through it. The kind (`photo` vs `document`) stays fixed, because the
 * permission was acquired for that kind.
 *
 * The byte check is PERMANENT, not a migration. `content_type` is
 * peer-supplied, so a wrong label can arrive from any client at any time; the
 * upload-side relabel in `mediaUploadService` only keeps THIS client's future
 * rows honest.
 *
 * ## Logging
 *
 * `if (__DEV__) console.warn('[mediaExport]', code)` and nothing else. No
 * file name, display name, path or media id is ever logged or sent to Sentry;
 * `captureError` receives a fixed Error plus the error CODE as a tag. Pinned
 * by the `media-export-no-name-logging` invariant, which reads this file, the
 * two pure leaves it labels through (`media/exportFileName.ts` and
 * `media/contentType.ts`, which must contain NO log or Sentry call at all),
 * `media/abortable.ts`, and the package's own two TS files
 * (`src/index.tsx`, `src/NativeOrbitalMediaExport.ts`).
 */

import { Alert, Linking, PermissionsAndroid, Platform } from 'react-native';
import { CachesDirectoryPath, exists, read, stat, unlink } from '@dr.pogodin/react-native-fs';
import {
  exportFiles,
  isMediaExportError,
  requestPhotoAddPermission,
  saveToPhotoLibrary,
  type MediaExportErrorCode,
} from 'orbital-media-export';
import {
  getMedia,
  getMediaExportAccess,
  type MediaRow,
} from '../database/repositories/mediaRepository';
import { captureError } from './telemetry';
import {
  downloadAndDecryptMedia,
  DOWNLOAD_ABORTED_MESSAGE,
  InsufficientSpaceError,
} from './mediaDownloadService';
import { AuthError, NotFoundError } from './api/errors';
import { abortable, isExportAbortError } from './media/abortable';
import { isBlockedAuthor, isExportableConversation } from './media/exportAccess';
import {
  buildExportFileName,
  reconcileExportLabel,
  resolveExportRoute,
} from './media/exportFileName';
import { SNIFF_HEAD_BYTES, sniffContentType } from './media/contentType';
import { base64ToUint8Array } from './crypto/utils';
import { createSemaphore } from '../utils/semaphore';

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

/**
 * Outcome of one save attempt.
 *
 * - `saved`       — the copy exists on the device.
 * - `cancelled`   — the user backed out (disclosure, Files picker) or we
 *                   aborted (lightbox closed, wipe, bulk cancel).
 * - `unavailable` — the server evicted it and there is no local copy.
 * - `notAllowed`  — orphaned, or no longer in a conversation the user is in.
 * - `noSpace`     — not enough free space to download or to write the copy.
 * - `permission`  — photo-library or storage access refused.
 * - `unsupported` — the content type is not on either allowlist, or the
 *                   destination rejected it and the user declined Files.
 * - `corrupt`     — the decrypted file is 0 bytes (DEBT-186).
 * - `failed`      — anything else.
 */
export type ExportOutcome =
  | 'saved'
  | 'cancelled'
  | 'unavailable'
  | 'notAllowed'
  | 'noSpace'
  | 'permission'
  | 'unsupported'
  | 'corrupt'
  | 'failed';

/** Where a saved copy landed — the only thing worth saying after success. */
export type ExportDestination = 'photos' | 'files';

export type ExportResult =
  | { outcome: 'saved'; destination: ExportDestination }
  | { outcome: Exclude<ExportOutcome, 'saved'> };

/** Short, non-identifying copy for a status pill or a summary row. */
export function describeExportOutcome(result: ExportResult): string {
  switch (result.outcome) {
    case 'saved':
      return result.destination === 'photos' ? 'Saved to Photos' : 'Saved to Files';
    case 'cancelled':
      return 'Save cancelled';
    case 'unavailable':
      return 'No longer available';
    case 'notAllowed':
      return 'Not available to save';
    case 'noSpace':
      return 'Not enough storage';
    case 'permission':
      return 'Permission needed';
    case 'unsupported':
      return "Can't save this file type";
    case 'corrupt':
      return "This file can't be saved";
    case 'failed':
      return "Couldn't save";
  }
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * iOS staging directory: the native module aliases a file into
 * `orbital-export/<uuid>/<name>` (clonefile, so no byte copy) and deletes the
 * per-call directory on every settle path.
 *
 * BOTH iOS routes stage here. The document route always does; the PHOTO route
 * does whenever the on-disk extension differs from the display name's, which
 * is the COMMON case since #880 — a canonical `{id}.HEIC` file whose JPEG
 * bytes are now correctly named `*.jpg` is exactly that mismatch. Either way
 * the residue is swept by the same whole-directory unlink below.
 *
 * This is the ONE media-pipeline path that writes plaintext-adjacent residue
 * into a SUBDIRECTORY of Caches rather than the top level, which is why it is
 * swept whole-directory rather than through `isStagingResidueName` — the two
 * suffix sweeps are non-recursive `readDir` listings and structurally cannot
 * reach in here. See the LOCATION INVARIANT note in `media/stagingResidue.ts`.
 */
export const EXPORT_STAGING_DIR = `${CachesDirectoryPath}/orbital-export`;

/**
 * Delete the whole export staging directory. Best-effort, and safe to call
 * when it does not exist.
 *
 * Wired into `localWipe` (both paths) and into `cleanupOrphanedChunks`, which
 * is how bootstrap is covered. Pinned by `media-export-wipe-wired`.
 */
export async function clearMediaExportStaging(): Promise<void> {
  try {
    if (await exists(EXPORT_STAGING_DIR)) {
      await unlink(EXPORT_STAGING_DIR).catch(() => {});
    }
  } catch {
    if (__DEV__) console.warn('[mediaExport]', 'staging sweep failed');
  }
}

// ---------------------------------------------------------------------------
// Cancellation: per-item controllers + a wipe epoch
// ---------------------------------------------------------------------------

/**
 * Every in-flight export's AbortController. A per-item save registers on entry
 * and deregisters in its own `finally`; PR 2's bulk runner registers its single
 * run controller the same way.
 */
const activeControllers = new Set<AbortController>();

/**
 * Bumped by `cancelAllExports()`. `performExport()` compares the epoch it was
 * handed against the live one immediately before the native call, so a wipe
 * that lands while a download is finishing cannot be followed by a write.
 *
 * An epoch is needed ON TOP of the controllers because abort is cooperative:
 * a promise already resolved is past every `signal.aborted` check, and the
 * native call is the one step that must not happen anyway.
 */
let exportEpoch = 0;

/** Register an AbortController with the global cancel. Returns an unregister. */
export function registerExportAbort(controller: AbortController): () => void {
  activeControllers.add(controller);
  return () => {
    activeControllers.delete(controller);
  };
}

/** The current epoch — captured at the start of an export, checked before the write. */
export function currentExportEpoch(): number {
  return exportEpoch;
}

/**
 * Abort every in-flight export, SYNCHRONOUSLY.
 *
 * Called from `localWipe` phase 1, before `MEDIA_DIR` is deleted. It must not
 * be async: an `await` here would hand control back to an export that is one
 * microtask away from writing a decrypted file to the photo library of a
 * device whose account is being deleted.
 *
 * It does NOT cancel the underlying shared downloads — those are joined by
 * other UI (#703 owns that race). It stops the EXPORT.
 */
export function cancelAllExports(): void {
  exportEpoch += 1;
  // A staged document entry points at a decrypted file in MEDIA_DIR, which
  // phase 2 of the wipe is about to delete. Dropping the list here means the
  // end-of-run picker has nothing to present even if the runner's own unwind
  // is still a microtask away.
  discardStagedBulkDocuments();
  for (const controller of Array.from(activeControllers)) {
    try {
      controller.abort();
    } catch {
      // An AbortController that throws on abort is not a reason to skip the rest.
    }
  }
  activeControllers.clear();
}

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

/**
 * MMKV key for the one-time acknowledgement, following `deviceId.ts`: read
 * lazily (MMKV is not up until bootstrap finishes) and never at module scope.
 *
 * `localWipe` calls `clearAll()`, so the acknowledgement resets on logout.
 * That is deliberate: consent to leak plaintext belongs to the signed-in user,
 * not to the device. Clearing MMKV is not enough on its own — logout does not
 * reload the JS bundle, so `localWipe` also calls `clearExportDisclosureCache()`
 * to drop the in-memory mirror below.
 */
const DISCLOSURE_KEY = 'orbital:media-export-disclosure-ack';

/** In-memory mirror, so a save loop does not hit MMKV per item. */
let disclosureAcked: boolean | null = null;

function readDisclosureAck(): boolean {
  if (disclosureAcked !== null) return disclosureAcked;
  try {
    const { getMMKVInstance } = require('../stores/middleware/persistence');
    disclosureAcked = getMMKVInstance().getBoolean(DISCLOSURE_KEY) === true;
  } catch {
    // MMKV not initialized (tests, pre-bootstrap). Treat as not acknowledged:
    // failing closed means we prompt again, never that we write silently.
    return false;
  }
  return disclosureAcked;
}

/**
 * Forget the in-memory acknowledgement. Called from `localWipe` phase 1: the
 * mirror outlives logout (the JS runtime keeps running), so without this the
 * next account to sign in on this device would save without ever seeing the
 * disclosure. Synchronous, like `cancelAllExports()`, for the same reason.
 */
export function clearExportDisclosureCache(): void {
  disclosureAcked = null;
}

function writeDisclosureAck(): void {
  disclosureAcked = true;
  try {
    const { getMMKVInstance } = require('../stores/middleware/persistence');
    getMMKVInstance().set(DISCLOSURE_KEY, true);
  } catch {
    // Not persisting is acceptable — the user is asked again next launch.
  }
}

/** Platform-correct name for the cloud the OS may sweep a saved copy into. */
function cloudServiceName(): string {
  return Platform.OS === 'ios' ? 'iCloud Photos' : 'Google Photos';
}

const DISCLOSURE_TITLE = 'Saving outside Orbital';

function disclosureBody(): string {
  return (
    'Orbital keeps your photos, videos and files end-to-end encrypted. ' +
    'Saved copies are stored on this device without that protection, may be ' +
    `backed up to ${cloudServiceName()} or another cloud service, and other ` +
    'apps with photo or file access can read them. Copies you save stay on ' +
    'this device even if you log out or delete your Orbital account.'
  );
}

/**
 * Show the one-time disclosure if it has not been acknowledged.
 *
 * Resolves true when the user may proceed. Its OWN Alert — never merged with a
 * permission or confirm Alert, because a single dialog that both discloses and
 * confirms gives the user one button for two decisions.
 */
export async function ensureExportDisclosure(): Promise<boolean> {
  if (readDisclosureAck()) return true;

  const accepted = await new Promise<boolean>((resolve) => {
    Alert.alert(
      DISCLOSURE_TITLE,
      disclosureBody(),
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue', onPress: () => resolve(true) },
      ],
      { onDismiss: () => resolve(false) },
    );
  });

  if (accepted) writeDisclosureAck();
  return accepted;
}

/**
 * Synchronous guard inside the native-write choke point. Throws rather than
 * prompting — see the module header.
 */
export function assertDisclosureAcknowledged(): void {
  if (!readDisclosureAck()) {
    throw new Error('export disclosure not acknowledged');
  }
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

/** What the permission step decided. `useFiles` is the user's own choice. */
type PermissionDecision = 'granted' | 'denied' | 'useFiles';

/** Android API level at and below which shared-storage writes need WRITE_EXTERNAL_STORAGE. */
const ANDROID_LEGACY_STORAGE_MAX_SDK = 28;

function openSettingsAlert(title: string, body: string): Promise<void> {
  return new Promise<void>((resolve) => {
    Alert.alert(
      title,
      body,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
        {
          text: 'Open Settings',
          onPress: () => {
            Linking.openSettings();
            resolve();
          },
        },
      ],
      { onDismiss: () => resolve() },
    );
  });
}

/**
 * Denied photo access is not a dead end: the same bytes can go to Files, which
 * needs no permission at all. Offering it here is what keeps a refused
 * permission from reading as "Orbital cannot save".
 */
function offerFilesInstead(title: string, body: string): Promise<PermissionDecision> {
  return new Promise<PermissionDecision>((resolve) => {
    Alert.alert(
      title,
      body,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve('denied') },
        {
          text: 'Save to Files instead',
          onPress: () => resolve('useFiles'),
        },
        {
          text: 'Open Settings',
          onPress: () => {
            Linking.openSettings();
            resolve('denied');
          },
        },
      ],
      { onDismiss: () => resolve('denied') },
    );
  });
}

/**
 * Acquire whatever THIS ROUTE needs on this platform.
 *
 * **Android is route-independent below API 29.** Both destinations are shared
 * storage there — `Pictures/Orbital` and `Movies/Orbital` for the gallery,
 * `Download/Orbital` for documents — and all three need
 * `WRITE_EXTERNAL_STORAGE`. Requesting it for the photo route only (as this
 * did before the #879 review) turned a denied document save into a generic
 * "Couldn't save" with no prompt and no route to Settings. API 29+ writes
 * through MediaStore's own collections and needs nothing.
 *
 * The grant on API 24-28 also confers read of shared storage; accepted
 * 2026-10-09 in exchange for gallery placement on Android 7-9.
 *
 * There is no "Save to Files instead" offer on Android: the document
 * destination needs the very permission that was just refused.
 *
 * **iOS** gates only the photo library — add-only PhotoKit authorization,
 * requested through the module. `.limited` cannot occur under add-only access
 * and is mapped to granted defensively by the native layer. The document
 * picker is the user's own file chooser and needs no permission at all.
 *
 * NEVER called outside a user-initiated save, and always before any download.
 */
async function ensureExportPermission(kind: 'photo' | 'document'): Promise<PermissionDecision> {
  if (Platform.OS === 'android') {
    if (Number(Platform.Version) > ANDROID_LEGACY_STORAGE_MAX_SDK) {
      return 'granted';
    }
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
    );
    if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
    if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
      await openSettingsAlert(
        'Storage access needed',
        kind === 'photo'
          ? 'Orbital needs permission to save photos and videos to your gallery. You can turn it on in Settings.'
          : 'Orbital needs permission to save files to your device. You can turn it on in Settings.',
      );
      return 'denied';
    }
    return 'denied';
  }

  if (kind === 'document') return 'granted';

  const status = await requestPhotoAddPermission();
  if (status === 'granted' || status === 'notRequired') return 'granted';
  if (status === 'notDetermined') {
    // The OS declined to prompt (it only ever asks once per install). Treat it
    // as refused rather than attempting a write that will fail.
    return 'denied';
  }
  return offerFilesInstead(
    'Photo access needed',
    'Orbital can add this to your photo library once you allow access, or save it to Files instead.',
  );
}

// ---------------------------------------------------------------------------
// Native-write choke point
// ---------------------------------------------------------------------------

/**
 * One file as the native writers want it. The extension travels inside
 * `displayName`, which is what both platforms derive the file's type and name
 * from.
 */
interface ExportEntry {
  sourcePath: string;
  mimeType: string;
  displayName: string;
}

/**
 * A staged iOS document, plus the id needed to re-check its access at flush
 * time. The id never leaves this module — the runner is handed counts.
 */
interface StagedDocument extends ExportEntry {
  mediaId: string;
}

/**
 * WHERE this goes. Fixed before the download, because the permission was
 * acquired for it — see `resolveExportLabel`.
 *
 * The document arm takes a LIST so a bulk run presents exactly one iOS picker
 * for the whole batch (plan §5). It is a list here, and not a second native
 * call site, because `exportFiles(` may appear in precisely one function —
 * see the `media-export-disclosure-gate` invariant.
 */
type ExportRequest =
  | ({
      kind: 'photo';
      /** Post date, honoured by the photo route only. */
      createdAtMs: number;
      /** Epoch captured when this export started — a wipe since then voids it. */
      epoch: number;
      /**
       * The CALLER's cancellation, re-checked inside the write lock. The lock
       * wait is unbounded (a document picker waits for a human), so a lightbox
       * save queued behind a bulk run could otherwise write minutes after the
       * user closed the lightbox (#889 review).
       */
      signal?: AbortSignal;
    } & ExportEntry)
  | {
      kind: 'document';
      documents: readonly ExportEntry[];
      epoch: number;
      signal?: AbortSignal;
    };

/**
 * Native writes are serialized, run-wide.
 *
 * Two bulk workers download in parallel, but a PhotoKit `performChanges` block
 * and a document-picker presentation are both single-resource: two concurrent
 * presentations would race for `RCTPresentedViewController()`, and parallel
 * `performChanges` calls serialize inside PhotoKit anyway, just with less
 * predictable failure attribution.
 */
const nativeWriteLock = createSemaphore(1);

/**
 * THE ONLY NATIVE-WRITE CALL SITE IN THE APP.
 *
 * Both gates that cannot be re-derived later live here, immediately before the
 * call: the disclosure assertion, and the wipe-epoch comparison. Pinned by the
 * `media-export-disclosure-gate` invariant, which also checks that every
 * exported entry point calls `ensureExportDisclosure(` before its first await.
 *
 * (The add-only permission QUERY in `ensureExportPermission` also reaches
 * native, deliberately outside this function and outside the invariant's
 * scope: it writes nothing, returns no user data, and must run before the
 * download so the user is never asked for access to fetch a file they then
 * cannot save.)
 */
async function performExport(request: ExportRequest): Promise<ExportResult> {
  assertDisclosureAcknowledged();
  if (request.epoch !== exportEpoch) {
    return { outcome: 'cancelled' };
  }

  await nativeWriteLock.acquire();
  try {
    // Re-checked INSIDE the lock: waiting for another item's write is
    // unbounded (a document picker waits for the user), so BOTH a wipe and the
    // caller walking away must still stop this write.
    if (request.epoch !== exportEpoch || request.signal?.aborted === true) {
      return { outcome: 'cancelled' };
    }

    if (request.kind === 'photo') {
      await saveToPhotoLibrary({
        sourcePath: request.sourcePath,
        mimeType: request.mimeType,
        displayName: request.displayName,
        createdAtMs: request.createdAtMs,
      });
      return { outcome: 'saved', destination: 'photos' };
    }

    if (request.documents.length === 0) {
      return { outcome: 'cancelled' };
    }

    const result = await exportFiles(
      request.documents.map((entry) => ({
        sourcePath: entry.sourcePath,
        mimeType: entry.mimeType,
        displayName: entry.displayName,
      })),
    );
    return result === 'cancelled'
      ? { outcome: 'cancelled' }
      : { outcome: 'saved', destination: 'files' };
  } finally {
    nativeWriteLock.release();
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function warnCode(code: string): void {
  if (__DEV__) console.warn('[mediaExport]', code);
}

/**
 * Error codes already reported in the current capture WINDOW, or null when no
 * window is open.
 *
 * A bulk run can touch `BULK_EXPORT_MAX_ITEMS` items, and a systemic writer
 * failure fails all of them the same way — which was up to 500 identical
 * Sentry events from one tap (#889 review). Inside a window each code is
 * reported once; the second and later occurrences still reach `warnCode`, so
 * nothing is hidden in a dev log.
 *
 * Null (the lightbox's single-item path) means no budget at all: one save, one
 * event, exactly as before.
 */
let capturedExportCodes: Set<string> | null = null;

/** Open the per-run capture budget. Called by the bulk runner at run start. */
export function beginExportCaptureBudget(): void {
  capturedExportCodes = new Set<string>();
}

/** Close it. Every later single-item save reports unconditionally again. */
export function endExportCaptureBudget(): void {
  capturedExportCodes = null;
}

/** Report a writer failure, at most once per code while a budget is open. */
function captureExportFailure(code: string): void {
  if (capturedExportCodes !== null) {
    if (capturedExportCodes.has(code)) return;
    capturedExportCodes.add(code);
  }
  captureError(new Error('media export failed'), { tags: { export_code: code } });
}

/** Map a native error code onto an outcome. */
function outcomeForCode(code: MediaExportErrorCode): Exclude<ExportOutcome, 'saved'> {
  switch (code) {
    case 'EPERMISSION':
      return 'permission';
    case 'EUNSUPPORTED':
      return 'unsupported';
    case 'ENOSPC':
      return 'noSpace';
    case 'ENOENT':
      return 'unavailable';
    case 'ECANCELLED':
      return 'cancelled';
    case 'EINVALIDNAME':
    case 'EEXPORT':
      return 'failed';
  }
}

/**
 * Turn any thrown value into a result, logging the CODE and nothing else.
 *
 * `EEXPORT` and the unclassifiable tail are the two cases worth a Sentry
 * event: they mean the writer broke in a way we did not design for. The event
 * carries a fixed Error plus the code as a tag — never a path, a name or an id.
 *
 * Everything the DOWNLOAD can legitimately fail with is classified ABOVE that
 * tail, and none of it is captured. Each was reaching Sentry as a spurious
 * `EUNKNOWN` before, which is noise that would have buried a real writer bug:
 *  - `NotFoundError` (404) — the server evicted the ciphertext and there is no
 *    local copy. Ordinary, expected, and already the download path's own
 *    `unavailable` state.
 *  - `DOWNLOAD_ABORTED_MESSAGE` — the shared download's OWNER walked away
 *    while we were joined to it. `failed` (not `cancelled`), because WE did
 *    not cancel and the user should be invited to retry; this is exactly the
 *    "a joined abort that isn't ours is reported as failed" rule in
 *    `media/abortable.ts`'s header, and the reason it has no retry-once.
 *  - `AuthError` — the session died mid-save. The auth layer already handles
 *    the 401; a second report of it here says nothing about export.
 */
function resultForError(e: unknown): ExportResult {
  if (isExportAbortError(e)) {
    warnCode('aborted');
    return { outcome: 'cancelled' };
  }
  if (e instanceof InsufficientSpaceError) {
    warnCode('ENOSPC');
    return { outcome: 'noSpace' };
  }
  if (e instanceof NotFoundError) {
    warnCode('EEVICTED');
    return { outcome: 'unavailable' };
  }
  if (e instanceof AuthError) {
    warnCode('EAUTH');
    return { outcome: 'failed' };
  }
  if (e instanceof Error && e.message === DOWNLOAD_ABORTED_MESSAGE) {
    // Distinct from ExportAbortError: that one is OUR signal firing.
    warnCode('EJOINEDABORT');
    return { outcome: 'failed' };
  }
  if (isMediaExportError(e)) {
    const code = e.code;
    warnCode(code);
    if (code === 'EEXPORT' || code === 'EINVALIDNAME') {
      captureExportFailure(code);
    }
    return { outcome: outcomeForCode(code) };
  }
  warnCode('EUNKNOWN');
  captureExportFailure('EUNKNOWN');
  return { outcome: 'failed' };
}

// ---------------------------------------------------------------------------
// Labelling (#880)
// ---------------------------------------------------------------------------

/**
 * Post date carried onto the copy, so a saved photo sorts into the gallery
 * where the user remembers it rather than at today (Alex, 2026-10-09). 0 means
 * "unknown" to the native layer, which then omits the attribute.
 */
function exportCreatedAtMs(row: MediaRow): number {
  return Number.isFinite(row.created_at) ? row.created_at : 0;
}

/**
 * Read the head of the decrypted file and identify its format, or null.
 *
 * Advisory: every failure path returns null and the declared type stands. The
 * warning carries the CODE only — never the path (`media-export-no-name-logging`).
 */
async function sniffExportHead(sourcePath: string): Promise<string | null> {
  try {
    const headBase64 = await read(sourcePath, SNIFF_HEAD_BYTES, 0, 'base64');
    return sniffContentType(base64ToUint8Array(headBase64));
  } catch {
    warnCode('ESNIFF');
    return null;
  }
}

/**
 * THE ONLY PLACE AN EXPORT LABEL IS COMPUTED.
 *
 * Reads the file's head, reconciles it against the row's declared type and
 * builds the display name. Every entry point that reaches `performExport` must
 * go through here — a second labeller is how `image/heic` ended up on JPEG
 * bytes in the first place.
 *
 * Deliberately does NOT take the route kind. The kind is fixed before the
 * download because the permission was acquired for it, and the byte check may
 * only change the extension and the MIME — so there is nothing here for the
 * kind to decide, and taking it would invite a future change that reroutes.
 *
 * Call AFTER the download: it needs the plaintext. The caller must re-check
 * abort afterwards, since this awaits.
 */
async function resolveExportLabel(
  row: MediaRow,
  sourcePath: string,
): Promise<{ mimeType: string; displayName: string; extension: string }> {
  const sniffed = await sniffExportHead(sourcePath);
  const label = reconcileExportLabel(row.content_type, sniffed);
  return {
    mimeType: label.contentType,
    extension: label.extension,
    displayName: buildExportFileName(row.file_name, label.extension, exportCreatedAtMs(row)),
  };
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** True when this id may be saved right now. Synchronous; DB + store only. */
export function isMediaExportAllowed(mediaId: string): boolean {
  const access = getMediaExportAccess(mediaId);
  if (access === null) return false;
  return isExportableConversation(access.conversation_id);
}

// ---------------------------------------------------------------------------
// The shared middle: fetch, re-check, label
// ---------------------------------------------------------------------------

/**
 * Either an entry ready for the native write, or the result to report instead.
 */
type PreparedWrite =
  | { ok: true; entry: ExportEntry; createdAtMs: number }
  | { ok: false; result: ExportResult };

/**
 * Everything between the gates and the write, shared by the single-item and
 * bulk paths: download, abort + access re-check, the 0-byte guard, and the
 * label.
 *
 * Shared rather than duplicated on purpose. Each of those steps is a property
 * the review of PR 1 argued for individually, and a second copy for the bulk
 * runner is how one of them (realistically the 0-byte guard, which has no
 * user-visible symptom) would quietly go missing from a batch of 400 items.
 *
 * Callers still own the gates BEFORE this — disclosure, permission, the first
 * access check — because bulk acquires those once for the whole run.
 *
 * `rejectBlockedAuthor` is the one behavioural difference between the two
 * callers: a blocked author's media is refused in a BATCH and allowed one item
 * at a time, so the single-item path passes false.
 */
async function prepareWrite(
  row: MediaRow,
  mediaId: string,
  signal: AbortSignal,
  epoch: number,
  options: { rejectBlockedAuthor: boolean },
): Promise<PreparedWrite> {
  // --- Download (joined, but abortable independently) ---------------------
  let sourcePath: string;
  try {
    sourcePath = await abortable(downloadAndDecryptMedia(mediaId, signal), signal);
  } catch (e) {
    return { ok: false, result: resultForError(e) };
  }

  if (signal.aborted || epoch !== exportEpoch) {
    return { ok: false, result: { outcome: 'cancelled' } };
  }

  // --- Access re-check: a download is long enough to lose membership, and
  // long enough for the author to be blocked (bulk only) -------------------
  const after = getMediaExportAccess(mediaId);
  if (
    after === null ||
    !isExportableConversation(after.conversation_id) ||
    (options.rejectBlockedAuthor && isBlockedAuthor(after.author_id))
  ) {
    warnCode('ENOACCESS');
    return { ok: false, result: { outcome: 'notAllowed' } };
  }

  // --- 0-byte guard (DEBT-186): never hand an empty file to the OS --------
  try {
    const info = await stat(sourcePath);
    if (!info || info.size <= 0) {
      warnCode('ECORRUPT');
      return { ok: false, result: { outcome: 'corrupt' } };
    }
  } catch {
    warnCode('ENOENT');
    return { ok: false, result: { outcome: 'unavailable' } };
  }

  // --- Label from the BYTES, not from the peer's content_type (#880) ------
  // The KIND is NOT revisited: the permission for it was acquired before the
  // download, so a byte check must never escalate a document save into a
  // photo-library write.
  let mimeType: string;
  let displayName: string;
  try {
    ({ mimeType, displayName } = await resolveExportLabel(row, sourcePath));
  } catch (e) {
    // `reconcileExportLabel` throws on a REFUSED declared type, which both
    // callers' routing gate already returned on — so this is a programming
    // error, not a user state. It is caught anyway because neither entry point
    // throws: the UI gets a result, not a rejection.
    return { ok: false, result: resultForError(e) };
  }

  // The label step awaits (a file read), which is long enough for the lightbox
  // to close or for a wipe to land. Mirrors the post-download check above: the
  // native write is the one step that must not happen anyway.
  if (signal.aborted || epoch !== exportEpoch) {
    return { ok: false, result: { outcome: 'cancelled' } };
  }

  return {
    ok: true,
    entry: { sourcePath, mimeType, displayName },
    createdAtMs: exportCreatedAtMs(row),
  };
}

// ---------------------------------------------------------------------------
// Per-item save
// ---------------------------------------------------------------------------

/**
 * Save one media item to the device.
 *
 * Order is load-bearing, see the module header: disclosure, then permission,
 * then access, then download, then abort + access re-check, then the 0-byte
 * guard, then the single native write.
 *
 * Never throws: every failure is an `ExportResult` the UI can render.
 */
export async function saveMediaItem(
  mediaId: string,
  signal?: AbortSignal,
): Promise<ExportResult> {
  // --- Routing, from the row's content type (cheapest refusal first) -------
  let row: MediaRow | null = null;
  try {
    row = getMedia(mediaId);
  } catch {
    // DB may not be open (Metro Fast Refresh resets the handle).
  }
  if (row === null) {
    warnCode('ENOROW');
    return { outcome: 'unavailable' };
  }

  const routed = resolveExportRoute(row.content_type);
  if (routed.kind === 'refused') {
    warnCode('EUNSUPPORTED');
    return { outcome: 'unsupported' };
  }
  let kind: 'photo' | 'document' = routed.kind;

  // --- Gate 1: disclosure, before any download ----------------------------
  if (!(await ensureExportDisclosure())) {
    return { outcome: 'cancelled' };
  }

  // --- Gate 2: permission, still before any download ----------------------
  // Unconditional: which permission (if any) a route needs is the callee's
  // decision, not this call site's. Branching here is what left the Android
  // document route unpermissioned on API 24-28 (#879 review).
  const decision = await ensureExportPermission(kind);
  if (decision === 'denied') {
    warnCode('EPERMISSION');
    return { outcome: 'permission' };
  }
  if (decision === 'useFiles') {
    // The user chose the Files destination. The LABEL is unaffected: it
    // describes the bytes, not the destination.
    kind = 'document';
  }

  // --- Gate 3: access ------------------------------------------------------
  const access = getMediaExportAccess(mediaId);
  if (access === null || !isExportableConversation(access.conversation_id)) {
    warnCode('ENOACCESS');
    return { outcome: 'notAllowed' };
  }

  const createdAtMs = exportCreatedAtMs(row);

  const epoch = exportEpoch;
  const controller = new AbortController();
  const unregister = registerExportAbort(controller);
  const onOuterAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) {
      unregister();
      return { outcome: 'cancelled' };
    }
    signal.addEventListener?.('abort', onOuterAbort, { once: true });
  }

  try {
    const prepared = await prepareWrite(row, mediaId, controller.signal, epoch, {
      rejectBlockedAuthor: false,
    });
    if (!prepared.ok) return prepared.result;
    const { entry } = prepared;
    try {
      return await performExport(
        kind === 'photo'
          ? { kind: 'photo', ...entry, createdAtMs, epoch, signal: controller.signal }
          : { kind: 'document', documents: [entry], epoch, signal: controller.signal },
      );
    } catch (e) {
      // EUNSUPPORTED from Photos is recoverable: the same bytes can go to
      // Files. Offered only on a single-item save — a batch cannot stop to ask.
      if (kind === 'photo' && isMediaExportError(e) && e.code === 'EUNSUPPORTED') {
        warnCode('EUNSUPPORTED');
        const useFiles = await offerFilesFallback();
        if (!useFiles) return { outcome: 'unsupported' };
        try {
          return await performExport({
            kind: 'document',
            documents: [entry],
            epoch,
            signal: controller.signal,
          });
        } catch (retryError) {
          return resultForError(retryError);
        }
      }
      return resultForError(e);
    }
  } finally {
    if (signal) signal.removeEventListener?.('abort', onOuterAbort);
    unregister();
  }
}

/** "Photos won't take this — try Files?" Single-item only. */
function offerFilesFallback(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      "Can't add this to Photos",
      'Your photo library rejected this file. You can save it to Files instead.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Save to Files instead', onPress: () => resolve(true) },
      ],
      { onDismiss: () => resolve(false) },
    );
  });
}

// ---------------------------------------------------------------------------
// Bulk save (#878 PR 2) — the service half of `media/bulkExportRunner.ts`
// ---------------------------------------------------------------------------

/**
 * What a whole batch needs permission for, decided once from the snapshot's
 * content types rather than per item.
 */
export interface BulkExportNeeds {
  photo: boolean;
  document: boolean;
}

export interface BulkExportPermission {
  /** False ⇒ do not start the run. The service already explained why. */
  granted: boolean;
  /** iOS: photo access was refused and the user chose Files for everything. */
  photosToFiles: boolean;
}

/**
 * Acquire, ONCE, every permission the batch needs.
 *
 * A 400-item run must not prompt 400 times, and on Android ≤28 the second
 * request is a no-op anyway (`PermissionsAndroid.request` resolves `granted`
 * without a dialog once the permission is held).
 *
 * A single refusal stops the whole run rather than silently degrading it to
 * "the documents only": the user asked to save what they were looking at, and
 * a partial batch with no explanation is worse than none. The Alert that
 * explains it — Settings, or Files instead — has already been shown by
 * `ensureExportPermission`.
 */
export async function ensureBulkExportPermission(
  needs: BulkExportNeeds,
): Promise<BulkExportPermission> {
  let photosToFiles = false;

  if (needs.photo) {
    const decision = await ensureExportPermission('photo');
    if (decision === 'denied') {
      warnCode('EPERMISSION');
      return { granted: false, photosToFiles: false };
    }
    photosToFiles = decision === 'useFiles';
  }

  if (needs.document || photosToFiles) {
    const decision = await ensureExportPermission('document');
    if (decision === 'denied') {
      warnCode('EPERMISSION');
      return { granted: false, photosToFiles: false };
    }
  }

  return { granted: true, photosToFiles };
}

/**
 * iOS document entries staged by the running batch, presented through ONE
 * picker at the end of the run (plan §5).
 *
 * The list lives HERE, not in the runner: an entry carries a decrypted path,
 * a peer-supplied display name and a media id, and this module is the only one
 * allowed to hold any of them. The runner sees counts.
 */
let stagedBulkDocuments: StagedDocument[] = [];

/** How many document writes are waiting for the end-of-run picker. */
export function stagedBulkDocumentCount(): number {
  return stagedBulkDocuments.length;
}

/** Drop the staged batch without presenting anything (cancel, wipe). */
export function discardStagedBulkDocuments(): void {
  stagedBulkDocuments = [];
}

export interface BulkItemOptions {
  /** Every photo-route item goes to the document route instead. */
  photosToFiles: boolean;
  /**
   * Stage document writes instead of presenting a picker per item. True on
   * iOS, where each `exportFiles` call is a modal the user must dismiss; false
   * on Android, where the document route is a silent write to
   * `Download/Orbital`.
   */
  batchDocuments: boolean;
}

/**
 * Outcome of one item inside a batch. `deferred` means the item is staged for
 * the end-of-run picker and is neither saved nor failed yet.
 */
export type BulkItemResult = ExportResult | { outcome: 'deferred' };

/**
 * Save one item as part of a batch.
 *
 * Same order as `saveMediaItem` with two differences, both because the run
 * owns them once: the permission was acquired up front, and a photo the
 * library refuses is NOT offered to Files (a batch cannot stop to ask — it is
 * reported `unsupported` and the user can save that one item by hand).
 *
 * The disclosure is still re-confirmed per item. It is a cached boolean read
 * after the first acknowledgement, so it costs nothing and shows no Alert —
 * and it is the property `media-export-disclosure-gate` checks of EVERY entry
 * point that can reach a native write, which is exactly what this is.
 *
 * Never throws.
 */
export async function exportMediaItemInBulk(
  mediaId: string,
  signal: AbortSignal,
  options: BulkItemOptions,
): Promise<BulkItemResult> {
  let row: MediaRow | null = null;
  try {
    row = getMedia(mediaId);
  } catch {
    // DB may not be open (Metro Fast Refresh resets the handle).
  }
  if (row === null) {
    warnCode('ENOROW');
    return { outcome: 'unavailable' };
  }

  const routed = resolveExportRoute(row.content_type);
  if (routed.kind === 'refused') {
    warnCode('EUNSUPPORTED');
    return { outcome: 'unsupported' };
  }
  const kind: 'photo' | 'document' =
    routed.kind === 'photo' && options.photosToFiles ? 'document' : routed.kind;

  if (!(await ensureExportDisclosure())) {
    return { outcome: 'cancelled' };
  }

  // Access, plus the BULK-ONLY blocked-author rule. The snapshot already
  // excluded blocked authors, but it was taken once and a run lasts minutes:
  // blocking someone mid-batch has to stop the items still queued (#889).
  const access = getMediaExportAccess(mediaId);
  if (
    access === null ||
    !isExportableConversation(access.conversation_id) ||
    isBlockedAuthor(access.author_id)
  ) {
    warnCode('ENOACCESS');
    return { outcome: 'notAllowed' };
  }

  const epoch = exportEpoch;
  if (signal.aborted) return { outcome: 'cancelled' };

  const prepared = await prepareWrite(row, mediaId, signal, epoch, {
    rejectBlockedAuthor: true,
  });
  if (!prepared.ok) return prepared.result;
  const { entry } = prepared;

  if (kind === 'document' && options.batchDocuments) {
    stagedBulkDocuments.push({ ...entry, mediaId });
    return { outcome: 'deferred' };
  }

  try {
    return await performExport(
      kind === 'photo'
        ? { kind: 'photo', ...entry, createdAtMs: prepared.createdAtMs, epoch, signal }
        : { kind: 'document', documents: [entry], epoch, signal },
    );
  } catch (e) {
    return resultForError(e);
  }
}

/** What the end-of-run picker did, and to how many items. */
export interface BulkDocumentFlush {
  outcome: 'saved' | 'cancelled' | 'failed' | 'skipped';
  count: number;
}

/**
 * Present the staged documents in ONE picker and clear the staging list.
 *
 * `cancelled` counts the presented items as skipped — the user dismissed the
 * picker, which is a decision about the whole batch, not a failure of any item.
 *
 * `count` is what was actually PRESENTED, which can be fewer than was staged:
 * every entry is re-checked against the access predicate here, immediately
 * before the write, because access is otherwise only checked at download time
 * and a document can sit staged for the length of the whole run (#889 review).
 * The caller treats the shortfall as skipped.
 *
 * The staging list is detached before anything can await, so no path — throw
 * included — leaves a decrypted path behind for the next run to present. That
 * covers the LIST; it does not and cannot recall a copy the picker already
 * wrote.
 */
export async function flushStagedBulkDocuments(): Promise<BulkDocumentFlush> {
  // FIRST statement, before the detach and before any await: a wipe that lands
  // in the window below must make this comparison fail, not pass. (The window
  // is a few microtasks in practice — the disclosure read is cached by now —
  // but the ordering is free and the review asked for it rather than for an
  // argument about reachability.)
  const epoch = exportEpoch;

  const staged = stagedBulkDocuments;
  stagedBulkDocuments = [];
  if (staged.length === 0) return { outcome: 'skipped', count: 0 };

  if (!(await ensureExportDisclosure())) {
    return { outcome: 'cancelled', count: staged.length };
  }

  // Re-check every entry's access at WRITE time, not at download time.
  const batch = staged.filter((entry) => isBulkExportAllowedAt(entry.mediaId));
  if (batch.length === 0) return { outcome: 'skipped', count: 0 };

  try {
    const result = await performExport({ kind: 'document', documents: batch, epoch });
    // The picker waits for a human, so a wipe is far likelier to land HERE
    // than in the microtask window above. A copy may already exist on disk —
    // this cannot undo that — but the outcome must not be reported as saved.
    if (epoch !== exportEpoch) {
      return { outcome: 'cancelled', count: batch.length };
    }
    return {
      outcome: result.outcome === 'saved' ? 'saved' : 'cancelled',
      count: batch.length,
    };
  } catch (e) {
    const result = resultForError(e);
    return {
      outcome: result.outcome === 'cancelled' ? 'cancelled' : 'failed',
      count: batch.length,
    };
  }
}

/**
 * Both bulk access rules for one id, from ONE query. A deleted row (null)
 * is refused — there is nothing left to attribute the copy to.
 */
function isBulkExportAllowedAt(mediaId: string): boolean {
  const access = getMediaExportAccess(mediaId);
  if (access === null) return false;
  if (!isExportableConversation(access.conversation_id)) return false;
  return !isBlockedAuthor(access.author_id);
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/** Reset module state between tests (`initX/getX/resetXForTesting` pattern). */
export function resetMediaExportForTesting(): void {
  disclosureAcked = null;
  exportEpoch = 0;
  stagedBulkDocuments = [];
  nativeWriteLock.reset();
  activeControllers.clear();
}
