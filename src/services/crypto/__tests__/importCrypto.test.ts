/**
 * Behaviour tests for the #924 import crypto module.
 *
 * Deliberately split from `importCrypto.kat.test.ts`: that file installs real
 * primitives to pin exact bytes, this one keeps the repo-wide DISTINCTNESS
 * stub, because almost everything here is about relationships — different
 * member ⇒ different key, same key ⇒ same fingerprint — and a stub whose
 * output depends on every input byte answers those honestly while keeping the
 * fixtures legible.
 *
 * The one thing the stub cannot stand in for is authenticated encryption, so
 * the contentCrypto mock below wires `encryptContent` / `decryptContent` to a
 * REAL AES-256-GCM pair in the same wire format the module uses (ciphertext ‖
 * 16-byte tag, 12-byte IV, groupId as AAD). Without that, "a flipped
 * ciphertext byte raises ImportMetaAuthError" would be testing a mock's
 * politeness rather than a MAC.
 */

const mockGetOrFetchGroupKey = jest.fn();
const mockCompareGroupKeyPin = jest.fn();

jest.mock('../contentCrypto', () => {
  // A jest.mock factory may not close over out-of-scope imports.
  const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

  class PendingWrapError extends Error {
    constructor() {
      super('Group key not yet available (pending wrap)');
      this.name = 'PendingWrapError';
    }
  }

  return {
    PendingWrapError,
    getOrFetchGroupKey: (...args: unknown[]) => mockGetOrFetchGroupKey(...args),
    compareGroupKeyPin: (...args: unknown[]) => mockCompareGroupKeyPin(...args),
    encryptContent: (plaintext: string, groupKey: Uint8Array, groupId: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(groupKey), iv, {
        authTagLength: 16,
      });
      cipher.setAAD(Buffer.from(groupId, 'utf8'));
      const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
      return {
        ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
        iv: iv.toString('base64'),
      };
    },
    decryptContent: (
      ciphertextB64: string,
      ivB64: string,
      groupKey: Uint8Array,
      groupId: string,
    ) => {
      const buf = Buffer.from(ciphertextB64, 'base64');
      if (buf.length < 16) throw new Error('ciphertext too short');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(groupKey),
        Buffer.from(ivB64, 'base64'),
        { authTagLength: 16 },
      );
      decipher.setAAD(Buffer.from(groupId, 'utf8'));
      decipher.setAuthTag(buf.subarray(buf.length - 16));
      return Buffer.concat([
        decipher.update(buf.subarray(0, buf.length - 16)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
});

const mockGetState = jest.fn();
jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: { getState: () => mockGetState() },
}));

import type { ParseOptions } from '../../metaImport/types';
import { PendingWrapError } from '../contentCrypto';
import { GroupKeyUnwrapError } from '../groupKeyErrors';
import {
  classifyImportCryptoError,
  closeAllImportKeySessions,
  DERIVE_YIELD_EVERY,
  ImportCryptoInvariantError,
  ImportKeyChangedError,
  ImportKeySessionClosedError,
  ImportMetaAuthError,
  importKeyToWire,
  ImportUserIdError,
  openImportKeySession,
  openImportMeta,
  parseImportMetaPlaintext,
} from '../importCrypto';

/**
 * The repo-wide stub object itself, for `jest.spyOn`.
 *
 * `require`, not `jest.requireMock`: this file registers no factory for
 * `orbital-signal` (it comes in through `moduleNameMapper`), and
 * `requireMock` would hand back a freshly automocked copy that the module
 * under test never sees — so the spy would record nothing.
 */
const signal = require('orbital-signal') as {
  hkdfSha256: (ikm: ArrayBuffer, salt: ArrayBuffer, info: ArrayBuffer, len: number) => ArrayBuffer;
  hmacSha256: (key: ArrayBuffer, input: ArrayBuffer) => ArrayBuffer;
};

const USER_ID = '3f2a1c6e-8b4d-4f1a-9c7e-5d0a2b6f8e14';
const OTHER_USER_ID = '91b4c07d-2e5a-4a3b-8f16-0c7d9e4a1b25';
const GROUP_ID = 'orbit-1';

