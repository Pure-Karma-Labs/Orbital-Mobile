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
import { exists, read, stat, unlink } from '@dr.pogodin/react-native-fs';
import {
  MediaExportError,
  exportFiles,
  requestPhotoAddPermission,
  saveToPhotoLibrary,
} from 'orbital-media-export';
import { AuthError, NotFoundError } from '../api/errors';
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

const mockState: {
  conversations: Record<string, unknown>;
  media: Record<string, unknown>;
  blockedUserIds: string[];
} = { conversations: {}, media: {}, blockedUserIds: [] };

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
    // The real sentinel string: mediaDownloadService normalizes every
    // abort-path rejection to `new Error(DOWNLOAD_ABORTED_MESSAGE)`, and the
    // export error mapping recognises it BY MESSAGE, so the test must use the
    // same constant the service imports.
    DOWNLOAD_ABORTED_MESSAGE: 'Download aborted',
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
  clearExportDisclosureCache,
  clearMediaExportStaging,
  currentExportEpoch,
  describeExportOutcome,
  ensureExportDisclosure,
  assertDisclosureAcknowledged,
  isMediaExportAllowed,
  registerExportAbort,
  resetMediaExportForTesting,
  saveMediaItem,
  beginExportCaptureBudget,
  discardStagedBulkDocuments,
  endExportCaptureBudget,
  ensureBulkExportPermission,
  exportMediaItemInBulk,
  flushStagedBulkDocuments,
  stagedBulkDocumentCount,
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
const mockRead = read as jest.MockedFunction<typeof read>;

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
  mockState.blockedUserIds = [];
  mockDownload.mockResolvedValue('/media/media-1.jpg');
  mockStat.mockResolvedValue({ size: 1024 } as unknown as Awaited<ReturnType<typeof stat>>);
  // RE-ARM the head read to "nothing recognizable" (#880). jest.clearAllMocks()
  // keeps implementations, but an earlier test's `arrangeHead` would otherwise
  // leak a JPEG head into every later save in the file. Opting IN to a head is
  // what makes the sniff assertions mean something.
  mockRead.mockResolvedValue('');
}

/** Base64 of raw bytes, the way RNFS hands a head read back. */
function toBase64(bytes: readonly number[]): string {
  const g = globalThis as unknown as { btoa: (s: string) => string };
  return g.btoa(String.fromCharCode(...bytes));
}

/** Make the decrypted file's head read as exactly these bytes. */
function arrangeHead(bytes: readonly number[]): void {
  mockRead.mockResolvedValue(toBase64(bytes));
}

