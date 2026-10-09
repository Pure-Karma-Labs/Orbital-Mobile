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
 * ## Logging
 *
 * `if (__DEV__) console.warn('[mediaExport]', code)` and nothing else. No
 * file name, display name, path or media id is ever logged or sent to Sentry;
 * `captureError` receives a fixed Error plus the error CODE as a tag. Pinned
 * by the `media-export-no-name-logging` invariant, which reads this file, the
 * sanitizer, and the package's own two TS files.
 */

import { Alert, Linking, PermissionsAndroid, Platform } from 'react-native';
import { CachesDirectoryPath, exists, stat, unlink } from '@dr.pogodin/react-native-fs';
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
import { useAppStore } from '../stores/useAppStore';
import { captureError } from './telemetry';
import {
  downloadAndDecryptMedia,
  InsufficientSpaceError,
} from './mediaDownloadService';
import { abortable, isExportAbortError } from './media/abortable';
import {
  buildExportFileName,
  resolveExportRoute,
  type ExportRoute,
} from './media/exportFileName';

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
 * iOS staging directory for the document route: the native module aliases each
 * file into `orbital-export/<uuid>/<name>` (clonefile, so no byte copy) and
 * deletes the per-call directory on every settle path.
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
 * Acquire whatever the photo route needs on this platform.
 *
 * iOS: add-only PhotoKit authorization, requested through the module.
 * `.limited` cannot occur under add-only access and is mapped to granted
 * defensively by the native layer.
 *
 * Android 29+: no permission at all (MediaStore inserts into its own
 * collections). Android 24-28: WRITE_EXTERNAL_STORAGE, which on those versions
 * also grants read of shared storage — accepted, 2026-10-09, in exchange for
 * gallery placement on Android 7-9.
 *
 * NEVER called outside a user-initiated save.
 */
async function ensurePhotoRouteAccess(): Promise<PermissionDecision> {
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
        'Orbital needs permission to save photos and videos to your gallery. You can turn it on in Settings.',
      );
      return 'denied';
    }
    return 'denied';
  }

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

interface ExportRequest {
  route: ExportRoute & { kind: 'photo' | 'document' };
  sourcePath: string;
  mimeType: string;
  displayName: string;
  createdAtMs: number;
  /** Epoch captured when this export started — a wipe since then voids it. */
  epoch: number;
}

/**
 * THE ONLY NATIVE-WRITE CALL SITE IN THE APP.
 *
 * Both gates that cannot be re-derived later live here, immediately before the
 * call: the disclosure assertion, and the wipe-epoch comparison. Pinned by the
 * `media-export-disclosure-gate` invariant, which also checks that every
 * exported entry point calls `ensureExportDisclosure(` before its first await.
 *
 * (The add-only permission QUERY in `ensurePhotoRouteAccess` also reaches
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

  if (request.route.kind === 'photo') {
    await saveToPhotoLibrary({
      sourcePath: request.sourcePath,
      mimeType: request.mimeType,
      displayName: request.displayName,
      createdAtMs: request.createdAtMs,
    });
    return { outcome: 'saved', destination: 'photos' };
  }

  const result = await exportFiles([
    {
      sourcePath: request.sourcePath,
      mimeType: request.mimeType,
      displayName: request.displayName,
    },
  ]);
  return result === 'cancelled'
    ? { outcome: 'cancelled' }
    : { outcome: 'saved', destination: 'files' };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function warnCode(code: string): void {
  if (__DEV__) console.warn('[mediaExport]', code);
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
  if (isMediaExportError(e)) {
    const code = e.code;
    warnCode(code);
    if (code === 'EEXPORT' || code === 'EINVALIDNAME') {
      captureError(new Error('media export failed'), { tags: { export_code: code } });
    }
    return { outcome: outcomeForCode(code) };
  }
  warnCode('EUNKNOWN');
  captureError(new Error('media export failed'), { tags: { export_code: 'EUNKNOWN' } });
  return { outcome: 'failed' };
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * An item is exportable iff its resolved conversation is a key of the store's
 * `conversations` map.
 *
 * The STORE, not SQL, is the membership authority: DMs are threads, and DM
 * conversations live in the same Zustand map, while the SQLite `conversations`
 * table is a group-key store that keeps rows for orbits you have left. This
 * excludes orphans (left orbits) and the uploader's own not-yet-posted rows,
 * and is re-checked after the download.
 */
