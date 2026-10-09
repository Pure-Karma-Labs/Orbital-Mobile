/**
 * Tests for mediaExportService (#878) — the only module that writes decrypted
 * media out of the app.
 *
 * The ordering assertions are the point of this suite. "Disclosure before any
 * download" and "permission before any download" are not cosmetic: a save the
 * user then cancels must not have written plaintext into MEDIA_DIR, and nobody
 * should be asked for photo access in order to fetch a file they will not be
 * allowed to save. Both are invisible to a test that only checks the outcome.
 */

import { Alert, Linking, PermissionsAndroid, Platform } from 'react-native';
import { exists, stat, unlink } from '@dr.pogodin/react-native-fs';
import {
  MediaExportError,
  exportFiles,
  requestPhotoAddPermission,
  saveToPhotoLibrary,
} from 'orbital-media-export';
import type { MediaRow } from '../../database/repositories/mediaRepository';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetMedia = jest.fn<MediaRow | null, [string]>();
const mockGetAccess = jest.fn<
  { conversation_id: string | null; author_id: string | null } | null,
  [string]
>();

jest.mock('../../database/repositories/mediaRepository', () => ({
  getMedia: (...args: [string]) => mockGetMedia(...args),
  getMediaExportAccess: (...args: [string]) => mockGetAccess(...args),
}));

const mockState: { conversations: Record<string, unknown>; media: Record<string, unknown> } =
  { conversations: {}, media: {} };

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: { getState: () => mockState },
}));

/**
 * The real InsufficientSpaceError class is defined inside the factory so the
 * service and the test share ONE class object — `instanceof` in the service's
 * error mapping is what we are exercising.
 */
jest.mock('../mediaDownloadService', () => {
  class InsufficientSpaceError extends Error {
    constructor() {
      super('Not enough free space to download this file.');
      this.name = 'InsufficientSpaceError';
      Object.setPrototypeOf(this, new.target.prototype);
    }
  }
  return {
    InsufficientSpaceError,
    downloadAndDecryptMedia: jest.fn(),
  };
});

const mockMMKV = {
  store: new Map<string, boolean>(),
  getBoolean(key: string) {
    return this.store.get(key);
  },
  set(key: string, value: boolean) {
    this.store.set(key, value);
  },
};

jest.mock('../../stores/middleware/persistence', () => ({
  getMMKVInstance: () => mockMMKV,
}));

const mockCaptureError = jest.fn();
jest.mock('../telemetry', () => ({
  captureError: (...args: unknown[]) => mockCaptureError(...args),
}));

// Imported AFTER the mocks so the service under test sees them.
import {
  downloadAndDecryptMedia,
  InsufficientSpaceError,
} from '../mediaDownloadService';
import {
  EXPORT_STAGING_DIR,
  cancelAllExports,
  clearMediaExportStaging,
  currentExportEpoch,
  describeExportOutcome,
  ensureExportDisclosure,
  assertDisclosureAcknowledged,
  isMediaExportAllowed,
  registerExportAbort,
  resetMediaExportForTesting,
  saveMediaItem,
} from '../mediaExportService';

const mockDownload = downloadAndDecryptMedia as jest.MockedFunction<
  typeof downloadAndDecryptMedia
>;
const mockSaveToPhotoLibrary = saveToPhotoLibrary as jest.MockedFunction<
  typeof saveToPhotoLibrary
>;
const mockExportFiles = exportFiles as jest.MockedFunction<typeof exportFiles>;
const mockRequestPhotoPermission = requestPhotoAddPermission as jest.MockedFunction<
  typeof requestPhotoAddPermission
>;
const mockStat = stat as jest.MockedFunction<typeof stat>;
const mockExists = exists as jest.MockedFunction<typeof exists>;
const mockUnlink = unlink as jest.MockedFunction<typeof unlink>;