function asciiBytes(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

/** `FF D8 FF` plus enough of a real JFIF header to look like a file. */
const JPEG_HEAD: readonly number[] = [
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
];

/** An ISO-BMFF `ftyp` box: size, 'ftyp', major brand, minor version, brands. */
function ftypHead(major: string, compatible: readonly string[] = []): number[] {
  const body = [
    ...asciiBytes('ftyp'),
    ...asciiBytes(major),
    0x00,
    0x00,
    0x02,
    0x00, // minor version
    ...compatible.flatMap(asciiBytes),
  ];
  const size = 4 + body.length;
  return [(size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff, ...body];
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
  mockState.blockedUserIds = [];
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
    // No recognizable head: the declared type stands, which is what every
    // unreadable, short or unknown-format file falls back to.
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

  it('labels an image/heic row holding JPEG bytes as a JPEG (#880)', async () => {
    acknowledgeDisclosure();
    // The bug this issue is about: the upload pipeline re-encodes every still
    // image that is not already JPEG/PNG, so an Android `image/heic` row names
    // JPEG bytes. MediaStore then advertised `image/heic` over a JPEG and the
    // gallery reported the saved file as incompatible.
    arrangeHappyPath({ content_type: 'image/heic', file_name: 'IMG_0042.HEIC' });
    arrangeHead(JPEG_HEAD);

    const result = await saveMediaItem('media-1');

    expect(result).toEqual({ outcome: 'saved', destination: 'photos' });
    expect(mockSaveToPhotoLibrary).toHaveBeenCalledWith({
      sourcePath: '/media/media-1.jpg',
      mimeType: 'image/jpeg',
      displayName: 'IMG_0042.jpg',
      createdAtMs: Date.UTC(2026, 4, 1, 10, 0, 0),
    });
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
// Byte-level labelling (#880)
// ---------------------------------------------------------------------------

describe('labelling from the decrypted bytes', () => {
  it('accepts image/jpg, the type EVERY iOS-posted photo carries', async () => {
    acknowledgeDisclosure();
    // Before #880 this matched no entry in either export map, so save-to-device
    // refused every photo posted from an iPhone.
    arrangeHappyPath({ content_type: 'image/jpg', file_name: 'IMG_1001.jpg' });

    const result = await saveMediaItem('media-1');

    expect(result).toEqual({ outcome: 'saved', destination: 'photos' });
    expect(mockSaveToPhotoLibrary).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: 'image/jpeg',
        displayName: 'IMG_1001.jpg',
      }),
    );
  });

  it('reads the head with (path, SNIFF_HEAD_BYTES, 0, base64) after the download and stat, before the write', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'image/heic', file_name: 'IMG_0042.HEIC' });
    const order: string[] = [];
    mockDownload.mockImplementation(async () => {
      order.push('download');
      return '/media/media-1.jpg';
    });
    mockStat.mockImplementation(async () => {
      order.push('stat');
      return { size: 1024 } as unknown as Awaited<ReturnType<typeof stat>>;
    });
    mockRead.mockImplementation(async () => {
      order.push('read');
      return toBase64(JPEG_HEAD);
    });
    mockSaveToPhotoLibrary.mockImplementation(async () => {
      order.push('write');
    });

    await saveMediaItem('media-1');

    expect(order).toEqual(['download', 'stat', 'read', 'write']);
    expect(mockRead).toHaveBeenCalledWith('/media/media-1.jpg', 128, 0, 'base64');
  });

  it('keeps the declared type when the head is too short to identify, with no ESNIFF', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'image/heic', file_name: 'IMG_0042.HEIC' });
    // A 4-byte read is a SHORT read, not a failure: the sniff is advisory.
    arrangeHead([0x00, 0x01, 0x02, 0x03]);

    await saveMediaItem('media-1');

    expect(mockSaveToPhotoLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/heic', displayName: 'IMG_0042.heic' }),
    );
    expect(warnSpy.mock.calls.map((c) => c[1])).not.toContain('ESNIFF');
  });

  it('falls back to the declared type when the head read FAILS, logging a code only', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'image/heic', file_name: 'IMG_0042.HEIC' });
    // A real EACCES/EPERM message carries the path. It must not reach a log.
    mockRead.mockRejectedValue(new Error('EACCES open /media/media-1.jpg'));

    const result = await saveMediaItem('media-1');

    expect(result).toEqual({ outcome: 'saved', destination: 'photos' });
    expect(mockSaveToPhotoLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/heic', displayName: 'IMG_0042.heic' }),
    );
    expect(warnSpy).toHaveBeenCalledWith('[mediaExport]', 'ESNIFF');
    for (const call of warnSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('/media/media-1.jpg');
      expect(serialized).not.toContain('IMG_0042');
    }
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it('does not read the file at all when the disclosure is cancelled', async () => {
    arrangeHappyPath();
    answerAlert('Cancel');

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'cancelled' });
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('does not read the file at all for a REFUSED declared type', async () => {
    acknowledgeDisclosure();
    // A byte check can never rescue a refused type, and the bytes here are a
    // perfectly good JPEG — refusal still wins, before any download.
    arrangeHappyPath({ content_type: 'text/html', file_name: 'page.html' });
    arrangeHead(JPEG_HEAD);

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'unsupported' });
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('corrects the label on the Files route after a permission denial', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'image/heic', file_name: 'IMG_0042.HEIC' });
    arrangeHead(JPEG_HEAD);
    mockRequestPhotoPermission.mockResolvedValue('denied');
    answerAlert('Save to Files instead');

    expect(await saveMediaItem('media-1')).toEqual({
      outcome: 'saved',
      destination: 'files',
    });
    expect(mockExportFiles).toHaveBeenCalledWith([
      {
        sourcePath: '/media/media-1.jpg',
        mimeType: 'image/jpeg',
        displayName: 'IMG_0042.jpg',
      },
    ]);
  });

  it('carries the corrected label into the EUNSUPPORTED Files retry', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'image/heic', file_name: 'IMG_0042.HEIC' });
    arrangeHead(JPEG_HEAD);
    mockSaveToPhotoLibrary.mockRejectedValue(new MediaExportError('EUNSUPPORTED'));
    answerAlert('Save to Files instead');

    expect(await saveMediaItem('media-1')).toEqual({
      outcome: 'saved',
      destination: 'files',
    });
    expect(mockExportFiles).toHaveBeenCalledWith([
      expect.objectContaining({ mimeType: 'image/jpeg', displayName: 'IMG_0042.jpg' }),
    ]);
    // One download, one head read — the retry reuses both.
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it('never escalates a DOCUMENT save into a photo-library write', async () => {
    acknowledgeDisclosure();
    // image/tiff is a document type. JPEG bytes correct the extension, but the
    // KIND was fixed before the download — the permission was acquired for it.
    arrangeHappyPath({ content_type: 'image/tiff', file_name: 'scan.tiff' });
    arrangeHead(JPEG_HEAD);

    expect(await saveMediaItem('media-1')).toEqual({
      outcome: 'saved',
      destination: 'files',
    });
    expect(mockExportFiles).toHaveBeenCalledWith([
      expect.objectContaining({ mimeType: 'image/jpeg', displayName: 'scan.jpg' }),
    ]);
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
    expect(mockRequestPhotoPermission).not.toHaveBeenCalled();
  });

  it('does not write after an abort that lands while the head read is pending', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'image/heic', file_name: 'IMG_0042.HEIC' });
    const controller = new AbortController();
    let settleRead!: (b64: string) => void;
    mockRead.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          settleRead = resolve;
        }),
    );

    const pending = saveMediaItem('media-1', controller.signal);
    await flush();
    // Proof the abort lands DURING the label step, not before it.
    expect(mockRead).toHaveBeenCalled();
    controller.abort();
    settleRead(toBase64(JPEG_HEAD));

    expect(await pending).toEqual({ outcome: 'cancelled' });
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Accepted edges (plan "Risks / accepted edges"), pinned so a later change
  // has to argue with a test rather than quietly alter the behaviour.
  // -------------------------------------------------------------------------

  it('keeps the declared label when AVIF bytes would leave the photo route', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'image/heic', file_name: 'IMG_0042.HEIC' });
    arrangeHead(ftypHead('avif', ['avif', 'mif1', 'miaf']));

    expect(await saveMediaItem('media-1')).toEqual({
      outcome: 'saved',
      destination: 'photos',
    });
    // image/avif is on the DOCUMENT allowlist, and the permission in hand is a
    // photo-library one. Relabelling would hand PhotoKit a .avif resource on a
    // grant acquired for a photo save, so the declared label stands.
    expect(mockSaveToPhotoLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/heic', displayName: 'IMG_0042.heic' }),
    );
    expect(mockRequestPhotoPermission).toHaveBeenCalledTimes(1);
    expect(mockExportFiles).not.toHaveBeenCalled();
  });

  it('DOES relabel a document-route row to AVIF (its destination takes anything)', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'image/tiff', file_name: 'scan.tiff' });
    arrangeHead(ftypHead('avif', ['avif', 'mif1']));

    expect(await saveMediaItem('media-1')).toEqual({
      outcome: 'saved',
      destination: 'files',
    });
    expect(mockExportFiles).toHaveBeenCalledWith([
      expect.objectContaining({ mimeType: 'image/avif', displayName: 'scan.avif' }),
    ]);
  });

  it('MP4 bytes under an image/jpeg label stay on the photo route as video/mp4', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'image/jpeg', file_name: 'Beach day.jpg' });
    arrangeHead(ftypHead('isom', ['isom', 'iso2', 'avc1', 'mp41']));

    expect(await saveMediaItem('media-1')).toEqual({
      outcome: 'saved',
      destination: 'photos',
    });
    // Cross-family within the same kind: the copy lands in the Movies bucket
    // instead of Pictures. The permissions are identical, so this is accepted.
    expect(mockSaveToPhotoLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'video/mp4', displayName: 'Beach day.mp4' }),
    );
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

  it('is shown again after a logout clears MMKV and the in-memory mirror', async () => {
    arrangeHappyPath();
    answerAlert('Continue');
    await saveMediaItem('media-1');
    expect(alertSpy).toHaveBeenCalledTimes(1);

    // Logout does not reload the bundle. Clearing MMKV alone leaves the
    // mirror set — which is why localWipe must also drop it.
    mockMMKV.store.clear();
    await saveMediaItem('media-1');
    expect(alertSpy).toHaveBeenCalledTimes(1);

    // What localWipe does after clearAll(): the production reset, not the
    // test seam. The next save is asked again.
    clearExportDisclosureCache();
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

  // -------------------------------------------------------------------------
  // #879 review: on API 24-28 BOTH destinations are shared storage —
  // Pictures/Movies for the gallery, Download/Orbital for documents — so both
  // need WRITE_EXTERNAL_STORAGE. Requesting it for the photo route only turned
  // a denied document save into a generic "Couldn't save" with no prompt.
  // -------------------------------------------------------------------------

  it('Android 28: a DOCUMENT save requests storage permission before downloading', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'application/pdf', file_name: 'Statement.pdf' });
    setAndroid(28);
    const order: string[] = [];
    const request = jest.spyOn(PermissionsAndroid, 'request').mockImplementation(async () => {
      order.push('permission');
      return 'granted' as never;
    });
    mockDownload.mockImplementation(async () => {
      order.push('download');
      return '/media/media-1.jpg';
    });

    expect(await saveMediaItem('media-1')).toEqual({
      outcome: 'saved',
      destination: 'files',
    });
    expect(request).toHaveBeenCalledWith(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
    expect(order).toEqual(['permission', 'download']);
    request.mockRestore();
  });

  it('Android 28: a DENIED document save reports permission and downloads nothing', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'application/pdf', file_name: 'Statement.pdf' });
    setAndroid(28);
    const request = jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue('denied' as never);

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'permission' });
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockExportFiles).not.toHaveBeenCalled();
    request.mockRestore();
  });

  it('Android 28: never_ask_again on a document save routes to Settings with file copy', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'application/pdf', file_name: 'Statement.pdf' });
    setAndroid(28);
    const request = jest
      .spyOn(PermissionsAndroid, 'request')
      .mockResolvedValue('never_ask_again' as never);
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    answerAlert('Open Settings');

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'permission' });
    expect(alertSpy.mock.calls[0][0]).toBe('Storage access needed');
    // Route-aware copy: a document save must not talk about "your gallery".
    expect(alertSpy.mock.calls[0][1]).toContain('save files to your device');
    expect(openSettings).toHaveBeenCalled();
    request.mockRestore();
    openSettings.mockRestore();
  });

  it('Android 29+: a document save requests nothing at all', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'application/pdf', file_name: 'Statement.pdf' });
    setAndroid(33);
    const request = jest.spyOn(PermissionsAndroid, 'request');

    expect(await saveMediaItem('media-1')).toEqual({
      outcome: 'saved',
      destination: 'files',
    });
    expect(request).not.toHaveBeenCalled();
    expect(mockRequestPhotoPermission).not.toHaveBeenCalled();
    request.mockRestore();
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

  // -------------------------------------------------------------------------
  // #879 review: three EXPECTED download failures were landing on the
  // unclassifiable tail — `failed` plus a spurious `EUNKNOWN` Sentry event.
  // Noise there is not harmless: it is what buries a real writer bug.
  // -------------------------------------------------------------------------

  it('maps evicted media (NotFoundError) to unavailable with NO Sentry event', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockDownload.mockRejectedValue(new NotFoundError());

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'unavailable' });
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it('maps a dead session (AuthError) to failed with NO Sentry event', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockDownload.mockRejectedValue(new AuthError(401));

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'failed' });
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it('maps a JOINED abort (the shared download owner walked away) to failed, no Sentry', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    // Not OUR signal: mediaDownloadService normalizes the owner's abort to
    // this sentinel. `failed`, not `cancelled`, is deliberate — the user did
    // not cancel, so they should be invited to retry (media/abortable.ts
    // header, and the reason it has no retry-once rule).
    mockDownload.mockRejectedValue(new Error('Download aborted'));

    expect(await saveMediaItem('media-1')).toEqual({ outcome: 'failed' });
    expect(mockCaptureError).not.toHaveBeenCalled();
  });

  it('still distinguishes OUR abort (cancelled) from a joined one (failed)', async () => {
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
    controller.abort();

    expect(await pending).toEqual({ outcome: 'cancelled' });
    expect(mockCaptureError).not.toHaveBeenCalled();
    settleDownload('/media/media-1.jpg');
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
      // ESNIFF: the rejection message of a real failed read carries the path.
      () => mockRead.mockRejectedValue(new Error('EACCES open /media/media-1.jpg')),
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

// ---------------------------------------------------------------------------
// The bulk half (#878 PR 2)
//
// `bulkExportRunner` drives these three. The run acquires the disclosure and
// the permission ONCE, so the properties worth pinning here are the ones that
// differ from `saveMediaItem`: no per-item prompt, no "Save to Files instead"
// offer, and iOS documents staged for a single picker rather than written.
// ---------------------------------------------------------------------------

const BULK_PHOTO = { photosToFiles: false, batchDocuments: false };
const BULK_IOS = { photosToFiles: false, batchDocuments: true };

describe('ensureBulkExportPermission', () => {
  it('asks for photo access once when the batch contains photos (iOS)', async () => {
    (Platform as { OS: string }).OS = 'ios';
    mockRequestPhotoPermission.mockResolvedValue('granted');

    const result = await ensureBulkExportPermission({ photo: true, document: false });

    expect(result).toEqual({ granted: true, photosToFiles: false });
    expect(mockRequestPhotoPermission).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing when the batch is documents only (iOS)', async () => {
    (Platform as { OS: string }).OS = 'ios';

    const result = await ensureBulkExportPermission({ photo: false, document: true });

    expect(result).toEqual({ granted: true, photosToFiles: false });
    expect(mockRequestPhotoPermission).not.toHaveBeenCalled();
  });

  it('refuses the whole run when photo access is denied and Files declined', async () => {
    (Platform as { OS: string }).OS = 'ios';
    mockRequestPhotoPermission.mockResolvedValue('denied');
    answerAlert('Cancel');

    const result = await ensureBulkExportPermission({ photo: true, document: false });

    expect(result).toEqual({ granted: false, photosToFiles: false });
  });

  it('reroutes every photo to Files when the user picks that instead', async () => {
    (Platform as { OS: string }).OS = 'ios';
    mockRequestPhotoPermission.mockResolvedValue('denied');
    answerAlert('Save to Files instead');

    const result = await ensureBulkExportPermission({ photo: true, document: false });

    expect(result).toEqual({ granted: true, photosToFiles: true });
  });

  it('requests shared storage once on Android 28, for either route', async () => {
    setAndroid(28);
    const request = jest
      .spyOn(PermissionsAndroid, 'request')
      .mockResolvedValue('granted' as never);

    const result = await ensureBulkExportPermission({ photo: true, document: true });

    expect(result).toEqual({ granted: true, photosToFiles: false });
    // Both routes need WRITE_EXTERNAL_STORAGE there; the second request is a
    // no-op at the OS level, so asking twice is harmless but must still grant.
    expect(request).toHaveBeenCalled();
  });

  it('needs nothing on Android 29+', async () => {
    setAndroid(33);
    const request = jest.spyOn(PermissionsAndroid, 'request');

    const result = await ensureBulkExportPermission({ photo: true, document: true });

    expect(result).toEqual({ granted: true, photosToFiles: false });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('exportMediaItemInBulk', () => {
  it('writes to the photo library without prompting for anything', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    (Platform as { OS: string }).OS = 'ios';

    const result = await exportMediaItemInBulk(
      'media-1',
      new AbortController().signal,
      BULK_PHOTO,
    );

    expect(result).toEqual({ outcome: 'saved', destination: 'photos' });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockRequestPhotoPermission).not.toHaveBeenCalled();
    expect(mockSaveToPhotoLibrary).toHaveBeenCalledTimes(1);
  });

  it('refuses a peer-crafted content type before any download', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'text/html' });

    const result = await exportMediaItemInBulk(
      'media-1',
      new AbortController().signal,
      BULK_PHOTO,
    );

    expect(result).toEqual({ outcome: 'unsupported' });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('cancels, without downloading, when the disclosure is not acknowledged', async () => {
    arrangeHappyPath();
    dismissAlert();

    const result = await exportMediaItemInBulk(
      'media-1',
      new AbortController().signal,
      BULK_PHOTO,
    );

    expect(result).toEqual({ outcome: 'cancelled' });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('refuses an orphan before any download', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockGetAccess.mockReturnValue({ conversation_id: null, author_id: 'u-2' });

    const result = await exportMediaItemInBulk(
      'media-1',
      new AbortController().signal,
      BULK_PHOTO,
    );

    expect(result).toEqual({ outcome: 'notAllowed' });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('returns cancelled for an already-aborted run without downloading', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    const controller = new AbortController();
    controller.abort();

    const result = await exportMediaItemInBulk('media-1', controller.signal, BULK_PHOTO);

    expect(result).toEqual({ outcome: 'cancelled' });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('refuses a 0-byte decrypted file (DEBT-186), like the single-item path', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockStat.mockResolvedValue({ size: 0 } as unknown as Awaited<ReturnType<typeof stat>>);

    const result = await exportMediaItemInBulk(
      'media-1',
      new AbortController().signal,
      BULK_PHOTO,
    );

    expect(result).toEqual({ outcome: 'corrupt' });
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
  });

  it('does NOT offer "Save to Files instead" when Photos refuses an item', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    (Platform as { OS: string }).OS = 'ios';
    mockSaveToPhotoLibrary.mockRejectedValue(new MediaExportError('EUNSUPPORTED'));

    const result = await exportMediaItemInBulk(
      'media-1',
      new AbortController().signal,
      BULK_PHOTO,
    );

    // A batch cannot stop to ask: the user saves that one item by hand.
    expect(result).toEqual({ outcome: 'unsupported' });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockExportFiles).not.toHaveBeenCalled();
  });

  it('honours the photosToFiles reroute for the whole run', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    (Platform as { OS: string }).OS = 'ios';
    mockExportFiles.mockResolvedValue('saved');

    const result = await exportMediaItemInBulk('media-1', new AbortController().signal, {
      photosToFiles: true,
      batchDocuments: false,
    });

    expect(result).toEqual({ outcome: 'saved', destination: 'files' });
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
  });

  it('STAGES an iOS document instead of presenting a picker per item', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'application/pdf', file_name: 'Lease.pdf' });
    (Platform as { OS: string }).OS = 'ios';

    const result = await exportMediaItemInBulk(
      'media-1',
      new AbortController().signal,
      BULK_IOS,
    );

    expect(result).toEqual({ outcome: 'deferred' });
    expect(mockExportFiles).not.toHaveBeenCalled();
    expect(stagedBulkDocumentCount()).toBe(1);
  });

  it('writes an Android document immediately — there is no picker to batch', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath({ content_type: 'application/pdf' });
    setAndroid(33);
    mockExportFiles.mockResolvedValue('saved');

    const result = await exportMediaItemInBulk(
      'media-1',
      new AbortController().signal,
      BULK_PHOTO,
    );

    expect(result).toEqual({ outcome: 'saved', destination: 'files' });
    expect(stagedBulkDocumentCount()).toBe(0);
  });

  it('never throws, even when the native writer rejects with nothing useful', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockSaveToPhotoLibrary.mockRejectedValue('not an error at all');

    await expect(
      exportMediaItemInBulk('media-1', new AbortController().signal, BULK_PHOTO),
    ).resolves.toEqual({ outcome: 'failed' });
  });

  it('is voided by a wipe between the download and the write', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockDownload.mockImplementation(() => {
      cancelAllExports();
      return Promise.resolve('/media/media-1.jpg');
    });

    const result = await exportMediaItemInBulk(
      'media-1',
      new AbortController().signal,
      BULK_PHOTO,
    );

    expect(result).toEqual({ outcome: 'cancelled' });
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
  });
});