const key = (fill: number) => new Uint8Array(32).fill(fill);
const ITEM = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

async function open(overrides: { source?: 'facebook' | 'instagram'; yieldEvery?: number } = {}) {
  return openImportKeySession({
    groupId: GROUP_ID,
    source: overrides.source ?? 'facebook',
    yieldEvery: overrides.yieldEvery,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  closeAllImportKeySessions();
  mockGetState.mockReturnValue({ userId: USER_ID });
  mockGetOrFetchGroupKey.mockResolvedValue(key(0x42));
  mockCompareGroupKeyPin.mockReturnValue('match');
});

// ---------------------------------------------------------------------------
// userId
// ---------------------------------------------------------------------------

describe('userId handling', () => {
  it.each([
    ['null', null],
    ['an empty string', ''],
    ['a non-UUID', 'not-a-uuid'],
    ['a UUIDv1', '3f2a1c6e-8b4d-1f1a-9c7e-5d0a2b6f8e14'],
    ['a UUID with a bad variant nibble', '3f2a1c6e-8b4d-4f1a-1c7e-5d0a2b6f8e14'],
  ])('refuses to open on %s', async (_label, userId) => {
    mockGetState.mockReturnValue({ userId });

    await expect(open()).rejects.toThrow(ImportUserIdError);
  });

  it('classifies a bad userId as terminal for the run', async () => {
    mockGetState.mockReturnValue({ userId: null });

    const error = await open().catch((e: unknown) => e);
    expect(classifyImportCryptoError(error)).toBe('terminal-for-run');
  });

  it('derives the same key for an uppercase and a lowercase userId', async () => {
    const lower = await open();
    const fromLower = hex(await lower.deriveImportKey(ITEM));
    lower.close();

    mockGetState.mockReturnValue({ userId: USER_ID.toUpperCase() });
    const upper = await open();
    const fromUpper = hex(await upper.deriveImportKey(ITEM));
    upper.close();

    expect(fromUpper).toBe(fromLower);
  });

  it('derives DIFFERENT keys for two members of the same orbit', async () => {
    const mine = await open();
    const fromMine = hex(await mine.deriveImportKey(ITEM));
    mine.close();

    mockGetState.mockReturnValue({ userId: OTHER_USER_ID });
    const theirs = await open();
    const fromTheirs = hex(await theirs.deriveImportKey(ITEM));
    theirs.close();

    // The backend's cross-member unlinkability is exactly this property: the
    // userId is the only per-member input to K_import.
    expect(fromTheirs).not.toBe(fromMine);
  });

  it('derives a DIFFERENT key for the same member under a different group key', async () => {
    const first = await open();
    const fromFirst = hex(await first.deriveImportKey(ITEM));
    first.close();

    mockGetOrFetchGroupKey.mockResolvedValue(key(0x17));
    const second = await open();
    const fromSecond = hex(await second.deriveImportKey(ITEM));
    second.close();

    // The rotation ⇄ dedup coupling, from the other direction: this is WHY the
    // key is pinned for the length of a run.
    expect(fromSecond).not.toBe(fromFirst);
  });
});

// ---------------------------------------------------------------------------
// The pin
// ---------------------------------------------------------------------------

describe('group key pin', () => {
  it('pins a COPY, so an in-place cache wipe cannot zero it mid-run', async () => {
    const live = key(0x42);
    mockGetOrFetchGroupKey.mockResolvedValue(live);

    const session = await open();
    // Exactly what invalidateGroupKey/clearGroupKeyCache do to the cached array.
    live.fill(0);

    await session.verifyGroupKeyPin();

    const [, candidate] = mockCompareGroupKeyPin.mock.calls[0] as [string, Uint8Array];
    expect(hex(candidate)).toBe('42'.repeat(32));
    session.close();
  });

  it('throws ImportKeyChangedError, terminal for the run, when the key changed', async () => {
    const session = await open();
    mockCompareGroupKeyPin.mockReturnValue('changed');

    const error = await session.verifyGroupKeyPin().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportKeyChangedError);
    expect(classifyImportCryptoError(error)).toBe('terminal-for-run');
    session.close();
  });

  it('refetches when both tiers are absent, and passes when the refetch matches', async () => {
    const session = await open();
    mockCompareGroupKeyPin.mockReturnValue('absent');
    mockGetOrFetchGroupKey.mockResolvedValue(key(0x42));

    await expect(session.verifyGroupKeyPin()).resolves.toBeUndefined();
    // Once to open, once to answer the absent verdict.
    expect(mockGetOrFetchGroupKey).toHaveBeenCalledTimes(2);
    session.close();
  });

  it('throws when the refetch returns a different key', async () => {
    const session = await open();
    mockCompareGroupKeyPin.mockReturnValue('absent');
    mockGetOrFetchGroupKey.mockResolvedValue(key(0x17));

    await expect(session.verifyGroupKeyPin()).rejects.toThrow(ImportKeyChangedError);
    session.close();
  });

  it('pauses rather than aborting when the refetch is still pending', async () => {
    const session = await open();
    mockCompareGroupKeyPin.mockReturnValue('absent');
    mockGetOrFetchGroupKey.mockRejectedValue(new PendingWrapError());

    const error = await session.verifyGroupKeyPin().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PendingWrapError);
    // "Can't tell yet" is a pause, never a permanent failure.
    expect(classifyImportCryptoError(error)).toBe('retryable-pause');
    session.close();
  });

  it('pauses when opening the session hits an unopenable envelope', async () => {
    mockGetOrFetchGroupKey.mockRejectedValue(new GroupKeyUnwrapError('no_envelope', 'requested'));

    const error = await open().catch((e: unknown) => e);
    expect(classifyImportCryptoError(error)).toBe('retryable-pause');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('session lifecycle', () => {
  it('zeroes K_import and the pin on close, and is idempotent', async () => {
    const hmacSpy = jest.spyOn(signal, 'hmacSha256');
    const session = await open();

    // The fingerprint HMAC is the first call, and its `key` argument IS the
    // live K_import buffer.
    const kImport = hmacSpy.mock.calls[0][0] as ArrayBuffer;
    await session.verifyGroupKeyPin();
    const pinned = mockCompareGroupKeyPin.mock.calls[0][1] as Uint8Array;

    expect(hex(new Uint8Array(kImport))).not.toBe('00'.repeat(32));
    expect(hex(pinned)).toBe('42'.repeat(32));

    session.close();
    expect(hex(new Uint8Array(kImport))).toBe('00'.repeat(32));
    expect(hex(pinned)).toBe('00'.repeat(32));

    expect(() => session.close()).not.toThrow();
  });

  it.each([
    ['deriveImportKey', (s: Awaited<ReturnType<typeof open>>) => s.deriveImportKey(ITEM)],
    ['verifyGroupKeyPin', (s: Awaited<ReturnType<typeof open>>) => s.verifyGroupKeyPin()],
    ['sealImportMeta', (s: Awaited<ReturnType<typeof open>>) => s.sealImportMeta(0)],
  ])('refuses %s after close, terminally', async (_label, call) => {
    const session = await open();
    session.close();

    const error = await call(session).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportKeySessionClosedError);
    expect(classifyImportCryptoError(error)).toBe('terminal-for-run');
  });

  it('closeAllImportKeySessions() closes every open session', async () => {
    const hmacSpy = jest.spyOn(signal, 'hmacSha256');
    const first = await open();
    const second = await open({ source: 'instagram' });

    const firstKey = hmacSpy.mock.calls[0][0] as ArrayBuffer;
    const secondKey = hmacSpy.mock.calls[1][0] as ArrayBuffer;

    closeAllImportKeySessions();

    expect(hex(new Uint8Array(firstKey))).toBe('00'.repeat(32));
    expect(hex(new Uint8Array(secondKey))).toBe('00'.repeat(32));
    await expect(first.deriveImportKey(ITEM)).rejects.toThrow(ImportKeySessionClosedError);
    await expect(second.deriveImportKey(ITEM)).rejects.toThrow(ImportKeySessionClosedError);
  });

  it('is safe to call closeAllImportKeySessions() with nothing open', () => {
    expect(() => closeAllImportKeySessions()).not.toThrow();
  });

  it('lets NO session escape a wipe that lands during the group-key fetch', async () => {
    const hkdfSpy = jest.spyOn(signal, 'hkdfSha256');
    let releaseKey!: (k: Uint8Array) => void;
    mockGetOrFetchGroupKey.mockReturnValue(
      new Promise<Uint8Array>((resolve) => {
        releaseKey = resolve;
      }),
    );

    const opening = open();
    // The wipe lands while the fetch is outstanding. At this instant the
    // session owns NO key material — its close() has nothing to zero — so the
    // registry alone cannot stop it; only the wipe epoch can.
    closeAllImportKeySessions();
    releaseKey(key(0x42));

    const error = await opening.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportKeySessionClosedError);
    expect(classifyImportCryptoError(error)).toBe('terminal-for-run');
    // No session object escaped, and no K_import was ever derived: the pin and
    // the derivation both sit past the epoch check.
    expect(hkdfSpy).not.toHaveBeenCalled();
  });

  it('zeroes the pin and K_import when the fingerprint HMAC throws', async () => {
    const live = key(0x42);
    mockGetOrFetchGroupKey.mockResolvedValue(live);

    // A failed open returns no session, so intercepting the pinning copy is
    // the only handle on `pinned`. The module calls `live.slice()` with no
    // arguments; this stands in for exactly that.
    let pinned: Uint8Array | undefined;
    jest.spyOn(live, 'slice').mockImplementation(() => {
      const copy = new Uint8Array(live.length);
      copy.set(live);
      pinned = copy;
      return copy;
    });

    const hkdfSpy = jest.spyOn(signal, 'hkdfSha256');
    jest.spyOn(signal, 'hmacSha256').mockImplementation(() => {
      throw new Error('FFI unavailable');
    });

    await expect(open()).rejects.toThrow('FFI unavailable');

    const kImport = hkdfSpy.mock.results[0].value as ArrayBuffer;
    expect(hex(new Uint8Array(kImport))).toBe('00'.repeat(32));
    expect(pinned).toBeDefined();
    expect(hex(pinned as Uint8Array)).toBe('00'.repeat(32));
    // The cache's own array is untouched: the pin was always a copy of it.
    expect(hex(live)).toBe('42'.repeat(32));
  });

  it('drops a derived import_key when a wipe lands during the yield', async () => {
    const session = await open({ yieldEvery: 1 });
    jest.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      closeAllImportKeySessions();
      callback();
      return 0;
    }) as unknown as typeof setTimeout);

    // The token is derived from key material the wipe has just destroyed, and
    // #926 would persist it into a database the wipe is clearing.
    await expect(session.deriveImportKey(ITEM)).rejects.toThrow(ImportKeySessionClosedError);
  });

  it('fingerprints the key: stable across sessions, different when the key changes', async () => {
    const first = await open();
    const second = await open();
    expect(second.keyFingerprint).toBe(first.keyFingerprint);
    // 8 bytes, standard padded base64.
    expect(first.keyFingerprint).toMatch(/^[A-Za-z0-9+/]{11}=$/);
    first.close();
    second.close();

    mockGetOrFetchGroupKey.mockResolvedValue(key(0x17));
    const rotated = await open();
    // #926 compares this on resume and aborts the job on a mismatch.
    expect(rotated.keyFingerprint).not.toBe(first.keyFingerprint);
    rotated.close();
  });
});