function isExportableConversation(conversationId: string | null): boolean {
  if (!conversationId) return false;
  return Object.prototype.hasOwnProperty.call(
    useAppStore.getState().conversations,
    conversationId,
  );
}

/** True when this id may be saved right now. Synchronous; DB + store only. */
export function isMediaExportAllowed(mediaId: string): boolean {
  const access = getMediaExportAccess(mediaId);
  if (access === null) return false;
  return isExportableConversation(access.conversation_id);
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
  let route: ExportRoute & { kind: 'photo' | 'document' } = routed;

  // --- Gate 1: disclosure, before any download ----------------------------
  if (!(await ensureExportDisclosure())) {
    return { outcome: 'cancelled' };
  }

  // --- Gate 2: permission, still before any download ----------------------
  if (route.kind === 'photo') {
    const decision = await ensurePhotoRouteAccess();
    if (decision === 'denied') {
      warnCode('EPERMISSION');
      return { outcome: 'permission' };
    }
    if (decision === 'useFiles') {
      // The user chose the Files destination. The extension stays the photo
      // one — it describes the bytes, not the destination.
      route = { kind: 'document', extension: route.extension };
    }
  }

  // --- Gate 3: access ------------------------------------------------------
  const access = getMediaExportAccess(mediaId);
  if (access === null || !isExportableConversation(access.conversation_id)) {
    warnCode('ENOACCESS');
    return { outcome: 'notAllowed' };
  }

  const mimeType = normalizeMimeType(row.content_type);
  // Saved items keep their POST date (Alex, 2026-10-09), so a saved photo
  // sorts into the gallery where the user remembers it rather than at today.
  // 0 means "unknown" to the native layer, which then omits the attribute.
  const createdAtMs = Number.isFinite(row.created_at) ? row.created_at : 0;
  const displayName = buildExportFileName(
    row.file_name,
    route.extension,
    createdAtMs,
  );

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
    // --- Download (joined, but abortable independently) -------------------
    let sourcePath: string;
    try {
      sourcePath = await abortable(
        downloadAndDecryptMedia(mediaId, controller.signal),
        controller.signal,
      );
    } catch (e) {
      return resultForError(e);
    }

    if (controller.signal.aborted || epoch !== exportEpoch) {
      return { outcome: 'cancelled' };
    }

    // --- Access re-check: a download is long enough to lose membership ----
    const after = getMediaExportAccess(mediaId);
    if (after === null || !isExportableConversation(after.conversation_id)) {
      warnCode('ENOACCESS');
      return { outcome: 'notAllowed' };
    }

    // --- 0-byte guard (DEBT-186): never hand an empty file to the OS ------
    try {
      const info = await stat(sourcePath);
      if (!info || info.size <= 0) {
        warnCode('ECORRUPT');
        return { outcome: 'corrupt' };
      }
    } catch {
      warnCode('ENOENT');
      return { outcome: 'unavailable' };
    }

    try {
      return await performExport({
        route,
        sourcePath,
        mimeType,
        displayName,
        createdAtMs,
        epoch,
      });
    } catch (e) {
      // EUNSUPPORTED from Photos is recoverable: the same bytes can go to
      // Files. Offered only on a single-item save — a batch cannot stop to ask.
      if (
        route.kind === 'photo' &&
        isMediaExportError(e) &&
        e.code === 'EUNSUPPORTED'
      ) {
        warnCode('EUNSUPPORTED');
        const useFiles = await offerFilesFallback();
        if (!useFiles) return { outcome: 'unsupported' };
        try {
          return await performExport({
            route: { kind: 'document', extension: route.extension },
            sourcePath,
            mimeType,
            displayName,
            createdAtMs,
            epoch,
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

/** Lower-cased, parameter-free content type for the native layer. */
function normalizeMimeType(contentType: string): string {
  const semi = contentType.indexOf(';');
  return (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/** Reset module state between tests (`initX/getX/resetXForTesting` pattern). */
export function resetMediaExportForTesting(): void {
  disclosureAcked = null;
  exportEpoch = 0;
  activeControllers.clear();
}