describe('flushStagedBulkDocuments', () => {
  async function stage(count: number): Promise<void> {
    acknowledgeDisclosure();
    (Platform as { OS: string }).OS = 'ios';
    for (let i = 0; i < count; i++) {
      arrangeHappyPath({ id: `media-${i}`, content_type: 'application/pdf' });
      await exportMediaItemInBulk(`media-${i}`, new AbortController().signal, BULK_IOS);
    }
  }

  it('presents every staged document in ONE picker call', async () => {
    await stage(3);
    mockExportFiles.mockResolvedValue('saved');

    const presented = await flushStagedBulkDocuments();

    expect(presented).toEqual({ outcome: 'saved', count: 3 });
    expect(mockExportFiles).toHaveBeenCalledTimes(1);
    expect(mockExportFiles.mock.calls[0][0]).toHaveLength(3);
    // The list is emptied, so a second run cannot re-present stale paths.
    expect(stagedBulkDocumentCount()).toBe(0);
  });

  it('reports a dismissed picker as cancelled, with the staged count', async () => {
    await stage(2);
    mockExportFiles.mockResolvedValue('cancelled');

    expect(await flushStagedBulkDocuments()).toEqual({ outcome: 'cancelled', count: 2 });
  });

  it('reports a rejected picker as failed', async () => {
    await stage(2);
    mockExportFiles.mockRejectedValue(new MediaExportError('EEXPORT'));

    expect(await flushStagedBulkDocuments()).toEqual({ outcome: 'failed', count: 2 });
  });

  it('is a no-op with nothing staged', async () => {
    acknowledgeDisclosure();
    expect(await flushStagedBulkDocuments()).toEqual({ outcome: 'skipped', count: 0 });
    expect(mockExportFiles).not.toHaveBeenCalled();
  });

  it('presents nothing after a wipe cleared the staging list', async () => {
    await stage(2);
    cancelAllExports();

    expect(stagedBulkDocumentCount()).toBe(0);
    expect(await flushStagedBulkDocuments()).toEqual({ outcome: 'skipped', count: 0 });
    expect(mockExportFiles).not.toHaveBeenCalled();
  });

  it('presents nothing after discardStagedBulkDocuments', async () => {
    await stage(2);
    discardStagedBulkDocuments();

    expect(await flushStagedBulkDocuments()).toEqual({ outcome: 'skipped', count: 0 });
  });
});