/**
 * Drain the microtask queue. `saveMediaItem` awaits the disclosure and the
 * permission before it ever reaches the download, so a single
 * `await Promise.resolve()` lands BEFORE the download starts — which would
 * make an "abort mid-download" test actually assert "abort before download".
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

/** Set Platform.Version, which is a getter-only property on the real module. */
function setAndroid(version: number): void {
  (Platform as { OS: string }).OS = 'android';
  Object.defineProperty(Platform, 'Version', { value: version, configurable: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AlertButton = { text?: string; onPress?: () => void };

let alertSpy: jest.SpiedFunction<typeof Alert.alert>;
let warnSpy: jest.SpiedFunction<typeof console.warn>;

/** Answer every Alert by pressing the button with this exact label. */
function answerAlert(buttonText: string): void {
  alertSpy.mockImplementation(((
    _title: string,
    _message?: string,
    buttons?: AlertButton[],
  ) => {
    const found = (buttons ?? []).find((b) => b.text === buttonText);
    if (!found) {
      throw new Error(
        `Alert has no "${buttonText}" button; it has [${(buttons ?? [])
          .map((b) => b.text)
          .join(', ')}]`,
      );
    }
    found.onPress?.();
  }) as unknown as typeof Alert.alert);
}

/** Answer every Alert by dismissing it (the onDismiss path). */
function dismissAlert(): void {
  alertSpy.mockImplementation(((
    _title: string,
    _message?: string,
    _buttons?: AlertButton[],
    options?: { onDismiss?: () => void },
  ) => {
    options?.onDismiss?.();
  }) as unknown as typeof Alert.alert);
}

function row(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id: 'media-1',
    thread_id: 't-1',
    reply_id: null,
    message_id: null,
    content_type: 'image/jpeg',
    file_name: 'Beach day.jpg',
    file_size: 1024,
    width: 800,
    height: 600,
    duration: null,
    attachment_key: new Uint8Array([1]),
    attachment_digest: new Uint8Array([2]),
    cdn_number: null,
    cdn_key: null,
    local_path: null,
    thumbnail_path: null,
    blur_hash: null,
    expires_at: null,
    download_state: 'pending',
    upload_state: 'done',
    created_at: Date.UTC(2026, 4, 1, 10, 0, 0),
    ...overrides,
  };
}

/** The happy path: row exists, in a joined conversation, file is non-empty. */
function arrangeHappyPath(overrides: Partial<MediaRow> = {}): void {
  mockGetMedia.mockReturnValue(row(overrides));
  mockGetAccess.mockReturnValue({ conversation_id: 'conv-1', author_id: 'u-2' });
  mockState.conversations = { 'conv-1': { id: 'conv-1' } };
  mockDownload.mockResolvedValue('/media/media-1.jpg');
  mockStat.mockResolvedValue({ size: 1024 } as unknown as Awaited<ReturnType<typeof stat>>);
}

/** Pre-acknowledge the disclosure so a test can target a later gate. */
function acknowledgeDisclosure(): void {
  mockMMKV.store.set('orbital:media-export-disclosure-ack', true);
  resetMediaExportForTesting();
}

const originalOS = Platform.OS;

beforeEach(() => {
  jest.clearAllMocks();
  mockMMKV.store.clear();
  resetMediaExportForTesting();
  mockState.conversations = {};
  mockState.media = {};
  (Platform as { OS: string }).OS = 'ios';
  Object.defineProperty(Platform, 'Version', { value: '18.0', configurable: true });
  mockRequestPhotoPermission.mockResolvedValue('granted');
  mockSaveToPhotoLibrary.mockResolvedValue(undefined);
  mockExportFiles.mockResolvedValue('saved');
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  (Platform as { OS: string }).OS = originalOS;
  alertSpy.mockRestore();
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('saveMediaItem — routing', () => {
  it('sends a photo-library type to the photo library with the mapped extension', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'image/heic', file_name: 'IMG_0042.HEIC' });

    const result = await saveMediaItem('media-1');

    expect(result).toEqual({ outcome: 'saved', destination: 'photos' });
    expect(mockSaveToPhotoLibrary).toHaveBeenCalledWith({
      sourcePath: '/media/media-1.jpg',
      mimeType: 'image/heic',
      displayName: 'IMG_0042.heic',
      createdAtMs: Date.UTC(2026, 4, 1, 10, 0, 0),
    });
    expect(mockExportFiles).not.toHaveBeenCalled();
  });

  it('sends a document type through the file picker', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'application/pdf', file_name: 'Statement.pdf' });

    const result = await saveMediaItem('media-1');

    expect(result).toEqual({ outcome: 'saved', destination: 'files' });
    expect(mockExportFiles).toHaveBeenCalledWith([
      {
        sourcePath: '/media/media-1.jpg',
        mimeType: 'application/pdf',
        displayName: 'Statement.pdf',
      },
    ]);
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
    // The document route needs no photo permission at all.
    expect(mockRequestPhotoPermission).not.toHaveBeenCalled();
  });

  it('writes the extension from the MAP, never the peer-supplied one', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'image/png', file_name: 'invoice.pdf.exe' });

    await saveMediaItem('media-1');

    expect(mockSaveToPhotoLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'invoice.pdf.png' }),
    );
  });

  it.each([
    'text/html',
    'image/svg+xml',
    'application/x-apple-aspen-config',
    'application/vnd.android.package-archive',
    'application/x-sh',
    'application/octet-stream',
    'who-knows/what',
  ])('refuses %s without downloading anything', async (contentType) => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: contentType });

    const result = await saveMediaItem('media-1');

    expect(result).toEqual({ outcome: 'unsupported' });
    expect(mockDownload).not.toHaveBeenCalled();
    // A refusal must not even show the disclosure — there is nothing to tell.
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('reports a missing row as unavailable', async () => {
    acknowledgeDisclosure();
    mockGetMedia.mockReturnValue(null);

    expect(await saveMediaItem('ghost')).toEqual({ outcome: 'unavailable' });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('survives a closed database', async () => {
    acknowledgeDisclosure();
    mockGetMedia.mockImplementation(() => {
      throw new Error('db not initialized');
    });

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'unavailable' });
  });
});

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

