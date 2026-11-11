/**
 * Policy tests for the app's only door to the archive reader (#920 B3).
 *
 * The wrapper's own behaviour (error normalisation, the token codec, the
 * cancel backstop, the fd contract) is covered in
 * `packages/orbital-archive-reader/src/__tests__/wrapper.test.ts`. These tests
 * cover what THIS module adds on top: the denied-root tripwire, the F1 sniff
 * table, the staging-file lifecycle, the re-stat, the free-space preflight,
 * the entry-id guard and the bucketed telemetry.
 */

import { getFSInfo, stat } from '@dr.pogodin/react-native-fs';
// The MANUAL MOCK by path, not the bare specifier. `jest.config.js`'s
// moduleNameMapper points `'orbital-archive-reader'` at this exact file, so
// Jest resolves both spellings to one module instance — but `tsc` does not
// apply the mapper, so importing the mock-only helpers (`makeMockArchiveSession`,
// `MockArchiveSession`) through the bare specifier would be a type error.
import {
  MOCK_TOKEN,
  makeMockArchiveSession,
  openArchive,
  unlinkStagingFile,
  type MockArchiveSession,
} from '../../../../__mocks__/orbital-archive-reader';
import { isStagingResidueName } from '../../media/stagingResidue';
import {
  ArchiveReaderError,
  bucketCount,
  isArchiveCancellation,
  openArchiveSession,
  startsWithDeniedRoot,
  summarizeSession,
} from '../archiveAccess';

import type { ArchiveEntry, ArchivePartToken } from 'orbital-archive-reader';

const TOKEN: ArchivePartToken = MOCK_TOKEN;

function entry(over: Partial<ArchiveEntry> = {}): ArchiveEntry {
  return {
    entryId: 'fp0:1',
    path: 'media/posts/photo.jpg',
    kind: 'image',
    declaredSize: 1024,
    skip: null,
    ...over,
  };
}

/** JPEG SOI + first marker byte: what `sniffContentType` needs for image/jpeg. */
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** An `ftyp` box with major brand `isom`: video/mp4. */
function mp4Head(): Uint8Array {
  const head = new Uint8Array(32);
  head[3] = 32; // box size
  head.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  head.set([0x69, 0x73, 0x6f, 0x6d], 8); // 'isom'
  return head;
}

/** A HEIF `ftyp` whose decisive brand sits past the bytes we read. */
function largeFtypHeifHead(): Uint8Array {
  const head = new Uint8Array(128);
  head[2] = 0x04; // box size 1024 > head.length
  head.set([0x66, 0x74, 0x79, 0x70], 4);
  head.set([0x6d, 0x69, 0x66, 0x31], 8); // 'mif1'
  return head;
}

function svgHead(): Uint8Array {
  const text = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">';
  return new Uint8Array(Array.from(text, (c) => c.charCodeAt(0)));
}

function session(entries: ArchiveEntry[], over: Partial<MockArchiveSession> = {}) {
  const s = makeMockArchiveSession({
    parts: [TOKEN],
    entries,
    rejectedCounts: {},
    ...over,
  });
  openArchive.mockResolvedValue(s);
  return s;
}

beforeEach(() => {
  jest.clearAllMocks();
  (stat as jest.Mock).mockResolvedValue({ size: 1024 });
  (getFSInfo as jest.Mock).mockResolvedValue({ freeSpace: 32 * 1024 * 1024 * 1024 });
});

// ---------------------------------------------------------------------------