// ---------------------------------------------------------------------------
// #889 review hardening
//
// Three properties the first cut of PR 2 got wrong, all of them silent:
// blocking an author mid-run did not stop their queued media, a staged iOS
// document had its access checked at DOWNLOAD time only, and the write lock
// re-checked the wipe epoch but not the caller's own cancellation.
// ---------------------------------------------------------------------------

describe('blocked authors are refused in BULK only', () => {
  it('refuses a blocked author before any download', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockState.blockedUserIds = ['u-2'];

    const result = await exportMediaItemInBulk(
      'media-1',
      new AbortController().signal,
      BULK_PHOTO,
    );

    expect(result).toEqual({ outcome: 'notAllowed' });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('refuses an author blocked DURING the download', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockDownload.mockImplementation(() => {
      // The user blocks them while the file is in flight.
      mockState.blockedUserIds = ['u-2'];
      return Promise.resolve('/media/media-1.jpg');
    });

    const result = await exportMediaItemInBulk(
      'media-1',
      new AbortController().signal,
      BULK_PHOTO,
    );

    expect(result).toEqual({ outcome: 'notAllowed' });
    expect(mockSaveToPhotoLibrary).not.toHaveBeenCalled();
  });

  it('still SAVES a blocked author one item at a time', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    (Platform as { OS: string }).OS = 'ios';
    mockRequestPhotoPermission.mockResolvedValue('granted');
    mockState.blockedUserIds = ['u-2'];

    // Alex 2026-10-09: blocked authors are excluded from a BATCH and allowed
    // per item. A single save is a deliberate act on one visible file.
    const result = await saveMediaItem('media-1');

    expect(result).toEqual({ outcome: 'saved', destination: 'photos' });
  });

  it('does not treat a NULL author as blocked', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockGetAccess.mockReturnValue({ conversation_id: 'conv-1', author_id: null });
    mockState.blockedUserIds = ['u-2'];

    const result = await exportMediaItemInBulk(
      'media-1',
      new AbortController().signal,
      BULK_PHOTO,
    );

    // The same deliberate COALESCE trade-off the snapshot SQL makes: a deleted
    // reply leaves its media with no resolvable author.
    expect(result).toEqual({ outcome: 'saved', destination: 'photos' });
  });
});