describe('disclosure gate', () => {
  it('is shown BEFORE any download, and Cancel downloads nothing', async () => {
    arrangeHappyPath();
    answerAlert('Cancel');

    const result = await saveMediaItem('media-1');

    expect(result).toEqual({ outcome: 'cancelled' });
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe('Saving outside Orbital');
    // The whole point of the ordering.
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockRequestPhotoPermission).not.toHaveBeenCalled();
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
  });

  it('treats a dismiss as a cancel', async () => {
    arrangeHappyPath();
    dismissAlert();

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'cancelled' });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('is its OWN alert — never merged with the permission prompt', async () => {
    arrangeHappyPath();
    answerAlert('Continue');

    await saveMediaItem('media-1');

    // Exactly one alert: the disclosure. Permission is an OS prompt, not an
    // Alert, so a second Alert here would mean the two were merged.
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [, body, buttons] = alertSpy.mock.calls[0] as unknown as [
      string,
      string,
      AlertButton[],
    ];
    expect(buttons.map((b) => b.text)).toEqual(['Cancel', 'Continue']);
    expect(body).toContain('end-to-end encrypted');
    expect(body).toContain('even if you log out or delete your Orbital account');
  });

  it('names iCloud Photos on iOS and Google Photos on Android', async () => {
    arrangeHappyPath();
    answerAlert('Continue');
    await ensureExportDisclosure();
    expect(alertSpy.mock.calls[0][1]).toContain('iCloud Photos');

    resetMediaExportForTesting();
    mockMMKV.store.clear();
    alertSpy.mockClear();
    setAndroid(33);
    await ensureExportDisclosure();
    expect(alertSpy.mock.calls[0][1]).toContain('Google Photos');
  });

  it('is shown once, then remembered', async () => {
    arrangeHappyPath();
    answerAlert('Continue');

    await saveMediaItem('media-1');
    await saveMediaItem('media-1');

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(mockSaveToPhotoLibrary).toHaveBeenCalledTimes(2);
  });

  it('is shown again after a logout clears MMKV', async () => {
    arrangeHappyPath();
    answerAlert('Continue');
    await saveMediaItem('media-1');
    expect(alertSpy).toHaveBeenCalledTimes(1);

    // localWipe -> clearAll(); a fresh module state is the next launch.
    mockMMKV.store.clear();
    resetMediaExportForTesting();
    await saveMediaItem('media-1');

    expect(alertSpy).toHaveBeenCalledTimes(2);
  });

  it('fails CLOSED when MMKV is unavailable', async () => {
    const spy = jest
      .spyOn(mockMMKV, 'getBoolean')
      .mockImplementation(() => {
        throw new Error('MMKV not initialized');
      });
    try {
      expect(() => assertDisclosureAcknowledged()).toThrow();
      arrangeHappyPath();
      answerAlert('Cancel');
      expect(await saveMediaItem('media-1')).toEqual({ outcome: 'cancelled' });
    } finally {
      spy.mockRestore();
    }
  });

  it('assertDisclosureAcknowledged passes once acknowledged', () => {
    acknowledgeDisclosure();
    expect(() => assertDisclosureAcknowledged()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

describe('permission gate', () => {
  it('iOS: requests add-only access BEFORE downloading', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    const order: string[] = [];
    mockRequestPhotoPermission.mockImplementation(async () => {
      order.push('permission');
      return 'granted';
    });
    mockDownload.mockImplementation(async () => {
      order.push('download');
      return '/media/media-1.jpg';
    });

    await saveMediaItem('media-1');

    expect(order).toEqual(['permission', 'download']);
  });

  it('iOS: a denial offers Files, Settings and Cancel', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockRequestPhotoPermission.mockResolvedValue('denied');
    answerAlert('Cancel');

    const result = await saveMediaItem('media-1');

    expect(result).toEqual({ outcome: 'permission' });
    const [title, , buttons] = alertSpy.mock.calls[0] as unknown as [
      string,
      string,
      AlertButton[],
    ];
    expect(title).toBe('Photo access needed');
    expect(buttons.map((b) => b.text)).toEqual([
      'Cancel',
      'Save to Files instead',
      'Open Settings',
    ]);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('iOS: "Save to Files instead" reroutes the same bytes to the picker', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockRequestPhotoPermission.mockResolvedValue('denied');
    answerAlert('Save to Files instead');

    const result = await saveMediaItem('media-1');

    expect(result).toEqual({ outcome: 'saved', destination: 'files' });
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
    // The extension still describes the BYTES, not the destination.
    expect(mockExportFiles).toHaveBeenCalledWith([
      expect.objectContaining({ displayName: 'Beach day.jpg', mimeType: 'image/jpeg' }),
    ]);
  });

  it('iOS: "Open Settings" opens Settings and still reports permission', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockRequestPhotoPermission.mockResolvedValue('restricted');
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    answerAlert('Open Settings');

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'permission' });
    expect(openSettings).toHaveBeenCalled();
    openSettings.mockRestore();
  });

  it('iOS: a notDetermined status the OS will not prompt for is a denial', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockRequestPhotoPermission.mockResolvedValue('notDetermined');

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'permission' });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('Android 29+: asks for nothing', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    setAndroid(33);
    const request = jest.spyOn(PermissionsAndroid, 'request');

    expect(await saveMediaItem('media-1')).toEqual({
      outcome: 'saved',
      destination: 'photos',
    });
    expect(request).not.toHaveBeenCalled();
    expect(mockRequestPhotoPermission).not.toHaveBeenCalled();
    request.mockRestore();
  });

  it('Android 28: requests WRITE_EXTERNAL_STORAGE', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    setAndroid(28);
    const request = jest
      .spyOn(PermissionsAndroid, 'request')
      .mockResolvedValue('granted' as never);

    expect(await saveMediaItem('media-1')).toEqual({
      outcome: 'saved',
      destination: 'photos',
    });
    expect(request).toHaveBeenCalledWith(
      PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
    );
    request.mockRestore();
  });

  it('Android 28: a plain denial downloads nothing', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    setAndroid(24);
    const request = jest
      .spyOn(PermissionsAndroid, 'request')
      .mockResolvedValue('denied' as never);

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'permission' });
    expect(mockDownload).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    request.mockRestore();
  });

  it('Android 28: never_ask_again routes to Settings', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    setAndroid(28);
    const request = jest
      .spyOn(PermissionsAndroid, 'request')
      .mockResolvedValue('never_ask_again' as never);
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    answerAlert('Open Settings');

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'permission' });
    expect(alertSpy.mock.calls[0][0]).toBe('Storage access needed');
    expect(openSettings).toHaveBeenCalled();
    request.mockRestore();
    openSettings.mockRestore();
  });

  it('never requests storage permission outside a save', async () => {
    const request = jest.spyOn(PermissionsAndroid, 'request');
    acknowledgeDisclosure();
    await clearMediaExportStaging();
    cancelAllExports();
    expect(request).not.toHaveBeenCalled();
    expect(mockRequestPhotoPermission).not.toHaveBeenCalled();
    request.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

describe('access rule', () => {
  it('refuses an ORPHAN (left orbit: conversation_id is NULL)', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockGetAccess.mockReturnValue({ conversation_id: null, author_id: null });

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'notAllowed' });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('refuses a conversation the user is no longer in', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockState.conversations = { 'other-conv': {} };

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'notAllowed' });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('allows another member’s item in a shared orbit', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockGetAccess.mockReturnValue({ conversation_id: 'conv-1', author_id: 'someone-else' });

    expect(await saveMediaItem('media-1')).toEqual({
      outcome: 'saved',
      destination: 'photos',
    });
  });

  it('RE-CHECKS access after the download', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    // Allowed before, revoked while the download was in flight.
    mockGetAccess
      .mockReturnValueOnce({ conversation_id: 'conv-1', author_id: 'u-2' })
      .mockReturnValue({ conversation_id: null, author_id: null });

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'notAllowed' });
    expect(mockDownload).toHaveBeenCalled();
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
  });

  it('does not read the prototype chain for conversation ids', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockState.conversations = {};
    mockGetAccess.mockReturnValue({ conversation_id: 'toString', author_id: null });

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'notAllowed' });
  });

  it('isMediaExportAllowed mirrors the service-side rule', () => {
    mockGetAccess.mockReturnValue({ conversation_id: 'conv-1', author_id: 'u' });
    mockState.conversations = { 'conv-1': {} };
    expect(isMediaExportAllowed('media-1')).toBe(true);

    mockState.conversations = {};
    expect(isMediaExportAllowed('media-1')).toBe(false);

    mockGetAccess.mockReturnValue(null);
    expect(isMediaExportAllowed('media-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source-file guards
// ---------------------------------------------------------------------------

describe('source guards', () => {
  it('refuses a 0-byte decrypted file as corrupt', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockStat.mockResolvedValue({ size: 0 } as unknown as Awaited<ReturnType<typeof stat>>);

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'corrupt' });
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
  });

  it('reports a vanished file as unavailable', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockStat.mockRejectedValue(new Error('ENOENT'));

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'unavailable' });
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
  });

  it('maps a download disk-space failure to noSpace', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockDownload.mockRejectedValue(new InsufficientSpaceError());

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'noSpace' });
  });

  it('maps any other download failure to failed', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockDownload.mockRejectedValue(new Error('No attachment keys available'));

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// Abort and wipe
// ---------------------------------------------------------------------------

describe('abort and wipe', () => {
  it('returns cancelled for an already-aborted signal without downloading', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    const controller = new AbortController();
    controller.abort();

    expect(await saveMediaItem('media-1', controller.signal)).toEqual({
      outcome: 'cancelled',
    });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('stops waiting when the caller aborts mid-download', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    const controller = new AbortController();
    let settleDownload!: (path: string) => void;
    mockDownload.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          settleDownload = resolve;
        }),
    );

    const pending = saveMediaItem('media-1', controller.signal);
    await flush();
    // Proof this is a MID-download abort, not a pre-download one.
    expect(mockDownload).toHaveBeenCalledWith('media-1', expect.anything());
    controller.abort();

    expect(await pending).toEqual({ outcome: 'cancelled' });
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
    // The shared download is untouched and still settles.
    settleDownload('/media/media-1.jpg');
  });

  it('cancelAllExports aborts an in-flight save synchronously', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockDownload.mockImplementation(
      () =>
        new Promise<string>(() => {
          /* never settles */
        }),
    );

    const pending = saveMediaItem('media-1');
    await flush();
    expect(mockDownload).toHaveBeenCalled();
    // No await: localWipe calls this synchronously in phase 1.
    cancelAllExports();

    expect(await pending).toEqual({ outcome: 'cancelled' });
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
  });

  it('bumps an epoch that blocks a write whose download already finished', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    let settleDownload!: (path: string) => void;
    mockDownload.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          settleDownload = resolve;
        }),
    );

    const pending = saveMediaItem('media-1');
    await flush();
    expect(mockDownload).toHaveBeenCalled();
    const before = currentExportEpoch();
    cancelAllExports();
    expect(currentExportEpoch()).toBe(before + 1);
    settleDownload('/media/media-1.jpg');

    expect(await pending).toEqual({ outcome: 'cancelled' });
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
  });

  it('aborts a controller the bulk runner registered', () => {
    const controller = new AbortController();
    const unregister = registerExportAbort(controller);
    cancelAllExports();
    expect(controller.signal.aborted).toBe(true);
    // Unregistering after the fact is safe and idempotent.
    unregister();
    unregister();
  });

  it('does not abort a deregistered controller', () => {
    const controller = new AbortController();
    registerExportAbort(controller)();
    cancelAllExports();
    expect(controller.signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Native error mapping
// ---------------------------------------------------------------------------

describe('native error mapping', () => {
  it.each([
    ['EPERMISSION', 'permission'],
    ['ENOSPC', 'noSpace'],
    ['ENOENT', 'unavailable'],
    ['ECANCELLED', 'cancelled'],
    ['EEXPORT', 'failed'],
    ['EINVALIDNAME', 'failed'],
  ] as const)('maps %s to %s', async (code, outcome) => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'application/pdf', file_name: 'a.pdf' });
    mockExportFiles.mockRejectedValue(new MediaExportError(code));

    expect(await saveMediaItem('media-1')).toEqual({ outcome });
  });

  it('maps a cancelled document picker to cancelled', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'application/pdf', file_name: 'a.pdf' });
    mockExportFiles.mockResolvedValue('cancelled');

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'cancelled' });
  });

  it('offers Files when Photos rejects the type, and saves on accept', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'image/webp', file_name: 'sticker.webp' });
    mockSaveToPhotoLibrary.mockRejectedValue(new MediaExportError('EUNSUPPORTED'));
    answerAlert('Save to Files instead');

    const result = await saveMediaItem('media-1');

    expect(result).toEqual({ outcome: 'saved', destination: 'files' });
    expect(alertSpy.mock.calls[0][0]).toBe("Can't add this to Photos");
    expect(mockExportFiles).toHaveBeenCalledWith([
      expect.objectContaining({ displayName: 'sticker.webp' }),
    ]);
    // The source is downloaded ONCE; the fallback reuses the same path.
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('reports unsupported when the Files offer is declined', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'image/webp', file_name: 'sticker.webp' });
    mockSaveToPhotoLibrary.mockRejectedValue(new MediaExportError('EUNSUPPORTED'));
    answerAlert('Cancel');

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'unsupported' });
    expect(mockExportFiles).not.toHaveBeenCalled();
  });

  it('reports a failure of the Files fallback itself', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'image/webp', file_name: 'sticker.webp' });
    mockSaveToPhotoLibrary.mockRejectedValue(new MediaExportError('EUNSUPPORTED'));
    mockExportFiles.mockRejectedValue(new MediaExportError('ENOSPC'));
    answerAlert('Save to Files instead');

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'noSpace' });
  });

  it('maps an unrecognised throw to failed and reports the code only', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockSaveToPhotoLibrary.mockRejectedValue({ weird: true });

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'failed' });
    expect(mockCaptureError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { export_code: 'EUNKNOWN' },
    });
  });

  it('reports EEXPORT to Sentry with the code only', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockSaveToPhotoLibrary.mockRejectedValue(new MediaExportError('EEXPORT'));

    await saveMediaItem('media-1');

    expect(mockCaptureError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { export_code: 'EEXPORT' },
    });
  });

  it('does NOT report a user-recoverable outcome to Sentry', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockSaveToPhotoLibrary.mockRejectedValue(new MediaExportError('ENOSPC'));

    await saveMediaItem('media-1');

    expect(mockCaptureError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Logging hygiene
// ---------------------------------------------------------------------------

describe('logging never carries names, paths or ids', () => {
  const SECRETS = [
    'Beach day',
    'Beach day.jpg',
    '/media/media-1.jpg',
    'media-1',
    'conv-1',
  ];

  async function drainEveryBranch(): Promise<void> {
    const branches: Array<() => void> = [
      () => mockDownload.mockRejectedValue(new Error('boom')),
      () => mockDownload.mockRejectedValue(new InsufficientSpaceError()),
      () => mockStat.mockResolvedValue({ size: 0 } as never),
      () => mockStat.mockRejectedValue(new Error('gone')),
      () => mockSaveToPhotoLibrary.mockRejectedValue(new MediaExportError('EEXPORT')),
      () => mockSaveToPhotoLibrary.mockRejectedValue(new MediaExportError('EPERMISSION')),
      () => mockGetAccess.mockReturnValue({ conversation_id: null, author_id: null }),
      () => mockGetMedia.mockReturnValue(null),
      () => mockGetMedia.mockReturnValue(row({ content_type: 'text/html' })),
    ];
    for (const arrange of branches) {
      acknowledgeDisclosure();
      arrangeHappyPath();
      arrange();
      await saveMediaItem('media-1');
    }
  }

  it('console.warn only ever receives the prefix and a code', async () => {
    await drainEveryBranch();

    expect(warnSpy).toHaveBeenCalled();
    for (const call of warnSpy.mock.calls) {
      expect(call[0]).toBe('[mediaExport]');
      expect(call).toHaveLength(2);
      expect(typeof call[1]).toBe('string');
      // Codes only: upper-case letters, no punctuation, no spaces.
      expect(call[1] as string).toMatch(/^(?:[A-Z]+|aborted|staging sweep failed)$/);
      const serialized = JSON.stringify(call);
      for (const secret of SECRETS) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  it('captureError only ever receives a fixed Error plus the code tag', async () => {
    await drainEveryBranch();

    for (const call of mockCaptureError.mock.calls) {
      const [error, context] = call as [Error, { tags: Record<string, string> }];
      expect(error.message).toBe('media export failed');
      expect(Object.keys(context)).toEqual(['tags']);
      expect(Object.keys(context.tags)).toEqual(['export_code']);
      const serialized = JSON.stringify([error.message, context]);
      for (const secret of SECRETS) {
        expect(serialized).not.toContain(secret);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Staging sweep and copy
// ---------------------------------------------------------------------------

describe('clearMediaExportStaging', () => {
  it('targets the orbital-export subdirectory of Caches', () => {
    expect(EXPORT_STAGING_DIR).toBe('/tmp/test-cache/orbital-export');
  });

  it('is a no-op when the directory does not exist', async () => {
    mockExists.mockResolvedValue(false);
    await clearMediaExportStaging();
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('unlinks the whole directory when it exists', async () => {
    mockExists.mockResolvedValue(true);
    mockUnlink.mockResolvedValue(undefined);
    await clearMediaExportStaging();
    expect(mockUnlink).toHaveBeenCalledWith(EXPORT_STAGING_DIR);
  });

  it('never throws', async () => {
    mockExists.mockRejectedValue(new Error('fs down'));
    await expect(clearMediaExportStaging()).resolves.toBeUndefined();
  });
});

describe('describeExportOutcome', () => {
  it.each([
    [{ outcome: 'saved', destination: 'photos' }, 'Saved to Photos'],
    [{ outcome: 'saved', destination: 'files' }, 'Saved to Files'],
    [{ outcome: 'cancelled' }, 'Save cancelled'],
    [{ outcome: 'unavailable' }, 'No longer available'],
    [{ outcome: 'notAllowed' }, 'Not available to save'],
    [{ outcome: 'noSpace' }, 'Not enough storage'],
    [{ outcome: 'permission' }, 'Permission needed'],
    [{ outcome: 'unsupported' }, "Can't save this file type"],
    [{ outcome: 'corrupt' }, "This file can't be saved"],
    [{ outcome: 'failed' }, "Couldn't save"],
  ] as const)('%j reads as %s', (result, copy) => {
    expect(describeExportOutcome(result)).toBe(copy);
    // No copy may name a file, a path or an id.
    expect(copy).not.toMatch(/\/|\.jpg|media-/);
  });
});