describe('denied-root tripwire (F17)', () => {
  it.each([
    'messages/inbox/x.jpg',
    'inbox/thread/x.jpg',
    'friends_and_followers/a.json',
    'ads_information/a.json',
    'security_and_login_information/a.json',
    'personal_information/a.json',
    'stories/highlights/x.jpg',
    'reels/videos/r.mp4',
    'profile/avatar.jpg',
    'other_content/a.json',
  ])('refuses a listing containing %s', async (path) => {
    const s = session([entry(), entry({ entryId: 'fp0:9', path })]);
    await expect(openArchiveSession([TOKEN])).rejects.toMatchObject({
      code: 'ARCHIVE_INTERNAL',
    });
    // The session is closed, so not even the entries that were fine can be
    // read: a listing that should have been impossible is not partly usable.
    expect(s.close).toHaveBeenCalledTimes(1);
    expect(s.extractEntry).not.toHaveBeenCalled();
    expect(s.readJson).not.toHaveBeenCalled();
  });

  it('accepts an allowlisted listing', async () => {
    session([entry()]);
    await expect(openArchiveSession([TOKEN])).resolves.toBeDefined();
  });

  it('matches only the FIRST segment, not a substring', () => {
    expect(startsWithDeniedRoot('messages/inbox/x.jpg')).toBe(true);
    expect(startsWithDeniedRoot('messages')).toBe(true);
    expect(startsWithDeniedRoot('media/posts/messages.jpg')).toBe(false);
    expect(startsWithDeniedRoot('your_messages/x.jpg')).toBe(false);
    expect(startsWithDeniedRoot('media/posts/inbox/x.jpg')).toBe(false);
  });

  // The four roots #981 shipped without. One positive each, plus the adjacent
  // name that must NOT match — the check is on the whole first SEGMENT, so a
  // longer segment that merely starts with a denied root is allowed through.
  it.each([
    ['stories', 'stories/highlights/x.jpg', 'storiesX/a.jpg'],
    ['reels', 'reels/videos/r.mp4', 'reels_archive/a.jpg'],
    ['profile', 'profile/avatar.jpg', 'profile_photos/a.jpg'],
    ['other_content', 'other_content/a.json', 'other_contents/a.json'],
  ])('matches the %s root as a whole segment only', (_root, denied, allowed) => {
    expect(startsWithDeniedRoot(denied)).toBe(true);
    expect(startsWithDeniedRoot(allowed)).toBe(false);
  });
});

describe('the F1 sniff table', () => {
  async function sniffOutcome(head: Uint8Array) {
    const s = session([entry()]);
    s.peekHead.mockResolvedValue({ ok: true, head });
    s.extractEntry.mockResolvedValue({
      ok: true,
      path: '/tmp/test-cache/u-archive-staging.bin',
      byteLength: 1024,
      head,
    });
    const handle = await openArchiveSession([TOKEN]);
    const result = await handle.extractImageEntry('fp0:1');
    return { result, s };
  }

  it('holds video bytes under an image name and never extracts them', async () => {
    const { result, s } = await sniffOutcome(mp4Head());
    expect(result).toEqual({ ok: false, skip: 'ENTRY_IS_VIDEO' });
    expect(s.extractEntry).not.toHaveBeenCalled();
  });

  it('refuses an SVG head as an unsupported image format', async () => {
    const { result, s } = await sniffOutcome(svgHead());
    // SVG/HTML is not a format `sniffContentType` recognises at all, so it
    // fails closed as indeterminate rather than being named — which is the
    // point: there is no extension fallback.
    expect(result).toEqual({ ok: false, skip: 'ENTRY_SNIFF_INDETERMINATE' });
    expect(s.extractEntry).not.toHaveBeenCalled();
  });

  it('refuses a null head distinctly, never by extension', async () => {
    const { result } = await sniffOutcome(new Uint8Array(0));
    expect(result).toEqual({ ok: false, skip: 'ENTRY_SNIFF_INDETERMINATE' });
  });

  it('refuses a large-ftyp HEIF head whose decisive brand is past 128 bytes', async () => {
    const { result } = await sniffOutcome(largeFtypHeifHead());
    expect(result).toEqual({ ok: false, skip: 'ENTRY_SNIFF_INDETERMINATE' });
  });

  it('proceeds for a JPEG head and re-checks the extracted head', async () => {
    const { result, s } = await sniffOutcome(JPEG_HEAD);
    expect(result).toMatchObject({ ok: true, contentType: 'image/jpeg' });
    expect(s.extractEntry).toHaveBeenCalledWith('fp0:1', 'image', undefined);
  });

  it('discards a file whose EXTRACTED head disagrees with the peek', async () => {
    const s = session([entry()]);
    s.peekHead.mockResolvedValue({ ok: true, head: JPEG_HEAD });
    s.extractEntry.mockResolvedValue({
      ok: true,
      path: '/tmp/test-cache/u-archive-staging.bin',
      byteLength: 1024,
      head: mp4Head(),
    });
    const handle = await openArchiveSession([TOKEN]);
    await expect(handle.extractImageEntry('fp0:1')).resolves.toEqual({
      ok: false,
      skip: 'ENTRY_IS_VIDEO',
    });
    expect(unlinkStagingFile).toHaveBeenCalledWith('/tmp/test-cache/u-archive-staging.bin');
    expect(s.releaseStaging).toHaveBeenCalledWith('/tmp/test-cache/u-archive-staging.bin');
  });
});

