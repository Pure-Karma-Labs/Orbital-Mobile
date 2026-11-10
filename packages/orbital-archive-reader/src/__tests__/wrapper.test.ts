/**
 * Wrapper tests for `orbital-archive-reader` (#920 B3).
 *
 * These test the HAND-WRITTEN wrapper against a fake of the generated
 * bindings, so they cover exactly the layer `__mocks__/orbital-archive-reader.ts`
 * replaces for app tests: error normalisation, bigint narrowing, the token
 * codec, the lazy loader, cancellation, the fd contract and the wipe epoch.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- the fake bindings stand
   in for a generated module whose types are only meaningful at the real FFI. */

/** Build a uniffi-shaped numeric enum: forward members plus reverse mapping. */
function mockNumericEnum<T extends string>(...names: T[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  names.forEach((name, i) => {
    out[name] = i;
    out[String(i)] = name;
  });
  return out;
}

const mockSkipNames = [
  'EntryPathInvalid',
  'EntryPathTraversal',
  'EntrySymlink',
  'EntrySpecialFile',
  'EntryEncrypted',
  'EntryNestedArchive',
  'EntryUnsupportedMethod',
  'EntryDuplicate',
  'EntryOverCap',
  'EntryRatioExceeded',
  'EntryCorrupt',
  'EntryKindNotEnabled',
  'EntryKindMismatch',
  'EntryNotUtf8',
  'EntryNotAllowlisted',
] as const;

const mockErrorTags = [
  'NotZip',
  'Corrupt',
  'Unsupported',
  'TooManyEntries',
  'TooManyParts',
  'SessionBytesExceeded',
  'DuplicatePart',
  'NotSeekable',
  'ReadFailed',
  'AccessLost',
  'Changed',
  'StagingUnavailable',
  'NoSpace',
  'Cancelled',
  'SessionClosed',
  'Busy',
  'StagingInUse',
  'Internal',
] as const;

const mockEntrySkipCode = mockNumericEnum(...mockSkipNames);
const mockUriSkipCode = mockNumericEnum(
  'UriInvalid',
  'UriOutsideAllowlist',
  'UriUnresolved',
  'UriAmbiguous',
  'UriUnsupportedKind',
);
const mockEntryKindEnum = mockNumericEnum('Json', 'Image', 'Video');
const mockArchiveErrorTags = Object.fromEntries(mockErrorTags.map((t) => [t, t]));

const mockCancelTokenCancel = jest.fn();
class MockCancelToken {
  cancel = mockCancelTokenCancel;
  isCancelled = (): boolean => false;
}

/** The fake native session every test drives. Reset in `beforeEach`. */
let mockNativeSession: any;
const mockNativeOpenArchive = jest.fn();

jest.mock('../bindings', () => ({
  EntrySkipCode: mockEntrySkipCode,
  UriSkipCode: mockUriSkipCode,
  EntryKind: mockEntryKindEnum,
  ArchiveError_Tags: mockArchiveErrorTags,
  UriResolution_Tags: { Resolved: 'Resolved', Skipped: 'Skipped' },
  PeekOutcome_Tags: { Head: 'Head', Skipped: 'Skipped' },
  JsonOutcome_Tags: { Text: 'Text', Skipped: 'Skipped' },
  ExtractOutcome_Tags: { Extracted: 'Extracted', Skipped: 'Skipped' },
  CancelToken: MockCancelToken,
  openArchive: (...args: unknown[]) => mockNativeOpenArchive(...args),
}));

const mockGlue = {
  pickArchiveParts: jest.fn(),
  openParts: jest.fn(),
  closeParts: jest.fn(),
  cancelOpenParts: jest.fn(),
  createStagingFile: jest.fn(),
  getStagingDirectory: jest.fn(() => '/Caches'),
  unlinkStagingFile: jest.fn(),
  releaseParts: jest.fn(),
  releaseAllPersistedParts: jest.fn(),
};
jest.mock('../NativeOrbitalArchiveAccess', () => ({ default: mockGlue }));

import * as wrapper from '../index';

const HANDLE = {
  handleId: 'h0',
  fd: 7,
  byteLength: 1024,
  fileId: '1:2',
  ref: 'ref-refreshed',
  persist: true,
};

function makeMockNativeSession(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    entries: jest.fn(() => []),
    parts: jest.fn(() => [{ index: 0, fp: 'fp0', byteLength: 1024n, fileId: '1:2' }]),
    rejectedCounts: jest.fn(() => []),
    resolveMediaUris: jest.fn(() => []),
    releaseStaging: jest.fn(),
    cancel: jest.fn(),
    close: jest.fn(),
    peekHead: jest.fn(),
    readJson: jest.fn(),
    extractEntry: jest.fn(),
    ...overrides,
  };
}