// ---------------------------------------------------------------------------
// Sealing and opening
// ---------------------------------------------------------------------------

describe('sealImportMeta / openImportMeta', () => {
  const POST_DATE = 1345982400000;

  it('seals the exact v1 plaintext and round-trips it through the real cipher', async () => {
    const session = await open();
    const { encryptedImportMeta, importMetaIv } = await session.sealImportMeta(POST_DATE);

    expect(encryptedImportMeta.length).toBeLessThanOrEqual(1024);
    expect(importMetaIv.length).toBeLessThanOrEqual(64);

    const opened = await openImportMeta(encryptedImportMeta, importMetaIv, GROUP_ID);
    expect(opened).toEqual({ v: 1, source: 'facebook', originalCreatedAt: POST_DATE });
    session.close();
  });

  it('carries the session source into the envelope', async () => {
    const session = await open({ source: 'instagram' });
    const sealed = await session.sealImportMeta(POST_DATE);

    expect(await openImportMeta(sealed.encryptedImportMeta, sealed.importMetaIv, GROUP_ID)).toEqual(
      {
        v: 1,
        source: 'instagram',
        originalCreatedAt: POST_DATE,
      },
    );
    session.close();
  });

  it('verifies the pin BEFORE sealing', async () => {
    const session = await open();
    mockCompareGroupKeyPin.mockReturnValue('changed');

    await expect(session.sealImportMeta(POST_DATE)).rejects.toThrow(ImportKeyChangedError);
    session.close();
  });

  it('refuses to seal under a live key that is not the pinned one', async () => {
    const session = await open();
    // The pin verifies — compareGroupKeyPin still says 'match' — and then the
    // fetch between the two awaits hands back different bytes, which is what
    // an invalidate-then-refetch landing in that window looks like. Sealing
    // import-meta under a key the rest of the import is not using is exactly
    // what the pin exists to prevent, so assuming live == pinned is not safe.
    mockGetOrFetchGroupKey.mockResolvedValue(key(0x17));

    const error = await session.sealImportMeta(POST_DATE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportKeyChangedError);
    expect(classifyImportCryptoError(error)).toBe('terminal-for-run');
    session.close();
  });

  it('refuses to seal when the session closes during the key fetch', async () => {
    const session = await open();
    mockGetOrFetchGroupKey.mockImplementation(() => {
      session.close();
      return Promise.resolve(key(0x42));
    });

    await expect(session.sealImportMeta(POST_DATE)).rejects.toThrow(ImportKeySessionClosedError);
  });

  it('refuses to finish verifying a pin the session lost mid-refetch', async () => {
    const session = await open();
    mockCompareGroupKeyPin.mockReturnValue('absent');
    mockGetOrFetchGroupKey.mockImplementation(() => {
      // By the time the refetch resolves the pin is 32 zeros; comparing
      // against it would report a CHANGED key, which is true but misleading
      // for a session that is simply gone.
      closeAllImportKeySessions();
      return Promise.resolve(key(0x42));
    });

    await expect(session.verifyGroupKeyPin()).rejects.toThrow(ImportKeySessionClosedError);
  });

  it.each([
    ['a fractional date', 1345982400000.5],
    ['NaN', Number.NaN],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses %s', async (_label, value) => {
    const session = await open();
    await expect(session.sealImportMeta(value)).rejects.toThrow('safe integer');
    session.close();
  });

  it('raises ImportMetaAuthError — not null — when one ciphertext byte is flipped', async () => {
    const session = await open();
    const { encryptedImportMeta, importMetaIv } = await session.sealImportMeta(POST_DATE);
    session.close();

    const bytes = Buffer.from(encryptedImportMeta, 'base64');
    bytes[0] ^= 0x01;
    const tampered = bytes.toString('base64');

    const error = await openImportMeta(tampered, importMetaIv, GROUP_ID).catch((e: unknown) => e);
    // A tamper signal. `null` is reserved for "authenticated, but not a v1
    // envelope", and conflating the two would hide a forged envelope.
    expect(error).toBeInstanceOf(ImportMetaAuthError);
    expect(classifyImportCryptoError(error)).toBe('terminal-for-run');
  });

  it('raises ImportMetaAuthError on a truncated or unparseable envelope', async () => {
    await expect(openImportMeta('AAAA', 'AAAAAAAAAAAAAAAA', GROUP_ID)).rejects.toThrow(
      ImportMetaAuthError,
    );
  });

  it('returns null for ciphertext that authenticates but is not a v1 envelope', async () => {
    const { encryptContent } = jest.requireMock('../contentCrypto') as {
      encryptContent: (p: string, k: Uint8Array, g: string) => { ciphertext: string; iv: string };
    };
    const sealed = encryptContent(JSON.stringify({ v: 2 }), key(0x42), GROUP_ID);

    await expect(openImportMeta(sealed.ciphertext, sealed.iv, GROUP_ID)).resolves.toBeNull();
  });

  it.each([
    ['a pending wrap', () => new PendingWrapError()],
    ['an unopenable envelope', () => new GroupKeyUnwrapError('no_envelope', 'requested')],
  ])('propagates %s from the group-key fetch unchanged', async (_label, makeError) => {
    const thrown = makeError();
    mockGetOrFetchGroupKey.mockRejectedValue(thrown);

    const error = await openImportMeta('AAAA', 'AAAA', GROUP_ID).catch((e: unknown) => e);
    expect(error).toBe(thrown);
    expect(classifyImportCryptoError(error)).toBe('retryable-pause');
  });
});