describe('staging lifecycle and re-stat (F8)', () => {
  async function extractOk(statSize: number) {
    const s = session([entry()]);
    s.peekHead.mockResolvedValue({ ok: true, head: JPEG_HEAD });
    s.extractEntry.mockResolvedValue({
      ok: true,
      path: '/tmp/test-cache/u-archive-staging.bin',
      byteLength: 1024,
      head: JPEG_HEAD,
    });
    (stat as jest.Mock).mockResolvedValue({ size: statSize });
    const handle = await openArchiveSession([TOKEN]);
    return { result: await handle.extractImageEntry('fp0:1'), s };
  }

  it('hands out a release() that unlinks AND releases the ceiling, once', async () => {
    const { result, s } = await extractOk(1024);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(unlinkStagingFile).not.toHaveBeenCalled();
    result.release();
    result.release();
    expect(unlinkStagingFile).toHaveBeenCalledTimes(1);
    expect(s.releaseStaging).toHaveBeenCalledTimes(1);
  });

  it('refuses a file whose on-disk size no longer matches byteLength', async () => {
    const { result, s } = await extractOk(999);
    expect(result).toEqual({ ok: false, skip: 'ENTRY_CORRUPT' });
    expect(unlinkStagingFile).toHaveBeenCalledTimes(1);
    expect(s.releaseStaging).toHaveBeenCalledTimes(1);
  });

  it('refuses a file that has vanished between extract and stat', async () => {
    const s = session([entry()]);
    s.peekHead.mockResolvedValue({ ok: true, head: JPEG_HEAD });
    s.extractEntry.mockResolvedValue({
      ok: true,
      path: '/tmp/test-cache/u-archive-staging.bin',
      byteLength: 1024,
      head: JPEG_HEAD,
    });
    (stat as jest.Mock).mockRejectedValue(new Error('ENOENT'));
    const handle = await openArchiveSession([TOKEN]);
    await expect(handle.extractImageEntry('fp0:1')).resolves.toEqual({
      ok: false,
      skip: 'ENTRY_CORRUPT',
    });
  });

  it('refuses the extract when free space is below the headroom', async () => {
    const s = session([entry({ declaredSize: 50 * 1024 * 1024 })]);
    s.peekHead.mockResolvedValue({ ok: true, head: JPEG_HEAD });
    (getFSInfo as jest.Mock).mockResolvedValue({ freeSpace: 64 * 1024 * 1024 });
    const handle = await openArchiveSession([TOKEN]);
    await expect(handle.extractImageEntry('fp0:1')).rejects.toMatchObject({
      code: 'ARCHIVE_NO_SPACE',
    });
    expect(s.extractEntry).not.toHaveBeenCalled();
  });

  it('does not refuse when getFSInfo itself fails', async () => {
    const s = session([entry()]);
    s.peekHead.mockResolvedValue({ ok: true, head: JPEG_HEAD });
    s.extractEntry.mockResolvedValue({
      ok: true,
      path: '/tmp/test-cache/u-archive-staging.bin',
      byteLength: 1024,
      head: JPEG_HEAD,
    });
    (getFSInfo as jest.Mock).mockRejectedValue(new Error('unavailable'));
    const handle = await openArchiveSession([TOKEN]);
    await expect(handle.extractImageEntry('fp0:1')).resolves.toMatchObject({ ok: true });
  });

  it('the archive staging name is swept by the wipe/reaper predicate', () => {
    expect(isStagingResidueName('3f2504e0-4f89-41d3-9a0c-0305e82c3301-archive-staging.bin')).toBe(
      true,
    );
    expect(isStagingResidueName('u-archive-staging.bin')).toBe(true);
    expect(isStagingResidueName('archive-staging.txt')).toBe(false);
  });
});