async function openOneSession(
  options?: { signal?: AbortSignal },
): Promise<wrapper.ArchiveSession> {
  mockGlue.openParts.mockResolvedValue([HANDLE]);
  mockNativeOpenArchive.mockResolvedValue(mockNativeSession);
  const [token] = await pickOne();
  return wrapper.openArchive([token], options);
}

async function pickOne(): Promise<wrapper.ArchivePartToken[]> {
  mockGlue.pickArchiveParts.mockResolvedValue(['raw-ref']);
  const tokens = await wrapper.pickArchiveParts();
  if (tokens === null) throw new Error('expected tokens');
  return tokens;
}

/** Drain the microtask queue. Fake timers do not fake microtasks. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  wrapper.__resetArchiveReaderForTests();
  mockNativeSession = makeMockNativeSession();
  mockGlue.getStagingDirectory.mockReturnValue('/Caches');
});

// ---------------------------------------------------------------------------

describe('lazy loading (F11)', () => {
  it('performs zero native calls when the module is merely imported', () => {
    // The import at the top of this file has already run. If `index.tsx`
    // reached either native module eagerly, one of these would be non-zero.
    expect(mockGlue.getStagingDirectory).not.toHaveBeenCalled();
    expect(mockNativeOpenArchive).not.toHaveBeenCalled();
    expect(mockCancelTokenCancel).not.toHaveBeenCalled();
  });

  it('exposes the disposition table without loading anything native', () => {
    expect(wrapper.ARCHIVE_ERROR_DISPOSITIONS.ARCHIVE_ACCESS_LOST).toBe('requires-repick');
    expect(wrapper.ARCHIVE_ERROR_DISPOSITIONS.ARCHIVE_BUSY).toBe('retryable-pause');
    expect(wrapper.ARCHIVE_ERROR_DISPOSITIONS.ARCHIVE_STAGING_IN_USE).toBe('terminal-for-run');
    expect(wrapper.ARCHIVE_ERROR_DISPOSITIONS.ECANCELLED).toBe('user-action');
    expect(mockGlue.getStagingDirectory).not.toHaveBeenCalled();
  });
});

describe('error normalisation', () => {
  it('maps every uniffi ArchiveError tag to its code', async () => {
    const expected: Record<string, string> = {
      NotZip: 'ARCHIVE_NOT_ZIP',
      Corrupt: 'ARCHIVE_CORRUPT',
      Unsupported: 'ARCHIVE_UNSUPPORTED',
      TooManyEntries: 'ARCHIVE_TOO_MANY_ENTRIES',
      TooManyParts: 'ARCHIVE_TOO_MANY_PARTS',
      SessionBytesExceeded: 'ARCHIVE_SESSION_BYTES_EXCEEDED',
      DuplicatePart: 'ARCHIVE_DUPLICATE_PART',
      NotSeekable: 'ARCHIVE_NOT_SEEKABLE',
      ReadFailed: 'ARCHIVE_READ_FAILED',
      AccessLost: 'ARCHIVE_ACCESS_LOST',
      Changed: 'ARCHIVE_CHANGED',
      StagingUnavailable: 'ARCHIVE_STAGING_UNAVAILABLE',
      NoSpace: 'ARCHIVE_NO_SPACE',
      Cancelled: 'ECANCELLED',
      SessionClosed: 'ARCHIVE_SESSION_CLOSED',
      Busy: 'ARCHIVE_BUSY',
      StagingInUse: 'ARCHIVE_STAGING_IN_USE',
      Internal: 'ARCHIVE_INTERNAL',
    };
    for (const tag of mockErrorTags) {
      const session = await openOneSession();
      mockNativeSession.readJson.mockRejectedValue({ tag });
      await expect(session.readJson('e1')).rejects.toMatchObject({ code: expected[tag] });
    }
  });

  it('carries partIndex as a count for AccessLost', async () => {
    const session = await openOneSession();
    mockNativeSession.readJson.mockRejectedValue({ tag: 'AccessLost', inner: { partIndex: 3 } });
    await expect(session.readJson('e1')).rejects.toMatchObject({
      code: 'ARCHIVE_ACCESS_LOST',
      partIndex: 3,
    });
  });

  it('maps an unknown tag, an unknown glue code and a bare Error to ARCHIVE_INTERNAL', async () => {
    const session = await openOneSession();
    for (const thrown of [
      { tag: 'SomethingNew' },
      { code: 'E_WAT' },
      new Error('boom'),
      'a string',
      null,
    ]) {
      mockNativeSession.readJson.mockRejectedValue(thrown);
      await expect(session.readJson('e1')).rejects.toMatchObject({ code: 'ARCHIVE_INTERNAL' });
    }
  });

  it('accepts only the glue codes on the glue allowlist', async () => {
    mockGlue.pickArchiveParts.mockRejectedValue({ code: 'PICKER_BUSY' });
    await expect(wrapper.pickArchiveParts()).rejects.toMatchObject({ code: 'PICKER_BUSY' });
    mockGlue.pickArchiveParts.mockRejectedValue({ code: 'ARCHIVE_CORRUPT' });
    await expect(wrapper.pickArchiveParts()).rejects.toMatchObject({ code: 'ARCHIVE_INTERNAL' });
  });

  it('uses one fixed message per code and never interpolates', async () => {
    const session = await openOneSession();
    mockNativeSession.readJson.mockRejectedValue({ tag: 'NotSeekable' });
    const e = await session.readJson('e1').catch((err: unknown) => err);
    expect(e).toBeInstanceOf(wrapper.ArchiveReaderError);
    expect((e as Error).message).toBe(
      'This file cannot be read in place. Copy it to your device first.',
    );
    expect((e as Error).message).not.toContain('e1');
  });

  it('recognises its own cancellation code', () => {
    expect(isArchiveCancellationOf('ECANCELLED')).toBe(true);
    expect(isArchiveCancellationOf('ARCHIVE_BUSY')).toBe(false);
    expect(wrapper.isArchiveCancellation(new Error('ECANCELLED'))).toBe(false);
  });
});

function isArchiveCancellationOf(code: wrapper.ArchiveErrorCode): boolean {
  return wrapper.isArchiveCancellation(new wrapper.ArchiveReaderError(code));
}

describe('token codec', () => {
  it('round-trips a token through pick -> open -> refreshed parts', async () => {
    const [picked] = await pickOne();
    expect(picked.startsWith('oar1:')).toBe(true);
    expect(wrapper.isArchivePartToken(picked)).toBe(true);

    mockGlue.openParts.mockResolvedValue([HANDLE]);
    mockNativeOpenArchive.mockResolvedValue(mockNativeSession);
    const session = await wrapper.openArchive([picked]);

    // The persisted token carries the REFRESHED ref, the mockGlue's persist flag
    // and the fingerprint, none of which the picked token had.
    expect(session.parts).toHaveLength(1);
    const reopened = session.parts[0];
    expect(reopened).not.toBe(picked);
    await wrapper.releaseArchiveParts([reopened]);
    expect(mockGlue.releaseParts).toHaveBeenCalledWith(['ref-refreshed']);

    // And it is handed back to Rust as expectedFp on the next open.
    mockNativeOpenArchive.mockClear();
    mockGlue.openParts.mockResolvedValue([HANDLE]);
    await wrapper.openArchive([reopened]);
    expect(mockNativeOpenArchive.mock.calls[0][0]).toEqual([
      { fd: 7, byteLength: 1024n, fileId: '1:2', expectedFp: 'fp0' },
    ]);
  });

  it('survives non-ASCII in a ref', async () => {
    mockGlue.pickArchiveParts.mockResolvedValue(['réf-\u{1F600}-ok']);
    const tokens = await wrapper.pickArchiveParts();
    mockGlue.openParts.mockResolvedValue([{ ...HANDLE, ref: 'réf-\u{1F600}-ok' }]);
    mockNativeOpenArchive.mockResolvedValue(mockNativeSession);
    const session = await wrapper.openArchive(tokens!);
    await wrapper.releaseArchiveParts(session.parts);
    expect(mockGlue.releaseParts).toHaveBeenCalledWith(['réf-\u{1F600}-ok']);
  });

  it('rejects a malformed token as ARCHIVE_INTERNAL, not as a corrupt archive', async () => {
    for (const bad of ['', 'nope', 'oar1:!!!', `oar1:${btoaUrl('{"v":2}')}`]) {
      expect(wrapper.isArchivePartToken(bad)).toBe(false);
      await expect(
        wrapper.openArchive([bad as wrapper.ArchivePartToken]),
      ).rejects.toMatchObject({ code: 'ARCHIVE_INTERNAL' });
    }
    expect(mockGlue.openParts).not.toHaveBeenCalled();
  });

  it('returns null, not an empty list, when the picker was cancelled', async () => {
    mockGlue.pickArchiveParts.mockResolvedValue(null);
    await expect(wrapper.pickArchiveParts()).resolves.toBeNull();
  });
});

/** Minimal base64url for the malformed-token fixture above. */
function btoaUrl(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = Array.from(text, (c) => c.charCodeAt(0));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [b0, b1, b2] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 === undefined) break;
    out += alphabet[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 === undefined) break;
    out += alphabet[b2 & 63];
  }
  return out;
}

