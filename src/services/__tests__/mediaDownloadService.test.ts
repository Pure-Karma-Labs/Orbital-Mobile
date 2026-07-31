/**
 * Tests for mediaDownloadService — streaming download, two-pass streaming
 * decrypt, containment on failure, abort handling, and cleanup (#578).
 *
 * `../crypto/attachmentCrypto` is deliberately NOT mocked: the real wrapper
 * runs against the phase-enforcing AttachmentDecryptor stub in
 * __mocks__/orbital-signal.ts, so "decrypt before verify" is a real failure
 * here rather than a vacuous pass.
 *
 * RNFS is backed by a byte-accurate in-memory filesystem so the size asserts
 * and the containment claims (".tmp unlinked", "final never written") are
 * checked against actual file state, not just call spies.
 */

jest.mock('@dr.pogodin/react-native-fs');

const mockDownloadMediaToFile = jest.fn();

jest.mock('../api/media', () => ({
  downloadMediaToFile: (...args: unknown[]) => mockDownloadMediaToFile(...args),
  // Mirrors the real formula (see api/media.ts); its own behaviour is covered
  // by downloadMediaToFile.test.ts.
  ciphertextByteCeiling: (n?: number | null) =>
    n != null && n > 0
      ? Math.min(n + 64, 50 * 1024 * 1024 + 64)
      : 50 * 1024 * 1024 + 64,
}));

const mockGetMedia = jest.fn();
const mockUpdateDownloadState = jest.fn();

jest.mock('../../database/repositories/mediaRepository', () => ({
  getMedia: (...args: unknown[]) => mockGetMedia(...args),
  updateDownloadState: (...args: unknown[]) => mockUpdateDownloadState(...args),
}));

const mockUpdateMediaDownloadState = jest.fn();

jest.mock('../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({
      updateMediaDownloadState: mockUpdateMediaDownloadState,
    })),
  },
}));

jest.mock('../../database/queryHelpers', () => ({
  queryMany: jest.fn(() => []),
}));

const mockConfirmArchived = jest.fn().mockResolvedValue('confirmed');

jest.mock('../mediaArchiveConfirmService', () => ({
  confirmArchived: (...args: unknown[]) => mockConfirmArchived(...args),
}));

import {
  downloadAndDecryptMedia,
  retryDownload,
  isMediaCached,
  cleanupOrphanedMedia,
  DOWNLOAD_ABORTED_MESSAGE,
} from '../mediaDownloadService';
import { VIDEO_MIME_EXT } from '../media/videoProcessing';
import { base64DecodedLength } from '../crypto/utils';
import { NotFoundError } from '../api/errors';
import type { MediaRow } from '../../database/repositories/mediaRepository';

const { AttachmentDecryptor } = require('orbital-signal');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeKeys = new Uint8Array(64).fill(0xEE);
const fakeDigest = new Uint8Array(32).fill(0xDD);

const FAKE_MEDIA_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const MEDIA_DIR = '/tmp/test-docs/media';
const FINAL_PATH = `${MEDIA_DIR}/${FAKE_MEDIA_ID}.jpg`;
const TMP_PATH = `${FINAL_PATH}.tmp`;
const STAGING_PATH = `/tmp/test-cache/${FAKE_MEDIA_ID}-dl-cipher.bin`;

/** Ciphertext length: 2 whole 1MB reads plus a short tail read. */
const CT_LEN = 2 * 1024 * 1024 + 517;
/** Plaintext bytes the stub emits from decryptFinalize(). */
const TAIL_BYTES = 7;
const READ_SIZE = 1024 * 1024;

function b64Zeros(n: number): string {
  return Buffer.alloc(n).toString('base64');
}

function makeMediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id: FAKE_MEDIA_ID,
    thread_id: 'thread-1',
    reply_id: null,
    message_id: null,
    content_type: 'image/jpeg',
    file_name: 'photo.jpg',
    file_size: CT_LEN,
    width: 640,
    height: 480,
    duration: null,
    attachment_key: fakeKeys,
    attachment_digest: fakeDigest,
    cdn_number: null,
    cdn_key: null,
    local_path: null,
    thumbnail_path: null,
    blur_hash: null,
    expires_at: null,
    download_state: 'pending',
    upload_state: 'done',
    created_at: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Byte-accurate in-memory filesystem