describe('entry-id guard', () => {
  it('refuses an entryId that is not in the listing', async () => {
    const s = session([entry()]);
    const handle = await openArchiveSession([TOKEN]);
    await expect(handle.extractImageEntry('fp9:99')).rejects.toMatchObject({
      code: 'ARCHIVE_INTERNAL',
    });
    await expect(handle.readEntryJson('fp9:99')).rejects.toMatchObject({
      code: 'ARCHIVE_INTERNAL',
    });
    expect(s.peekHead).not.toHaveBeenCalled();
    expect(s.extractEntry).not.toHaveBeenCalled();
    expect(s.readJson).not.toHaveBeenCalled();
  });

  it('refuses readEntryJson on a non-json entry', async () => {
    const s = session([entry()]);
    const handle = await openArchiveSession([TOKEN]);
    await expect(handle.readEntryJson('fp0:1')).rejects.toMatchObject({
      code: 'ARCHIVE_INTERNAL',
    });
    expect(s.readJson).not.toHaveBeenCalled();
  });

  it('returns a listed entry’s own skip without touching native', async () => {
    const s = session([entry({ skip: 'ENTRY_OVER_CAP' })]);
    const handle = await openArchiveSession([TOKEN]);
    await expect(handle.extractImageEntry('fp0:1')).resolves.toEqual({
      ok: false,
      skip: 'ENTRY_OVER_CAP',
    });
    expect(s.peekHead).not.toHaveBeenCalled();
  });

  it('never opens a video entry', async () => {
    const s = session([entry({ kind: 'video', path: 'media/posts/clip.mp4' })]);
    const handle = await openArchiveSession([TOKEN]);
    await expect(handle.extractImageEntry('fp0:1')).resolves.toEqual({
      ok: false,
      skip: 'ENTRY_KIND_NOT_ENABLED',
    });
    expect(s.peekHead).not.toHaveBeenCalled();
    expect(s.extractEntry).not.toHaveBeenCalled();
  });

  it('reads a json entry through to the wrapper', async () => {
    const s = session([entry({ entryId: 'fp0:2', kind: 'json', path: 'media/posts_1.json' })]);
    s.readJson.mockResolvedValue({ ok: true, text: '[]' });
    const handle = await openArchiveSession([TOKEN]);
    await expect(handle.readEntryJson('fp0:2')).resolves.toEqual({ ok: true, text: '[]' });
  });
});

