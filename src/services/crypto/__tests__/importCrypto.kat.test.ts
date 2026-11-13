/**
 * Known-Answer Tests for the #924 import-key derivation.
 *
 * ## Why this file mocks `orbital-signal` with real crypto
 *
 * The repo-wide mock is a DISTINCTNESS stub — input-dependent bytes so dedup
 * tests can tell items apart, and nothing more. A KAT needs the real
 * primitives, so this file installs a per-file `jest.mock` backed by Node's
 * `hkdfSync` / `createHmac` through `jest.fn` wrappers. The wrappers matter as
 * much as the primitives: they let the tests assert the ARGUMENTS this module
 * passes across the FFI boundary — the salt, the lowercased userId, the
 * `source ‖ 0x00 ‖ frame` input — which is where an encoder bug would live.
 *
 * Node, not a hand-rolled HKDF: the fixtures below are minted by
 * `packages/orbital-signal/rust/orbital_signal/tools/generate_kdf_kat_vectors.py`
 * (stdlib Python, RFC 5869 written out) and asserted on the Rust side by
 * `tests/kdf_kat_tests.rs`. Three independent implementations agreeing on the
 * same bytes is the point; a fourth hand-rolled one here would not add a thing.
 *
 * ## What is actually pinned
 *
 * KAT 2 and 3 run the REAL `buildSourceItemId` (#925) and assert its frame hex
 * against the Rust fixture before deriving from it. That is the cross-layer
 * contract: if #925's framing changes, these fail, and they have to — a silent
 * framing change re-identifies every imported post, and a re-import would
 * duplicate the member's entire history.
 */

/**
 * Argument SNAPSHOTS, taken inside the wrapper.
 *
 * `jest.fn().mock.calls` holds the live ArrayBuffers, and this module zeroes
 * the HKDF `ikm` the moment the call returns — so a `mock.calls` assertion
 * would read 32 zeros and fail for the right reason at the wrong time. The
 * copies are what the FFI saw; the zeroing itself is asserted separately.
 */
const mockHkdfArgs: { ikm: string; salt: string; info: string; outputLen: number }[] = [];
const mockHmacArgs: { key: string; input: string }[] = [];

jest.mock('orbital-signal', () => {
  // A jest.mock factory may not close over out-of-scope imports.
  const { createHmac, hkdfSync } = require('node:crypto');
  const snapshot = (ab: ArrayBuffer): string => Buffer.from(new Uint8Array(ab)).toString('hex');

  return {
    hkdfSha256: jest.fn(
      (ikm: ArrayBuffer, salt: ArrayBuffer, info: ArrayBuffer, outputLen: number): ArrayBuffer => {
        mockHkdfArgs.push({
          ikm: snapshot(ikm),
          salt: snapshot(salt),
          info: snapshot(info),
          outputLen,
        });
        return hkdfSync(
          'sha256',
          Buffer.from(ikm),
          Buffer.from(salt),
          Buffer.from(info),
          outputLen,
        );
      },
    ),
    hmacSha256: jest.fn((key: ArrayBuffer, input: ArrayBuffer): ArrayBuffer => {
      mockHmacArgs.push({ key: snapshot(key), input: snapshot(input) });
      const digest = createHmac('sha256', Buffer.from(key)).update(Buffer.from(input)).digest();
      return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
    }),
  };
});

const mockGetOrFetchGroupKey = jest.fn();
const mockCompareGroupKeyPin = jest.fn();

jest.mock('../contentCrypto', () => ({
  getOrFetchGroupKey: (...args: unknown[]) => mockGetOrFetchGroupKey(...args),
  compareGroupKeyPin: (...args: unknown[]) => mockCompareGroupKeyPin(...args),
  encryptContent: jest.fn(),
  decryptContent: jest.fn(),
  PendingWrapError: class PendingWrapError extends Error {},
}));

const mockGetState = jest.fn();
jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: { getState: () => mockGetState() },
}));

import { buildSourceItemId } from '../../metaImport/sourceItemId';
import { importKeyToWire, openImportKeySession } from '../importCrypto';

const signal = jest.requireMock('orbital-signal') as {
  hkdfSha256: jest.Mock;
  hmacSha256: jest.Mock;
};

// ---------------------------------------------------------------------------
// The shared fixture member and orbit (identical to `orbital_import_kat`)
// ---------------------------------------------------------------------------

const GROUP_KEY = new Uint8Array(32).fill(0x42);
const USER_ID = '3f2a1c6e-8b4d-4f1a-9c7e-5d0a2b6f8e14';
const K_IMPORT_HEX = '29d7d22cf36b6ed3d5749fb529a8714f82a1e8422df95e6ca3744cdd9d4a8b03';
const SALT_TEXT = 'orbital-meta-import-v1';

/** The server's own check, copied verbatim from `importService.js`. */
const IMPORT_KEY_B64_RE = /^[A-Za-z0-9+/]{22}==$/;

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