// ---------------------------------------------------------------------------

/** path -> byte length */
const fsFiles = new Map<string, number>();

function statLike(size: number) {
  return {
    size,
    mtime: new Date(),
    ctime: new Date(),
    isFile: () => true,
    isDirectory: () => false,
  };
}

function installFakeFs(): void {
  const rnfs = require('@dr.pogodin/react-native-fs');

  rnfs.exists.mockImplementation((p: string) => Promise.resolve(fsFiles.has(p)));
  rnfs.mkdir.mockImplementation((p: string) => {
    fsFiles.set(p, 0);
    return Promise.resolve();
  });
  rnfs.unlink.mockImplementation((p: string) => {
    if (!fsFiles.has(p)) return Promise.reject(new Error(`ENOENT: ${p}`));
    fsFiles.delete(p);
    return Promise.resolve();
  });
  rnfs.writeFile.mockImplementation((p: string, content: string) => {
    fsFiles.set(p, base64DecodedLength(content));
    return Promise.resolve();
  });
  rnfs.appendFile.mockImplementation((p: string, content: string) => {
    fsFiles.set(p, (fsFiles.get(p) ?? 0) + base64DecodedLength(content));
    return Promise.resolve();
  });
  rnfs.stat.mockImplementation((p: string) =>
    fsFiles.has(p)
      ? Promise.resolve(statLike(fsFiles.get(p)!))
      : Promise.reject(new Error(`ENOENT: ${p}`)),
  );
  rnfs.moveFile.mockImplementation((from: string, to: string) => {
    fsFiles.set(to, fsFiles.get(from) ?? 0);
    fsFiles.delete(from);
    return Promise.resolve();
  });
  rnfs.read.mockImplementation((p: string, len: number, pos: number) => {
    const size = fsFiles.get(p) ?? 0;
    return Promise.resolve(b64Zeros(Math.max(0, Math.min(len, size - pos))));
  });
  rnfs.readDir.mockResolvedValue([]);
  rnfs.getFSInfo.mockResolvedValue({
    totalSpace: 64 * 1024 * 1024 * 1024,
    totalSpaceEx: 64 * 1024 * 1024 * 1024,
    freeSpace: 32 * 1024 * 1024 * 1024,
    freeSpaceEx: 32 * 1024 * 1024 * 1024,
  });
}

/** The default happy-path transport: writes CT_LEN bytes to the staging path. */
function transportWritesCiphertext(bytes = CT_LEN): void {
  mockDownloadMediaToFile.mockImplementation(
    async ({ toFile }: { toFile: string }) => {
      fsFiles.set(toFile, bytes);
      return { bytesWritten: bytes };
    },
  );
}

/** Decryptor stub emits one plaintext byte per ciphertext byte, plus a tail. */
function decryptorEmitsPlaintext(): void {
  AttachmentDecryptor.decryptPushOutput = (chunkB64: string) =>
    b64Zeros(base64DecodedLength(chunkB64));
  AttachmentDecryptor.decryptFinalizeOutput = () => b64Zeros(TAIL_BYTES);
}

const EXPECTED_PLAINTEXT_BYTES = CT_LEN + TAIL_BYTES;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  AttachmentDecryptor.reset();
  fsFiles.clear();
  installFakeFs();
  mockGetMedia.mockReturnValue(makeMediaRow());
  transportWritesCiphertext();
  decryptorEmitsPlaintext();
});

// ---------------------------------------------------------------------------
// Streaming happy path
// ---------------------------------------------------------------------------