describe('peekEntryKind', () => {
  it('JPEG head -> image + image/jpeg, no extractEntry and no getFSInfo called', async () => {
    const s = session([entry()]);
    s.peekHead.mockResolvedValue({ ok: true, head: JPEG_HEAD });
    const handle = await openArchiveSession([TOKEN]);
    const result = await handle.peekEntryKind('fp0:1');
    expect(result).toEqual({ ok: true, kind: 'image', contentType: 'image/jpeg' });
    expect(s.extractEntry).not.toHaveBeenCalled();
    expect(getFSInfo).not.toHaveBeenCalled();
  });

  it('MP4/ISO-BMFF bytes on an image-listed entry -> video', async () => {
    // The entry is listed as 'image' but the head bytes are video.
    const s = session([entry({ path: 'media/posts/surprise.jpg' })]);
    s.peekHead.mockResolvedValue({ ok: true, head: mp4Head() });
    const handle = await openArchiveSession([TOKEN]);
    const result = await handle.peekEntryKind('fp0:1');
    expect(result).toEqual({ ok: true, kind: 'video' });
  });

  it('listed video kind -> video without calling peekHead', async () => {
    const s = session([entry({ kind: 'video', path: 'media/posts/clip.mp4' })]);
    const handle = await openArchiveSession([TOKEN]);
    const result = await handle.peekEntryKind('fp0:1');
    expect(result).toEqual({ ok: true, kind: 'video' });
    expect(s.peekHead).not.toHaveBeenCalled();
  });

  it('listed video kind with a listing skip -> video (video wins before skip)', async () => {
    // Contract (e): a listed video is evidence even when the entry is also
    // skipped. Holding reads no bytes; the skip is irrelevant to the decision.
    const s = session([
      entry({ kind: 'video', path: 'media/posts/clip.mp4', skip: 'ENTRY_OVER_CAP' }),
    ]);
    const handle = await openArchiveSession([TOKEN]);
    const result = await handle.peekEntryKind('fp0:1');
    expect(result).toEqual({ ok: true, kind: 'video' });
    expect(s.peekHead).not.toHaveBeenCalled();
  });

  it('json entry id -> throws ARCHIVE_INTERNAL (caller bug)', async () => {
    session([entry({ entryId: 'fp0:2', kind: 'json', path: 'media/posts_1.json' })]);
    const handle = await openArchiveSession([TOKEN]);
    await expect(handle.peekEntryKind('fp0:2')).rejects.toMatchObject({
      code: 'ARCHIVE_INTERNAL',
    });
  });

  it('image entry with a listing skip -> that skip returned, no peek', async () => {
    const s = session([entry({ skip: 'ENTRY_OVER_CAP' })]);
    const handle = await openArchiveSession([TOKEN]);
    const result = await handle.peekEntryKind('fp0:1');
    expect(result).toEqual({ ok: false, skip: 'ENTRY_OVER_CAP' });
    expect(s.peekHead).not.toHaveBeenCalled();
  });

  it('a peekHead skip is passed through', async () => {
    const s = session([entry()]);
    s.peekHead.mockResolvedValue({ ok: false, skip: 'ENTRY_KIND_NOT_ENABLED' });
    const handle = await openArchiveSession([TOKEN]);
    const result = await handle.peekEntryKind('fp0:1');
    expect(result).toEqual({ ok: false, skip: 'ENTRY_KIND_NOT_ENABLED' });
  });

  it('head that sniffs to null -> ENTRY_SNIFF_INDETERMINATE', async () => {
    // An empty head produces a null from sniffContentType, which classifySniff
    // maps to ENTRY_SNIFF_INDETERMINATE (not an extension fallback).
    const s = session([entry()]);
    s.peekHead.mockResolvedValue({ ok: true, head: new Uint8Array(0) });
    const handle = await openArchiveSession([TOKEN]);
    const result = await handle.peekEntryKind('fp0:1');
    expect(result).toEqual({ ok: false, skip: 'ENTRY_SNIFF_INDETERMINATE' });
  });

  it('unknown entry id -> throws ARCHIVE_INTERNAL', async () => {
    session([entry()]);
    const handle = await openArchiveSession([TOKEN]);
    await expect(handle.peekEntryKind('fp9:99')).rejects.toMatchObject({
      code: 'ARCHIVE_INTERNAL',
    });
  });

  it('passes the AbortSignal to peekHead and propagates the cancellation', async () => {
    // The real cancel machinery (native cancel + grace-timer backstop) lives in
    // the wrapper and is covered there; what matters HERE is that the options
    // object reaches `peekHead` and that an ECANCELLED rejection travels out of
    // `peekEntryKind` as a cancellation rather than being swallowed into a skip.
    const s = session([entry()]);
    s.peekHead.mockImplementation(
      (_entryId: string, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new ArchiveReaderError('ECANCELLED'));
          });
        }),
    );
    const handle = await openArchiveSession([TOKEN]);
    const controller = new AbortController();
    const pending = handle.peekEntryKind('fp0:1', { signal: controller.signal });
    expect(s.peekHead).toHaveBeenCalledWith('fp0:1', { signal: controller.signal });

    controller.abort();
    const thrown = await pending.catch((e: unknown) => e);
    expect(isArchiveCancellation(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: 'ECANCELLED' });
  });
});

describe('bucketed telemetry (F18)', () => {
  it('buckets counts and never reports an exact number', () => {
    expect(bucketCount(0)).toBe('0');
    expect(bucketCount(-5)).toBe('0');
    expect(bucketCount(NaN)).toBe('0');
    expect(bucketCount(1)).toBe('1');
    expect(bucketCount(2)).toBe('2-10');
    expect(bucketCount(10)).toBe('2-10');
    expect(bucketCount(11)).toBe('11-100');
    expect(bucketCount(100)).toBe('11-100');
    expect(bucketCount(101)).toBe('101-1k');
    expect(bucketCount(1000)).toBe('101-1k');
    expect(bucketCount(1001)).toBe('1k+');
  });

  it('drops path-level and denied-root rejection counts entirely', () => {
    const s = makeMockArchiveSession({
      parts: [TOKEN],
      entries: [
        entry(),
        entry({ entryId: 'fp0:2', kind: 'json', path: 'media/posts_1.json' }),
        entry({ entryId: 'fp0:3', kind: 'video', path: 'media/posts/c.mp4' }),
      ],
      rejectedCounts: {
        ENTRY_NOT_ALLOWLISTED: 40321,
        ENTRY_PATH_TRAVERSAL: 3,
        ENTRY_PATH_INVALID: 7,
        ENTRY_OVER_CAP: 12,
      },
    });
    const t = summarizeSession(s as never);
    expect(t).toEqual({
      parts: '1',
      listed: '2-10',
      jsonEntries: '1',
      imageEntries: '1',
      videoEntries: '1',
      rejected: { ENTRY_OVER_CAP: '11-100' },
    });
    expect(JSON.stringify(t)).not.toContain('40321');
  });
});