/** A frame, or a loud failure — a `null` here is a broken fixture, not a case. */
function frameOf(input: Parameters<typeof buildSourceItemId>[0]): Uint8Array {
  const frame = buildSourceItemId(input);
  if (frame === null) throw new Error('buildSourceItemId returned null for a KAT fixture');
  return frame;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHkdfArgs.length = 0;
  mockHmacArgs.length = 0;
  mockGetState.mockReturnValue({ userId: USER_ID });
  mockGetOrFetchGroupKey.mockResolvedValue(GROUP_KEY);
  mockCompareGroupKeyPin.mockReturnValue('match');
});

// ---------------------------------------------------------------------------
// KAT 1 — the end-to-end derivation, against `orbital_import_kat`
// ---------------------------------------------------------------------------

describe('KAT 1 — orbital_import_kat', () => {
  // The `source_item_id` of the Rust fixture, which predates #925's framing and
  // is a plain UTF-8 string: this layer treats the bytes as opaque, so a vector
  // that is not a v1 frame is a legitimate — and useful — fixture.
  const SOURCE_ITEM_ID = utf8('pfbid0Qx7m9Lz2\u{1F469}‍\u{1F469}‍\u{1F467}‍\u{1F466}-post');

  it('derives K_import from (group key, salt, lowercase userId) and the 16-byte import_key from it', async () => {
    const session = await openImportKeySession({ groupId: 'g-1', source: 'facebook' });
    const importKey = await session.deriveImportKey(SOURCE_ITEM_ID);

    // Step 1, as the FFI saw it.
    expect(signal.hkdfSha256).toHaveBeenCalledTimes(1);
    expect(mockHkdfArgs[0].ikm).toBe(hex(GROUP_KEY));
    expect(Buffer.from(mockHkdfArgs[0].salt, 'hex').toString('utf8')).toBe(SALT_TEXT);
    expect(Buffer.from(mockHkdfArgs[0].info, 'hex').toString('utf8')).toBe(USER_ID);
    expect(mockHkdfArgs[0].outputLen).toBe(32);

    // ...and the ikm buffer the FFI lifted from is wiped the moment the call
    // returns. The pin itself is NOT: it has to outlive this to be compared
    // against per batch.
    const [liveIkm] = signal.hkdfSha256.mock.calls[0];
    expect(hex(new Uint8Array(liveIkm))).toBe('00'.repeat(32));
    expect(hex(GROUP_KEY)).toBe('42'.repeat(32));

    // Step 2: the framed HMAC input begins with `facebook` then a single NUL.
    // The fingerprint HMAC runs first, so the derivation is the second call.
    expect(mockHmacArgs[1].key).toBe(K_IMPORT_HEX);
    expect(mockHmacArgs[1].input).toMatch(/^66616365626f6f6b00/);
    expect(mockHmacArgs[1].input).toBe(`66616365626f6f6b00${hex(SOURCE_ITEM_ID)}`);

    expect(hex(importKey)).toBe('e947a36857b1a2590992e60b20852f68');
    session.close();
  });

  it('encodes the wire form the server accepts', async () => {
    const session = await openImportKeySession({ groupId: 'g-1', source: 'facebook' });
    const wire = importKeyToWire(await session.deriveImportKey(SOURCE_ITEM_ID));

    expect(wire).toBe('6UejaFexolkJkuYLIIUvaA==');
    // Standard padded base64, NOT base64url: `+` and `/`, and the two `=`.
    expect(wire).toMatch(IMPORT_KEY_B64_RE);
    session.close();
  });

  it('lowercases an uppercase userId rather than rejecting it', async () => {
    mockGetState.mockReturnValue({ userId: USER_ID.toUpperCase() });

    const session = await openImportKeySession({ groupId: 'g-1', source: 'facebook' });
    const importKey = await session.deriveImportKey(SOURCE_ITEM_ID);

    expect(Buffer.from(mockHkdfArgs[0].info, 'hex').toString('utf8')).toBe(USER_ID);
    expect(hex(importKey)).toBe('e947a36857b1a2590992e60b20852f68');
    session.close();
  });
});

// ---------------------------------------------------------------------------
// KAT 2 / 3 — the cross-layer vectors, over REAL #925 frames
// ---------------------------------------------------------------------------

/**
 * kind 0x01, Facebook. Non-Latin-1 (Cyrillic, CJK) and a non-BMP ZWJ family in
 * one text, a link url, and three basenames whose sorted order differs from
 * their file order — with a `.mp4` among them. A latin1-truncating encoder
 * (#373), a surrogate-splitting one, or a sort by UTF-16 code unit each
 * produce a different frame and fail on the hex, before the derivation.
 */
const V1_INPUT = {
  kind: 'content',
  timestampSeconds: 1700000000,
  text: 'Привет 日本語 \u{1F469}‍\u{1F469}‍\u{1F467}‍\u{1F466} family',
  linkUrl: 'https://example.org/post/42',
  mediaUris: [
    'your_facebook_activity/posts/media/clip.mp4',
    'posts/media/b.jpg',
    'your_facebook_activity/posts/media/a.jpg',
  ],
} as const;