describe('downloadAndDecryptMedia — streaming happy path', () => {
  it('streams to staging, verifies before decrypting, and promotes atomically', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    const destroySpy = jest.spyOn(AttachmentDecryptor.prototype, 'uniffiDestroy');

    const result = await downloadAndDecryptMedia(FAKE_MEDIA_ID);

    expect(result).toBe(FINAL_PATH);

    // Transport wrote ciphertext to the Caches staging path, not to MEDIA_DIR.
    expect(mockDownloadMediaToFile).toHaveBeenCalledWith({
      mediaId: FAKE_MEDIA_ID,
      toFile: STAGING_PATH,
      expectedBytes: CT_LEN,
      signal: undefined,
    });

    // Two passes over the same blob: 3 reads each (1MB, 1MB, 517B).
    const reads = (rnfs.read as jest.Mock).mock.calls.filter(
      (c: unknown[]) => c[0] === STAGING_PATH,
    );
    expect(reads).toHaveLength(6);
    expect(reads.slice(0, 3).map((c: unknown[]) => [c[1], c[2]])).toEqual([
      [READ_SIZE, 0],
      [READ_SIZE, READ_SIZE],
      [CT_LEN - 2 * READ_SIZE, 2 * READ_SIZE],
    ]);
    // Pass 2 restarts at offset 0 over the same blob.
    expect(reads[3][2]).toBe(0);

    // Plaintext landed at the final path with exactly the emitted byte count.
    expect(fsFiles.get(FINAL_PATH)).toBe(EXPECTED_PLAINTEXT_BYTES);
    expect(fsFiles.has(TMP_PATH)).toBe(false);
    // Staging ciphertext is gone.
    expect(fsFiles.has(STAGING_PATH)).toBe(false);

    expect(rnfs.moveFile).toHaveBeenCalledWith(TMP_PATH, FINAL_PATH);
    expect(destroySpy).toHaveBeenCalled();

    // DB relative, store absolute.
    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'downloading');
    expect(mockUpdateDownloadState).toHaveBeenCalledWith(
      FAKE_MEDIA_ID,
      'downloaded',
      `media/${FAKE_MEDIA_ID}.jpg`,
    );
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(
      FAKE_MEDIA_ID,
      'downloaded',
      FINAL_PATH,
    );
  });

  it('unlinks the ciphertext staging file BEFORE promoting the plaintext', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');

    await downloadAndDecryptMedia(FAKE_MEDIA_ID);

    const stagingUnlinkOrder = (rnfs.unlink as jest.Mock).mock.calls
      .map((c: unknown[], i: number) => ({ path: c[0], order: (rnfs.unlink as jest.Mock).mock.invocationCallOrder[i] }))
      .filter((e: { path: unknown }) => e.path === STAGING_PATH)
      .map((e: { order: number }) => e.order);
    const moveOrder = (rnfs.moveFile as jest.Mock).mock.invocationCallOrder[0];

    expect(stagingUnlinkOrder.some((o: number) => o < moveOrder)).toBe(true);
  });

  it('unlinks a stale .tmp and a stale staging file before the download begins', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    fsFiles.set(TMP_PATH, 999);
    fsFiles.set(STAGING_PATH, 12345);

    await downloadAndDecryptMedia(FAKE_MEDIA_ID);

    const downloadOrder = mockDownloadMediaToFile.mock.invocationCallOrder[0];
    const unlinkCalls = (rnfs.unlink as jest.Mock).mock.calls.map(
      (c: unknown[], i: number) => ({
        path: c[0],
        order: (rnfs.unlink as jest.Mock).mock.invocationCallOrder[i],
      }),
    );
    expect(
      unlinkCalls.some((e: { path: unknown; order: number }) => e.path === TMP_PATH && e.order < downloadOrder),
    ).toBe(true);
    expect(
      unlinkCalls.some((e: { path: unknown; order: number }) => e.path === STAGING_PATH && e.order < downloadOrder),
    ).toBe(true);
  });

  // A crashed prior attempt leaves a deterministic .tmp path populated. Neither
  // HMAC nor digest can catch a stale prefix, so the length must come out right.
  it('pre-existing non-empty .tmp does not lengthen the output', async () => {
    fsFiles.set(TMP_PATH, 4096);

    await downloadAndDecryptMedia(FAKE_MEDIA_ID);

    expect(fsFiles.get(FINAL_PATH)).toBe(EXPECTED_PLAINTEXT_BYTES);
  });

  // RNFS read() returns *up to* n bytes on Android; the loop must advance by
  // the DECODED length or it silently skips or re-reads ciphertext.
  it('advances the read position by the decoded length when read() short-reads', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    const SHORT = 64 * 1024;
    rnfs.read.mockImplementation((p: string, len: number, pos: number) => {
      const size = fsFiles.get(p) ?? 0;
      const n = Math.max(0, Math.min(len, SHORT, size - pos));
      return Promise.resolve(b64Zeros(n));
    });

    const result = await downloadAndDecryptMedia(FAKE_MEDIA_ID);

    expect(result).toBe(FINAL_PATH);
    // Every ciphertext byte was covered exactly once per pass.
    const passReads = (rnfs.read as jest.Mock).mock.calls.filter(
      (c: unknown[]) => c[0] === STAGING_PATH,
    );
    const perPass = passReads.length / 2;
    expect(Number.isInteger(perPass)).toBe(true);
    expect(perPass).toBe(Math.ceil(CT_LEN / SHORT));
    expect(fsFiles.get(FINAL_PATH)).toBe(EXPECTED_PLAINTEXT_BYTES);
  });

  it('fails when a zero-length read arrives before the expected end', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.read.mockResolvedValue('');

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow(/no bytes/);
    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'failed');
  });

  it('fails when the plaintext size does not match the emitted byte count', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    const realAppend = (rnfs.appendFile as jest.Mock).getMockImplementation()!;
    let calls = 0;
    rnfs.appendFile.mockImplementation((p: string, content: string) => {
      calls += 1;
      // Silently drop the last append — the failure mode the size assert exists for.
      if (calls === 4) return Promise.resolve();
      return realAppend(p, content);
    });

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow(
      /Plaintext size mismatch/,
    );
    expect(rnfs.moveFile).not.toHaveBeenCalled();
    expect(fsFiles.has(TMP_PATH)).toBe(false);
    expect(fsFiles.has(FINAL_PATH)).toBe(false);
  });

  it('rejects a staged blob shorter than the expected ciphertext length', async () => {
    transportWritesCiphertext(CT_LEN - 100);

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow(
      /shorter than the expected length/,
    );
    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'failed');
  });

  // The uploader's own row records the PLAINTEXT length, so a re-download of
  // one's own media is legitimately LONGER than expectedBytes.
  it('accepts a staged blob longer than expectedBytes (uploader-basis row)', async () => {
    mockGetMedia.mockReturnValue(makeMediaRow({ file_size: CT_LEN - 48 }));

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).resolves.toBe(FINAL_PATH);
  });

  it('fires confirmArchived after a successful download (fire-and-forget)', async () => {
    await downloadAndDecryptMedia(FAKE_MEDIA_ID);
    await new Promise((r) => setImmediate(r));

    expect(mockConfirmArchived).toHaveBeenCalledWith(FAKE_MEDIA_ID);
  });

  it('does NOT fire confirmArchived on download failure', async () => {
    mockDownloadMediaToFile.mockRejectedValue(new Error('Network error'));

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow('Network error');
    await new Promise((r) => setImmediate(r));

    expect(mockConfirmArchived).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent downloads for the same media ID', async () => {
    const [r1, r2] = await Promise.all([
      downloadAndDecryptMedia(FAKE_MEDIA_ID),
      downloadAndDecryptMedia(FAKE_MEDIA_ID),
    ]);

    expect(r1).toBe(r2);
    expect(mockDownloadMediaToFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Containment — MERGE GATE (PR #668 review)
// ---------------------------------------------------------------------------

describe('downloadAndDecryptMedia — containment on crypto failure', () => {
  /** Nothing may be promoted, cached, or left behind. */
  function expectContained(rnfs: { moveFile: jest.Mock }): void {
    expect(fsFiles.has(TMP_PATH)).toBe(false);
    expect(fsFiles.has(FINAL_PATH)).toBe(false);
    expect(fsFiles.has(STAGING_PATH)).toBe(false);
    expect(rnfs.moveFile).not.toHaveBeenCalled();
    expect(mockUpdateDownloadState).not.toHaveBeenCalledWith(
      FAKE_MEDIA_ID,
      'downloaded',
      expect.anything(),
    );
    expect(mockUpdateMediaDownloadState).not.toHaveBeenCalledWith(
      FAKE_MEDIA_ID,
      'downloaded',
      expect.anything(),
    );
    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'failed');
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'failed');
  }

  it('pass-1 verifyFinalize failure: no plaintext file is ever created', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    const destroySpy = jest.spyOn(AttachmentDecryptor.prototype, 'uniffiDestroy');
    AttachmentDecryptor.failVerifyFinalize = true;

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow();

    expectContained(rnfs);
    // Verification failed, so pass 2 never started — no plaintext ever existed.
    expect(rnfs.appendFile).not.toHaveBeenCalled();
    expect(destroySpy).toHaveBeenCalled();
  });

  it('pass-2 decryptPush failure: partial plaintext .tmp is unlinked', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    const destroySpy = jest.spyOn(AttachmentDecryptor.prototype, 'uniffiDestroy');
    AttachmentDecryptor.failDecryptPush = true;

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow();

    expectContained(rnfs);
    expect(destroySpy).toHaveBeenCalled();
  });

  // TOCTOU: a blob modified between the two passes emits attacker-influenced
  // plaintext into .tmp before decryptFinalize detects the divergence. Safety
  // is procedural — the .tmp must never be promoted and never survive.
  it('decryptFinalize failure (TOCTOU): emitted plaintext never reaches the final path', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    const destroySpy = jest.spyOn(AttachmentDecryptor.prototype, 'uniffiDestroy');
    AttachmentDecryptor.failDecryptFinalize = true;

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow();

    // Plaintext WAS written during pass 2 before finalize rejected...
    expect(rnfs.appendFile).toHaveBeenCalled();
    // ...and none of it survived.
    expectContained(rnfs);
    expect(destroySpy).toHaveBeenCalled();
  });

  it('pass-1 verifyPush failure is contained too', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    AttachmentDecryptor.failVerifyPush = true;

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow();

    expectContained(rnfs);
  });

  // Against the phase-enforcing stub this is a real ordering proof: a
  // decryptPush before verifyFinalize would throw "no longer usable".
  it('never calls decryptPush before verifyFinalize', async () => {
    const verifyFinalizeSpy = jest.spyOn(AttachmentDecryptor.prototype, 'verifyFinalize');
    const decryptPushSpy = jest.spyOn(AttachmentDecryptor.prototype, 'decryptPush');

    await downloadAndDecryptMedia(FAKE_MEDIA_ID);

    expect(verifyFinalizeSpy).toHaveBeenCalledTimes(1);
    expect(decryptPushSpy).toHaveBeenCalled();
    expect(verifyFinalizeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      decryptPushSpy.mock.invocationCallOrder[0],
    );
  });

  it('throws before any download when the attachment digest is missing', async () => {
    mockGetMedia.mockReturnValue(makeMediaRow({ attachment_digest: null }));

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow(/digest/);
    expect(mockDownloadMediaToFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Disk preflight + reservation
// ---------------------------------------------------------------------------

describe('downloadAndDecryptMedia — disk preflight', () => {
  it('refuses to start when free space is below 2x the payload plus headroom', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.getFSInfo.mockResolvedValue({
      totalSpace: 0,
      totalSpaceEx: 0,
      freeSpace: 1024,
      freeSpaceEx: 1024,
    });

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow(/free space/);
    expect(mockDownloadMediaToFile).not.toHaveBeenCalled();
  });

  // Without a reservation counter, N concurrent preflights all see the same
  // free space, all pass, and collectively overrun it.
  it('two concurrent downloads cannot both claim one download worth of space', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    // Enough for exactly one 2x CT_LEN download plus the 64MB headroom.
    rnfs.getFSInfo.mockResolvedValue({
      totalSpace: 0,
      totalSpaceEx: 0,
      freeSpace: 64 * 1024 * 1024 + 5 * 1024 * 1024,
      freeSpaceEx: 0,
    });

    const MEDIA_ID_2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      mockDownloadMediaToFile.mockImplementationOnce(
        async ({ toFile }: { toFile: string }) => {
          resolve();
          await new Promise<void>((r) => {
            releaseFirst = r;
          });
          fsFiles.set(toFile, CT_LEN);
          return { bytesWritten: CT_LEN };
        },
      );
    });

    mockGetMedia.mockImplementation((id: string) =>
      makeMediaRow({ id, file_name: 'photo.jpg' }),
    );

    const first = downloadAndDecryptMedia(FAKE_MEDIA_ID);
    await firstStarted;

    // The first download holds its reservation, so the second must not fit.
    await expect(downloadAndDecryptMedia(MEDIA_ID_2)).rejects.toThrow(/free space/);

    releaseFirst();
    await expect(first).resolves.toBe(FINAL_PATH);
  });

  it('releases the reservation so a later download fits again', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.getFSInfo.mockResolvedValue({
      totalSpace: 0,
      totalSpaceEx: 0,
      freeSpace: 64 * 1024 * 1024 + 5 * 1024 * 1024,
      freeSpaceEx: 0,
    });

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).resolves.toBe(FINAL_PATH);

    fsFiles.delete(FINAL_PATH);
    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).resolves.toBe(FINAL_PATH);
  });
});