describe('flushStagedBulkDocuments re-checks access at WRITE time', () => {
  async function stageOne(id: string): Promise<void> {
    arrangeHappyPath({ id, content_type: 'application/pdf' });
    await exportMediaItemInBulk(id, new AbortController().signal, BULK_IOS);
  }

  beforeEach(() => {
    acknowledgeDisclosure();
    (Platform as { OS: string }).OS = 'ios';
  });

  it('drops an entry whose author was blocked after it was staged', async () => {
    await stageOne('media-0');
    await stageOne('media-1');
    expect(stagedBulkDocumentCount()).toBe(2);

    mockState.blockedUserIds = ['u-2'];
    mockExportFiles.mockResolvedValue('saved');

    const outcome = await flushStagedBulkDocuments();

    // Nothing is presented, and the caller counts the shortfall as skipped.
    expect(outcome).toEqual({ outcome: 'skipped', count: 0 });
    expect(mockExportFiles).not.toHaveBeenCalled();
  });

  it('drops an entry whose conversation was left after it was staged', async () => {
    await stageOne('media-0');
    mockState.conversations = {};
    mockExportFiles.mockResolvedValue('saved');

    expect(await flushStagedBulkDocuments()).toEqual({ outcome: 'skipped', count: 0 });
    expect(mockExportFiles).not.toHaveBeenCalled();
  });

  it('drops an entry whose row was deleted after it was staged', async () => {
    await stageOne('media-0');
    mockGetAccess.mockReturnValue(null);
    mockExportFiles.mockResolvedValue('saved');

    expect(await flushStagedBulkDocuments()).toEqual({ outcome: 'skipped', count: 0 });
    expect(mockExportFiles).not.toHaveBeenCalled();
  });

  it('presents only the entries that still pass, and reports that count', async () => {
    await stageOne('media-keep');
    await stageOne('media-drop');
    mockExportFiles.mockResolvedValue('saved');
    // Only the second id has lost access.
    mockGetAccess.mockImplementation((id: string) =>
      id === 'media-drop'
        ? { conversation_id: 'conv-gone', author_id: 'u-2' }
        : { conversation_id: 'conv-1', author_id: 'u-2' },
    );

    const outcome = await flushStagedBulkDocuments();

    expect(outcome).toEqual({ outcome: 'saved', count: 1 });
    expect(mockExportFiles.mock.calls[0][0]).toHaveLength(1);
  });

  it('does not present after a wipe that lands while it is awaiting', async () => {
    await stageOne('media-0');
    await stageOne('media-1');
    mockExportFiles.mockResolvedValue('saved');
    // The epoch is read as the FIRST statement, so a wipe anywhere after that
    // — including during the disclosure await — voids the write.
    const originalRead = mockGetAccess.getMockImplementation();
    mockGetAccess.mockImplementation((id: string) => {
      cancelAllExports();
      return originalRead
        ? originalRead(id)
        : { conversation_id: 'conv-1', author_id: 'u-2' };
    });

    const outcome = await flushStagedBulkDocuments();

    expect(mockExportFiles).not.toHaveBeenCalled();
    expect(outcome.outcome).not.toBe('saved');
  });

  it('reports cancelled when a wipe lands while the picker is open', async () => {
    await stageOne('media-0');
    // The picker is a native modal that waits for a human, so this is the
    // realistic window — far wider than the microtask hop before it.
    mockExportFiles.mockImplementation(() => {
      cancelAllExports();
      return Promise.resolve('saved');
    });

    const outcome = await flushStagedBulkDocuments();

    // A copy may already exist on disk; nothing can undo that. But the run
    // must not report it as saved under an account that no longer exists.
    expect(outcome).toEqual({ outcome: 'cancelled', count: 1 });
  });
});