const V1_FRAME_HEX =
  '0101000000006553f10000000037d09fd180d0b8d0b2d0b5d18220e697a5e69cace8aa9e2' +
  '0f09f91a9e2808df09f91a9e2808df09f91a7e2808df09f91a62066616d696c790000001b' +
  '68747470733a2f2f6578616d706c652e6f72672f706f73742f34320000000300000005612' +
  'e6a706700000005622e6a706700000008636c69702e6d7034';

const V2_FBID = '17998877665544332';
const V2_FRAME_HEX = '0102000000113137393938383737363635353434333332';

describe('KAT 2 — a real kind-0x01 frame, Facebook', () => {
  it('frames and derives exactly what the Rust fixture pins', async () => {
    const frame = frameOf(V1_INPUT);
    // The cross-layer assertion: #925's framing, from #924's side.
    expect(hex(frame)).toBe(V1_FRAME_HEX);

    const session = await openImportKeySession({ groupId: 'g-1', source: 'facebook' });
    const importKey = await session.deriveImportKey(frame);

    expect(mockHmacArgs[1].input).toBe(`66616365626f6f6b00${V1_FRAME_HEX}`);
    expect(hex(importKey)).toBe('fabbcb1b141109c7f897c9301aaca8b2');
    expect(importKeyToWire(importKey)).toBe('+rvLGxQRCcf4l8kwGqyosg==');
    expect(importKeyToWire(importKey)).toMatch(IMPORT_KEY_B64_RE);
    session.close();
  });

  it('frames the non-Latin-1 and emoji text as UTF-8, not as code units', () => {
    const frame = frameOf(V1_INPUT);
    const frameHex = hex(frame);

    // Cyrillic П (d09f), CJK 日 (e697a5), and the ZWJ (e2808d) joining the
    // four non-BMP family members.
    expect(frameHex).toContain('d09fd180d0b8d0b2d0b5d182');
    expect(frameHex).toContain('e697a5e69cace8aa9e');
    expect(frameHex).toContain('f09f91a9e2808df09f91a9e2808df09f91a7e2808df09f91a6');
  });
});

describe('KAT 3 — a real kind-0x02 fbid frame, Instagram', () => {
  it('frames and derives exactly what the Rust fixture pins', async () => {
    const frame = frameOf({ kind: 'platform', platformId: V2_FBID });
    expect(hex(frame)).toBe(V2_FRAME_HEX);

    const session = await openImportKeySession({ groupId: 'g-1', source: 'instagram' });
    const importKey = await session.deriveImportKey(frame);

    // `instagram`, then the single NUL. The only fixture that pins the other
    // source literal's prefix.
    expect(mockHmacArgs[1].input).toBe(`696e7374616772616d00${V2_FRAME_HEX}`);
    expect(hex(importKey)).toBe('c724c3c1313aea4ed39332c46084fefa');
    expect(importKeyToWire(importKey)).toBe('xyTDwTE66k7TkzLEYIT++g==');
    session.close();
  });

  it('derives a different key for the same frame under the other source', async () => {
    const frame = frameOf({ kind: 'platform', platformId: V2_FBID });

    const instagram = await openImportKeySession({ groupId: 'g-1', source: 'instagram' });
    const asInstagram = hex(await instagram.deriveImportKey(frame));
    instagram.close();

    const facebook = await openImportKeySession({ groupId: 'g-1', source: 'facebook' });
    const asFacebook = hex(await facebook.deriveImportKey(frame));
    facebook.close();

    expect(asFacebook).not.toBe(asInstagram);
  });
});

// ---------------------------------------------------------------------------
// Identity properties
// ---------------------------------------------------------------------------

describe('derivation identity properties', () => {
  it('treats a post with a video as a different post from the same post without it', async () => {
    const withVideo = frameOf(V1_INPUT);
    const withoutVideo = frameOf({
      ...V1_INPUT,
      mediaUris: V1_INPUT.mediaUris.filter((uri) => !uri.endsWith('.mp4')),
    });

    const session = await openImportKeySession({ groupId: 'g-1', source: 'facebook' });
    const a = hex(await session.deriveImportKey(withVideo));
    const b = hex(await session.deriveImportKey(withoutVideo));
    session.close();

    // Video items are framed even though #925 holds them: a post whose only
    // difference is an attached video is a different post, and its identity
    // must not shift if video support lands later.
    expect(a).not.toBe(b);
  });

  it('is deterministic across sessions — a resumed run re-derives the same key', async () => {
    const frame = frameOf(V1_INPUT);

    const first = await openImportKeySession({ groupId: 'g-1', source: 'facebook' });
    const a = hex(await first.deriveImportKey(frame));
    const fingerprint = first.keyFingerprint;
    first.close();

    const second = await openImportKeySession({ groupId: 'g-1', source: 'facebook' });
    const b = hex(await second.deriveImportKey(frame));

    expect(b).toBe(a);
    expect(second.keyFingerprint).toBe(fingerprint);
    second.close();
  });
});