// ---------------------------------------------------------------------------
// Cache, keys, extensions
// ---------------------------------------------------------------------------

describe('downloadAndDecryptMedia — cache and metadata', () => {
  it('returns cached path when file exists on disk', async () => {
    mockGetMedia.mockReturnValue(makeMediaRow({ local_path: FINAL_PATH }));
    fsFiles.set(FINAL_PATH, 100);

    expect(await downloadAndDecryptMedia(FAKE_MEDIA_ID)).toBe(FINAL_PATH);
    expect(mockDownloadMediaToFile).not.toHaveBeenCalled();
  });

  it('does NOT fire confirmArchived on cache-hit early return', async () => {
    mockGetMedia.mockReturnValue(makeMediaRow({ local_path: FINAL_PATH }));
    fsFiles.set(FINAL_PATH, 100);

    await downloadAndDecryptMedia(FAKE_MEDIA_ID);
    await new Promise((r) => setImmediate(r));

    expect(mockConfirmArchived).not.toHaveBeenCalled();
  });

  it('throws when no attachment keys available', async () => {
    mockGetMedia.mockReturnValue(makeMediaRow({ attachment_key: null }));

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow(
      'No attachment keys available',
    );
    expect(mockDownloadMediaToFile).not.toHaveBeenCalled();
  });

  it('creates the media directory if it does not exist', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');

    await downloadAndDecryptMedia(FAKE_MEDIA_ID);

    expect(rnfs.mkdir).toHaveBeenCalledWith(MEDIA_DIR, {
      NSURLIsExcludedFromBackupKey: true,
    });
  });

  it.each([
    ['image/png', 'png'],
    ['video/quicktime', 'mov'],
    ['video/x-m4v', 'm4v'],
  ])('derives the extension from content type %s', async (mime, ext) => {
    mockGetMedia.mockReturnValue(
      makeMediaRow({ file_name: null, content_type: mime }),
    );

    expect(await downloadAndDecryptMedia(FAKE_MEDIA_ID)).toBe(
      `${MEDIA_DIR}/${FAKE_MEDIA_ID}.${ext}`,
    );
  });

  // Structural sync guard: every upload-side pass-through MIME must resolve to
  // its extension here too, or it would fall back to '.dat'.
  it.each(Object.entries(VIDEO_MIME_EXT))(
    'getExtension stays in sync with VIDEO_MIME_EXT: %s -> .%s',
    async (mime, ext) => {
      mockGetMedia.mockReturnValue(
        makeMediaRow({ file_name: null, content_type: mime }),
      );

      expect(await downloadAndDecryptMedia(FAKE_MEDIA_ID)).toBe(
        `${MEDIA_DIR}/${FAKE_MEDIA_ID}.${ext}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Abort-aware cancellation
// ---------------------------------------------------------------------------

describe('downloadAndDecryptMedia — abort handling', () => {
  it('restores to pending when the signal is pre-aborted (sentinel message)', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      downloadAndDecryptMedia(FAKE_MEDIA_ID, controller.signal),
    ).rejects.toThrow(DOWNLOAD_ABORTED_MESSAGE);

    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'pending');
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'pending');
    expect(mockUpdateDownloadState).not.toHaveBeenCalledWith(FAKE_MEDIA_ID, 'downloading');
  });

  it('releases the semaphore slot after a pre-aborted download', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      downloadAndDecryptMedia(FAKE_MEDIA_ID, controller.signal),
    ).rejects.toThrow(DOWNLOAD_ABORTED_MESSAGE);

    // If the slot leaked this would eventually hang at MAX_CONCURRENT.
    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).resolves.toBe(FINAL_PATH);
  });

  // The transport's deadline arm rejects when the native promise never settles.
  // The service must treat that like any other rejection and free its slot.
  it('releases the semaphore slot when the transport rejects (never-settling native promise)', async () => {
    mockDownloadMediaToFile.mockRejectedValueOnce(
      new Error('Media download exceeded the maximum transfer time'),
    );

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow();
    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'failed');

    transportWritesCiphertext();
    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).resolves.toBe(FINAL_PATH);
  });

  it('normalizes a mid-transfer abort to the sentinel and restores pending', async () => {
    const controller = new AbortController();
    mockDownloadMediaToFile.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error('NetworkError: transfer aborted'));
    });

    await expect(
      downloadAndDecryptMedia(FAKE_MEDIA_ID, controller.signal),
    ).rejects.toThrow(DOWNLOAD_ABORTED_MESSAGE);

    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'pending');
  });

  it('aborts mid-pass-1 and leaves nothing behind', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    const controller = new AbortController();
    let reads = 0;
    const realRead = (rnfs.read as jest.Mock).getMockImplementation()!;
    rnfs.read.mockImplementation((p: string, len: number, pos: number) => {
      reads += 1;
      if (reads === 2) controller.abort();
      return realRead(p, len, pos);
    });

    await expect(
      downloadAndDecryptMedia(FAKE_MEDIA_ID, controller.signal),
    ).rejects.toThrow(DOWNLOAD_ABORTED_MESSAGE);

    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'pending');
    expect(fsFiles.has(STAGING_PATH)).toBe(false);
    expect(fsFiles.has(TMP_PATH)).toBe(false);
    expect(rnfs.moveFile).not.toHaveBeenCalled();
  });

  it('aborts mid-pass-2 and unlinks the partial plaintext', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    const controller = new AbortController();
    let appends = 0;
    const realAppend = (rnfs.appendFile as jest.Mock).getMockImplementation()!;
    rnfs.appendFile.mockImplementation((p: string, content: string) => {
      appends += 1;
      if (appends === 1) controller.abort();
      return realAppend(p, content);
    });

    await expect(
      downloadAndDecryptMedia(FAKE_MEDIA_ID, controller.signal),
    ).rejects.toThrow(DOWNLOAD_ABORTED_MESSAGE);

    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'pending');
    expect(fsFiles.has(TMP_PATH)).toBe(false);
    expect(fsFiles.has(FINAL_PATH)).toBe(false);
    expect(rnfs.moveFile).not.toHaveBeenCalled();
  });

  it('sets failed on a non-abort error when no signal is supplied', async () => {
    mockDownloadMediaToFile.mockRejectedValue(new Error('Server 500'));

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow('Server 500');

    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'failed');
  });

  it('sets unavailable on NotFoundError', async () => {
    mockDownloadMediaToFile.mockRejectedValue(new NotFoundError('gone'));

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).rejects.toThrow();

    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'unavailable');
  });

  it('clears the inflight entry after an abort-then-rejoin', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      downloadAndDecryptMedia(FAKE_MEDIA_ID, controller.signal),
    ).rejects.toThrow(DOWNLOAD_ABORTED_MESSAGE);

    await expect(downloadAndDecryptMedia(FAKE_MEDIA_ID)).resolves.toBe(FINAL_PATH);
    expect(mockDownloadMediaToFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// retryDownload / isMediaCached
// ---------------------------------------------------------------------------

describe('retryDownload', () => {
  it('resets state to pending before re-triggering the download', async () => {
    const result = await retryDownload(FAKE_MEDIA_ID);

    expect(mockUpdateDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'pending');
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(FAKE_MEDIA_ID, 'pending');
    expect(mockDownloadMediaToFile).toHaveBeenCalledTimes(1);
    expect(result).toBe(FINAL_PATH);
  });
});

describe('isMediaCached', () => {
  it('returns true when the file exists on disk', async () => {
    mockGetMedia.mockReturnValue(makeMediaRow({ local_path: FINAL_PATH }));
    fsFiles.set(FINAL_PATH, 10);

    expect(await isMediaCached(FAKE_MEDIA_ID)).toBe(true);
  });

  it('returns false when there is no local path', async () => {
    mockGetMedia.mockReturnValue(makeMediaRow({ local_path: null }));

    expect(await isMediaCached(FAKE_MEDIA_ID)).toBe(false);
  });

  it('returns false when the file does not exist', async () => {
    mockGetMedia.mockReturnValue(makeMediaRow({ local_path: FINAL_PATH }));

    expect(await isMediaCached(FAKE_MEDIA_ID)).toBe(false);
  });

  it('returns false when the DB throws', async () => {
    mockGetMedia.mockImplementation(() => {
      throw new Error('DB not initialized');
    });

    expect(await isMediaCached(FAKE_MEDIA_ID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cleanupOrphanedMedia
// ---------------------------------------------------------------------------

describe('cleanupOrphanedMedia', () => {
  beforeEach(() => {
    fsFiles.set(MEDIA_DIR, 0);
  });

  it('deletes .tmp files older than 1 hour', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.readDir.mockResolvedValue([
      {
        name: 'media-1.jpg.tmp',
        path: `${MEDIA_DIR}/${FAKE_MEDIA_ID}.jpg.tmp`,
        mtime: new Date(Date.now() - 7200_000),
        isDirectory: () => false,
      },
      {
        name: 'media-2.png.tmp',
        path: `${MEDIA_DIR}/media-2.png.tmp`,
        mtime: new Date(),
        isDirectory: () => false,
      },
    ]);

    await cleanupOrphanedMedia();

    expect(rnfs.unlink).toHaveBeenCalledWith(`${MEDIA_DIR}/${FAKE_MEDIA_ID}.jpg.tmp`);
    expect(rnfs.unlink).not.toHaveBeenCalledWith(`${MEDIA_DIR}/media-2.png.tmp`);
  });

  it('deletes files with no matching DB row', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.readDir.mockResolvedValue([
      {
        name: 'orphan-id.jpg',
        path: `${MEDIA_DIR}/orphan-id.jpg`,
        mtime: new Date(),
        isDirectory: () => false,
      },
    ]);
    mockGetMedia.mockReturnValue(null);

    await cleanupOrphanedMedia();

    expect(rnfs.unlink).toHaveBeenCalledWith(`${MEDIA_DIR}/orphan-id.jpg`);
  });

  it('does not throw on errors', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.exists.mockRejectedValue(new Error('Permission denied'));

    await expect(cleanupOrphanedMedia()).resolves.toBeUndefined();
  });

  it('auto-promotes an unavailable row with a file on disk to downloaded (D10)', async () => {
    const rnfs = require('@dr.pogodin/react-native-fs');
    rnfs.readDir.mockResolvedValue([
      {
        name: `${FAKE_MEDIA_ID}.jpg`,
        path: FINAL_PATH,
        mtime: new Date(),
        isDirectory: () => false,
      },
    ]);
    mockGetMedia.mockReturnValue(makeMediaRow({ download_state: 'unavailable' }));

    await cleanupOrphanedMedia();

    expect(mockUpdateDownloadState).toHaveBeenCalledWith(
      FAKE_MEDIA_ID,
      'downloaded',
      `media/${FAKE_MEDIA_ID}.jpg`,
    );
    expect(mockUpdateMediaDownloadState).toHaveBeenCalledWith(
      FAKE_MEDIA_ID,
      'downloaded',
      FINAL_PATH,
    );
  });
});