// ---------------------------------------------------------------------------
// parseImportMetaPlaintext
// ---------------------------------------------------------------------------

describe('parseImportMetaPlaintext', () => {
  it('ignores unknown keys', () => {
    expect(
      parseImportMetaPlaintext(
        JSON.stringify({ v: 1, source: 'facebook', originalCreatedAt: 7, extra: 'later version' }),
      ),
    ).toEqual({ v: 1, source: 'facebook', originalCreatedAt: 7 });
  });

  it.each([
    ['a future version', JSON.stringify({ v: 2, source: 'facebook', originalCreatedAt: 7 })],
    ['a non-object', JSON.stringify('nope')],
    ['an array', JSON.stringify([{ v: 1, source: 'facebook', originalCreatedAt: 7 }])],
    ['null', JSON.stringify(null)],
    ['a missing source', JSON.stringify({ v: 1, originalCreatedAt: 7 })],
    ['a missing date', JSON.stringify({ v: 1, source: 'facebook' })],
    ['a string date', JSON.stringify({ v: 1, source: 'facebook', originalCreatedAt: '7' })],
    ['NaN (serialized as null)', '{"v":1,"source":"facebook","originalCreatedAt":NaN}'],
    [
      'an unsafe integer',
      `{"v":1,"source":"facebook","originalCreatedAt":${Number.MAX_SAFE_INTEGER + 2}}`,
    ],
    ['a fractional date', JSON.stringify({ v: 1, source: 'facebook', originalCreatedAt: 7.5 })],
    ['an unknown source', JSON.stringify({ v: 1, source: 'tiktok', originalCreatedAt: 7 })],
    ['not JSON at all', 'definitely not json'],
  ])('returns null for %s', (_label, json) => {
    expect(parseImportMetaPlaintext(json)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mechanics
// ---------------------------------------------------------------------------

describe('derivation mechanics', () => {
  it('yields a macrotask every DERIVE_YIELD_EVERY derivations', async () => {
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const session = await open();

    const count = DERIVE_YIELD_EVERY * 2 + 5;
    for (let i = 0; i < count; i++) await session.deriveImportKey(ITEM);

    expect(setTimeoutSpy).toHaveBeenCalledTimes(Math.floor(count / DERIVE_YIELD_EVERY));
    session.close();
  });

  it('never yields with yieldEvery: 0, which is what fake-timer callers must pass', async () => {
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const session = await open({ yieldEvery: 0 });

    for (let i = 0; i < DERIVE_YIELD_EVERY * 2; i++) await session.deriveImportKey(ITEM);

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    session.close();
  });

  it('returns a 16-byte COPY with a 16-byte backing buffer', async () => {
    const session = await open();
    const importKey = await session.deriveImportKey(ITEM);

    expect(importKey.length).toBe(16);
    // Not a view over the 32-byte tag: the unpublished second half must not
    // ride along behind the bytes #921 persists.
    expect(importKey.buffer.byteLength).toBe(16);
    expect(importKey.byteOffset).toBe(0);
    session.close();
  });

  it('refuses an empty sourceItemId', async () => {
    const session = await open();
    await expect(session.deriveImportKey(new Uint8Array(0))).rejects.toThrow('must not be empty');
    session.close();
  });

  it('refuses an unknown source before any key material exists', async () => {
    await expect(
      openImportKeySession({
        groupId: GROUP_ID,
        source: 'tiktok' as unknown as 'facebook',
      }),
    ).rejects.toThrow('unknown import source');
  });

  it('rejects a wire encode of anything other than 16 bytes', () => {
    expect(() => importKeyToWire(new Uint8Array(15))).toThrow('exactly 16 bytes');
    expect(() => importKeyToWire(new Uint8Array(32))).toThrow('exactly 16 bytes');
    expect(importKeyToWire(new Uint8Array(16))).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it('returns null for an error that is not a crypto verdict', () => {
    // #926 falls through to its HTTP/network taxonomy on a null.
    expect(classifyImportCryptoError(new Error('ECONNRESET'))).toBeNull();
    expect(classifyImportCryptoError(undefined)).toBeNull();
  });

  it('satisfies the ParseOptions.deriveImportKey contract #925 consumes', async () => {
    const session = await open();
    // Compile-time: the whole point of the module is that this assignment
    // type-checks without an adapter.
    const injected = session.deriveImportKey satisfies ParseOptions['deriveImportKey'];

    expect((await injected(ITEM)).length).toBe(16);
    session.close();
  });
});

// ---------------------------------------------------------------------------
// The module's own invariant failures
// ---------------------------------------------------------------------------

describe('ImportCryptoInvariantError', () => {
  // Every one of these is a programming or archive-data defect that no retry
  // can clear. As plain `Error`s they classified as `null`, which #926 reads
  // as "not a crypto verdict" and would retry for the rest of the run.
  it.each([
    [
      'an unknown import source',
      () =>
        openImportKeySession({
          groupId: GROUP_ID,
          source: 'tiktok' as unknown as 'facebook',
        }),
    ],
    [
      'a group key of the wrong width',
      () => {
        mockGetOrFetchGroupKey.mockResolvedValue(new Uint8Array(16).fill(0x42));
        return open();
      },
    ],
    [
      'an empty sourceItemId',
      async () => {
        const session = await open();
        try {
          return await session.deriveImportKey(new Uint8Array(0));
        } finally {
          session.close();
        }
      },
    ],
    [
      'a non-safe-integer date',
      async () => {
        const session = await open();
        try {
          return await session.sealImportMeta(1.5);
        } finally {
          session.close();
        }
      },
    ],
  ])('maps %s to terminal-for-run', async (_label, call) => {
    const error = await call().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ImportCryptoInvariantError);
    expect(classifyImportCryptoError(error)).toBe('terminal-for-run');
    // One prefix, applied in the constructor.
    expect((error as Error).message.startsWith('importCrypto: ')).toBe(true);
  });

  it('maps a wire encode of the wrong width to terminal-for-run', () => {
    let error: unknown;
    try {
      importKeyToWire(new Uint8Array(15));
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ImportCryptoInvariantError);
    expect(classifyImportCryptoError(error)).toBe('terminal-for-run');
  });
});

// ---------------------------------------------------------------------------
// sealContent (#926 §2.10) — the group-key lifetime fix
// ---------------------------------------------------------------------------

describe('sealContent', () => {
  /**
   * The real defect this exists for: `getOrFetchGroupKey` returns the group-key
   * cache's OWN array, and `invalidateGroupKey` / `clearGroupKeyCache` zero that
   * array IN PLACE — reachable mid-run from the WebSocket decrypt retry. Here
   * `getOrFetchGroupKey` is mocked, so "the cache was zeroed under us" is
   * expressed as the fetch handing back zeroed (or wrong-width) bytes AFTER the
   * pin verified, which is byte-for-byte what the runner would see.
   */
  const contentCrypto = require('../contentCrypto') as {
    encryptContent: (p: string, k: Uint8Array, g: string) => { ciphertext: string; iv: string };
    decryptContent: (c: string, iv: string, k: Uint8Array, g: string) => string;
  };

  it('seals under the live key and round-trips through the real cipher', async () => {
    const session = await open();

    const { ciphertext, iv } = await session.sealContent('an imported post body');

    expect(contentCrypto.decryptContent(ciphertext, iv, key(0x42), GROUP_ID)).toBe(
      'an imported post body',
    );
    session.close();
  });

  it('seals an empty string, which an imported title legitimately is', async () => {
    const session = await open();

    const { ciphertext, iv } = await session.sealContent('');

    expect(contentCrypto.decryptContent(ciphertext, iv, key(0x42), GROUP_ID)).toBe('');
    session.close();
  });

  it('verifies the pin BEFORE sealing', async () => {
    const session = await open();
    mockCompareGroupKeyPin.mockReturnValue('changed');
    const encrypt = jest.spyOn(contentCrypto, 'encryptContent');

    await expect(session.sealContent('body')).rejects.toThrow(ImportKeyChangedError);
    expect(encrypt).not.toHaveBeenCalled();
    session.close();
  });

  it('refuses a live key that is not the pinned one', async () => {
    const session = await open();
    // The pin says 'match' and the fetch then hands back different bytes — an
    // invalidate-then-refetch landing in that window.
    mockGetOrFetchGroupKey.mockResolvedValue(key(0x17));
    const encrypt = jest.spyOn(contentCrypto, 'encryptContent');

    const error = await session.sealContent('body').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ImportKeyChangedError);
    expect(classifyImportCryptoError(error)).toBe('terminal-for-run');
    expect(encrypt).not.toHaveBeenCalled();
    session.close();
  });

  it('refuses an all-zero key — the cache zeroed in place mid-run', async () => {
    const session = await open();
    mockGetOrFetchGroupKey.mockResolvedValue(new Uint8Array(32));
    const encrypt = jest.spyOn(contentCrypto, 'encryptContent');

    const error = await session.sealContent('body').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ImportCryptoInvariantError);
    expect((error as Error).message).toContain('all zeros');
    expect(classifyImportCryptoError(error)).toBe('terminal-for-run');
    // The whole point: a post sealed under 32 zero bytes is readable by
    // anyone and unreadable by every member, and neither the pin (a copy) nor
    // encryptContent (which does not validate its key) would notice.
    expect(encrypt).not.toHaveBeenCalled();
    session.close();
  });

  it('refuses a key of the wrong width', async () => {
    const session = await open();
    mockGetOrFetchGroupKey.mockResolvedValue(new Uint8Array(16).fill(0x42));
    const encrypt = jest.spyOn(contentCrypto, 'encryptContent');

    const error = await session.sealContent('body').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ImportCryptoInvariantError);
    expect((error as Error).message).toContain('32 bytes');
    expect(encrypt).not.toHaveBeenCalled();
    session.close();
  });

  it('refuses after close()', async () => {
    const session = await open();
    session.close();

    await expect(session.sealContent('body')).rejects.toThrow(ImportKeySessionClosedError);
  });

  it('refuses when the session closes during the key fetch', async () => {
    const session = await open();
    mockGetOrFetchGroupKey.mockImplementation(() => {
      session.close();
      return Promise.resolve(key(0x42));
    });

    await expect(session.sealContent('body')).rejects.toThrow(ImportKeySessionClosedError);
  });

  it('propagates a pending wrap as retryable, never as a failure to seal', async () => {
    const session = await open();
    mockCompareGroupKeyPin.mockReturnValue('absent');
    mockGetOrFetchGroupKey.mockRejectedValue(new PendingWrapError());

    const error = await session.sealContent('body').catch((e: unknown) => e);

    expect(classifyImportCryptoError(error)).toBe('retryable-pause');
    session.close();
  });

  it('gives sealImportMeta the same protection, since it seals through this', async () => {
    const session = await open();
    mockGetOrFetchGroupKey.mockResolvedValue(new Uint8Array(32));
    const encrypt = jest.spyOn(contentCrypto, 'encryptContent');

    const error = await session.sealImportMeta(1345982400000).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ImportCryptoInvariantError);
    expect(encrypt).not.toHaveBeenCalled();
    session.close();
  });
});