describe('listing and bigint narrowing', () => {
  it('narrows u64 sizes and clamps a saturated one instead of throwing', async () => {
    mockNativeSession = makeMockNativeSession({
      entries: jest.fn(() => [
        {
          entryId: 'fp0:1',
          path: 'media/posts/a.jpg',
          kind: 1,
          declaredSize: 1234n,
          skip: undefined,
        },
        {
          entryId: 'fp0:2',
          path: 'media/posts/b.jpg',
          kind: 1,
          declaredSize: 18446744073709551615n,
          skip: 10, // EntryCorrupt
        },
      ]),
      rejectedCounts: jest.fn(() => [{ code: 14, count: 9007199254740999n }]),
    });
    const session = await openOneSession();
    expect(session.entries[0]).toEqual({
      entryId: 'fp0:1',
      path: 'media/posts/a.jpg',
      kind: 'image',
      declaredSize: 1234,
      skip: null,
    });
    expect(session.entries[1].declaredSize).toBe(Number.MAX_SAFE_INTEGER);
    expect(session.entries[1].skip).toBe('ENTRY_CORRUPT');
    expect(session.rejectedCounts.ENTRY_NOT_ALLOWLISTED).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('fails closed when Rust grows an enum member the wrapper does not map', async () => {
    // Mutate the fake enum in place rather than re-mocking the module: a
    // `jest.doMock('../bindings')` here leaks into every later test, because
    // `__resetArchiveReaderForTests()` drops the wrapper's cached bindings and
    // the next `getNative()` would pick the doMock up.
    const added = mockSkipNames.length;
    (mockEntrySkipCode as Record<string, unknown>).EntrySomethingNew = added;
    (mockEntrySkipCode as Record<string, unknown>)[String(added)] = 'EntrySomethingNew';
    try {
      mockGlue.openParts.mockResolvedValue([HANDLE]);
      mockNativeOpenArchive.mockResolvedValue(mockNativeSession);
      const [token] = await pickOne();
      await expect(wrapper.openArchive([token])).rejects.toMatchObject({
        code: 'ARCHIVE_INTERNAL',
      });
    } finally {
      delete (mockEntrySkipCode as Record<string, unknown>).EntrySomethingNew;
      delete (mockEntrySkipCode as Record<string, unknown>)[String(added)];
    }
  });

  it('maps resolveMediaUris outcomes both ways', async () => {
    mockNativeSession = makeMockNativeSession({
      resolveMediaUris: jest.fn(() => [
        { tag: 'Resolved', inner: { entryId: 'fp0:5' } },
        { tag: 'Skipped', inner: { skip: 1 } },
      ]),
    });
    const session = await openOneSession();
    expect(session.resolveMediaUris(['a', 'b'])).toEqual([
      { ok: true, entryId: 'fp0:5' },
      { ok: false, skip: 'URI_OUTSIDE_ALLOWLIST' },
    ]);
  });
});

describe('fd contract (F2)', () => {
  it('closes every handle after a successful open', async () => {
    await openOneSession();
    expect(mockGlue.closeParts).toHaveBeenCalledTimes(1);
    expect(mockGlue.closeParts).toHaveBeenCalledWith(['h0']);
  });

  it('closes every handle when the Rust open throws', async () => {
    mockGlue.openParts.mockResolvedValue([HANDLE]);
    mockNativeOpenArchive.mockRejectedValue({ tag: 'NotZip' });
    const [token] = await pickOne();
    await expect(wrapper.openArchive([token])).rejects.toMatchObject({
      code: 'ARCHIVE_NOT_ZIP',
    });
    expect(mockGlue.closeParts).toHaveBeenCalledWith(['h0']);
  });

  it('closes nothing when openParts itself throws', async () => {
    mockGlue.openParts.mockRejectedValue({ code: 'ARCHIVE_ACCESS_LOST' });
    const [token] = await pickOne();
    await expect(wrapper.openArchive([token])).rejects.toMatchObject({
      code: 'ARCHIVE_ACCESS_LOST',
    });
    expect(mockGlue.closeParts).not.toHaveBeenCalled();
  });
});

describe('cancellation (F4)', () => {
  it('asks Rust to cancel the job and rejects ECANCELLED', async () => {
    jest.useFakeTimers();
    try {
      const session = await openOneSession();
      mockNativeSession.readJson.mockReturnValue(new Promise(() => {}));
      const controller = new AbortController();
      const pending = session.readJson('e1', { signal: controller.signal });
      // Awaited below, after the abort and the timer advance this test exists
      // to interleave; the rule cannot see a stored assertion.
      // eslint-disable-next-line jest/valid-expect
      const assertion = expect(pending).rejects.toMatchObject({ code: 'ECANCELLED' });
      controller.abort();
      // The REAL native cancel happens the moment abort fires, not when the
      // backstop timer expires: Rust polls the flag inside its loops.
      expect(mockNativeSession.cancel).toHaveBeenCalledTimes(1);
      expect(typeof mockNativeSession.cancel.mock.calls[0][0]).toBe('string');
      jest.advanceTimersByTime(1500);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels the open token and closes a session that arrives late', async () => {
    jest.useFakeTimers();
    try {
      mockGlue.openParts.mockResolvedValue([HANDLE]);
      let settle: (v: unknown) => void = () => {};
      mockNativeOpenArchive.mockReturnValue(new Promise((r) => (settle = r)));
      const [token] = await pickOne();
      const controller = new AbortController();
      const pending = wrapper.openArchive([token], { signal: controller.signal });
      // Awaited below, after the abort and the timer advance this test exists
      // to interleave; the rule cannot see a stored assertion.
      // eslint-disable-next-line jest/valid-expect
      const assertion = expect(pending).rejects.toMatchObject({ code: 'ECANCELLED' });
      // Drain enough microtasks that openParts has resolved and the SECOND
      // backstop (the one holding the CancelToken) is the armed one.
      await flushMicrotasks();
      controller.abort();
      expect(mockCancelTokenCancel).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1500);
      await assertion;
      // The late settle must be swallowed AND its fd dups dropped.
      settle(mockNativeSession);
      await flushMicrotasks();
      expect(mockNativeSession.close).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('unlinks and releases a staging file an abandoned extract finished', async () => {
    jest.useFakeTimers();
    try {
      const session = await openOneSession();
      mockGlue.createStagingFile.mockResolvedValue('/Caches/u-archive-staging.bin');
      let settle: (v: unknown) => void = () => {};
      mockNativeSession.extractEntry.mockReturnValue(new Promise((r) => (settle = r)));
      const controller = new AbortController();
      const pending = session.extractEntry('fp0:1', 'image', { signal: controller.signal });
      // Awaited below, after the abort and the timer advance this test exists
      // to interleave; the rule cannot see a stored assertion.
      // eslint-disable-next-line jest/valid-expect
      const assertion = expect(pending).rejects.toMatchObject({ code: 'ECANCELLED' });
      await flushMicrotasks();
      controller.abort();
      jest.advanceTimersByTime(1500);
      await assertion;
      settle({
        tag: 'Extracted',
        inner: { path: '/Caches/u-archive-staging.bin', byteLength: 10n, head: new ArrayBuffer(0) },
      });
      await flushMicrotasks();
      expect(mockGlue.unlinkStagingFile).toHaveBeenCalledWith('/Caches/u-archive-staging.bin');
      expect(mockNativeSession.releaseStaging).toHaveBeenCalledWith('/Caches/u-archive-staging.bin');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not arm a backstop when no signal was given', async () => {
    const session = await openOneSession();
    mockNativeSession.readJson.mockResolvedValue({ tag: 'Text', inner: { text: '{}' } });
    await expect(session.readJson('e1')).resolves.toEqual({ ok: true, text: '{}' });
    expect(mockNativeSession.cancel).not.toHaveBeenCalled();
  });
});

describe('extract outcomes', () => {
  it('maps a successful extract, narrowing byteLength and copying the head', async () => {
    const session = await openOneSession();
    mockGlue.createStagingFile.mockResolvedValue('/Caches/u-archive-staging.bin');
    mockNativeSession.extractEntry.mockResolvedValue({
      tag: 'Extracted',
      inner: {
        path: '/Caches/u-archive-staging.bin',
        byteLength: 42n,
        head: new Uint8Array([0xff, 0xd8, 0xff]).buffer,
      },
    });
    const result = await session.extractEntry('fp0:1', 'image');
    expect(result).toMatchObject({ ok: true, path: '/Caches/u-archive-staging.bin', byteLength: 42 });
    expect(Array.from((result as { head: Uint8Array }).head)).toEqual([0xff, 0xd8, 0xff]);
    // A successful extract is the caller's to unlink.
    expect(mockGlue.unlinkStagingFile).not.toHaveBeenCalled();
  });

  it('releases and unlinks the staging file when Rust skips the entry', async () => {
    const session = await openOneSession();
    mockGlue.createStagingFile.mockResolvedValue('/Caches/u-archive-staging.bin');
    mockNativeSession.extractEntry.mockResolvedValue({ tag: 'Skipped', inner: { skip: 8 } });
    await expect(session.extractEntry('fp0:1', 'image')).resolves.toEqual({
      ok: false,
      skip: 'ENTRY_OVER_CAP',
    });
    expect(mockGlue.unlinkStagingFile).toHaveBeenCalledWith('/Caches/u-archive-staging.bin');
    expect(mockNativeSession.releaseStaging).toHaveBeenCalledWith('/Caches/u-archive-staging.bin');
  });

  it('maps a peekHead skip and a head', async () => {
    const session = await openOneSession();
    mockNativeSession.peekHead.mockResolvedValue({
      tag: 'Head',
      inner: { head: new Uint8Array([1, 2]).buffer },
    });
    const head = await session.peekHead('fp0:1');
    expect(head).toEqual({ ok: true, head: new Uint8Array([1, 2]) });
    mockNativeSession.peekHead.mockResolvedValue({ tag: 'Skipped', inner: { skip: 11 } });
    await expect(session.peekHead('fp0:1')).resolves.toEqual({
      ok: false,
      skip: 'ENTRY_KIND_NOT_ENABLED',
    });
  });
});

describe('wipe epoch (F3)', () => {
  it('closes every live session synchronously and without awaiting', () => {
    expect(() => wrapper.abortAllArchiveSessions()).not.toThrow();
  });

  it('a session that was live when the wipe ran cannot create a staging file', async () => {
    const session = await openOneSession();
    wrapper.abortAllArchiveSessions();
    expect(mockNativeSession.close).toHaveBeenCalledTimes(1);
    await expect(session.extractEntry('fp0:1', 'image')).rejects.toMatchObject({
      code: 'ARCHIVE_SESSION_CLOSED',
    });
    expect(mockGlue.createStagingFile).not.toHaveBeenCalled();
    await expect(session.readJson('fp0:1')).rejects.toMatchObject({
      code: 'ARCHIVE_SESSION_CLOSED',
    });
  });

  it('a session created across the wipe cannot create a staging file either', async () => {
    // The dangerous race: openArchive is in flight when localWipe lands, so
    // the session is minted AFTER the epoch bump. It must be closed and
    // refused, never handed out.
    mockGlue.openParts.mockResolvedValue([HANDLE]);
    let settle: (v: unknown) => void = () => {};
    mockNativeOpenArchive.mockReturnValue(new Promise((r) => (settle = r)));
    const [token] = await pickOne();
    const pending = wrapper.openArchive([token]);
    wrapper.abortAllArchiveSessions();
    settle(mockNativeSession);
    await expect(pending).rejects.toMatchObject({ code: 'ARCHIVE_SESSION_CLOSED' });
    expect(mockNativeSession.close).toHaveBeenCalled();
    expect(mockGlue.createStagingFile).not.toHaveBeenCalled();
    expect(mockGlue.closeParts).toHaveBeenCalledWith(['h0']);
  });

  it('releaseAllPersistedParts goes straight to the glue', async () => {
    mockGlue.releaseAllPersistedParts.mockResolvedValue(undefined);
    await wrapper.releaseAllPersistedParts();
    expect(mockGlue.releaseAllPersistedParts).toHaveBeenCalledTimes(1);
  });
});