describe('the write lock re-checks the CALLER, not just the epoch', () => {
  it('does not write after the caller aborted while waiting for the lock', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    (Platform as { OS: string }).OS = 'ios';

    // Hold the lock with a first write that never settles, so the second save
    // is parked inside performExport — exactly where a bulk run's open
    // document picker parks a lightbox save.
    let releaseFirst = (): void => {};
    mockSaveToPhotoLibrary.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );

    const outer = new AbortController();
    const first = exportMediaItemInBulk('media-1', new AbortController().signal, BULK_PHOTO);
    await flush();
    const second = exportMediaItemInBulk('media-1', outer.signal, BULK_PHOTO);
    await flush();

    // The lightbox closes (or the bulk run is cancelled) while queued.
    outer.abort();
    releaseFirst();

    expect(await first).toEqual({ outcome: 'saved', destination: 'photos' });
    expect(await second).toEqual({ outcome: 'cancelled' });
    // One write, not two: the parked one was dropped at the lock.
    expect(mockSaveToPhotoLibrary).toHaveBeenCalledTimes(1);
  });
});

describe('Sentry capture budget', () => {
  afterEach(() => {
    endExportCaptureBudget();
  });

  it('reports one event per CODE while a budget is open', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockSaveToPhotoLibrary.mockRejectedValue(new MediaExportError('EEXPORT'));
    beginExportCaptureBudget();

    for (let i = 0; i < 5; i++) {
      await exportMediaItemInBulk('media-1', new AbortController().signal, BULK_PHOTO);
    }

    // A systemic writer failure fails every item the same way; 500 identical
    // Sentry events from one tap is noise that buries the next real bug.
    expect(mockCaptureError).toHaveBeenCalledTimes(1);
  });

  it('reports each DISTINCT code once', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    beginExportCaptureBudget();

    mockSaveToPhotoLibrary.mockRejectedValueOnce(new MediaExportError('EEXPORT'));
    await exportMediaItemInBulk('media-1', new AbortController().signal, BULK_PHOTO);
    mockSaveToPhotoLibrary.mockRejectedValueOnce(new MediaExportError('EINVALIDNAME'));
    await exportMediaItemInBulk('media-1', new AbortController().signal, BULK_PHOTO);

    expect(mockCaptureError).toHaveBeenCalledTimes(2);
  });

  it('reports every time when no budget is open (the lightbox path)', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    (Platform as { OS: string }).OS = 'ios';
    mockRequestPhotoPermission.mockResolvedValue('granted');
    mockSaveToPhotoLibrary.mockRejectedValue(new MediaExportError('EEXPORT'));
    answerAlert('Cancel');

    await saveMediaItem('media-1');
    await saveMediaItem('media-1');

    expect(mockCaptureError).toHaveBeenCalledTimes(2);
  });

  it('closing the budget re-arms reporting', async () => {
    acknowledgeDisclosure();
    arrangeHappyPath();
    mockSaveToPhotoLibrary.mockRejectedValue(new MediaExportError('EEXPORT'));

    beginExportCaptureBudget();
    await exportMediaItemInBulk('media-1', new AbortController().signal, BULK_PHOTO);
    endExportCaptureBudget();
    beginExportCaptureBudget();
    await exportMediaItemInBulk('media-1', new AbortController().signal, BULK_PHOTO);

    expect(mockCaptureError).toHaveBeenCalledTimes(2);
  });
});
