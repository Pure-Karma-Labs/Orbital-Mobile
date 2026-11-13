/*
The golden vectors below were minted by this independent Python reference, not by
running the TypeScript and recording what it produced. It was written from the v1
byte layout alone, so agreement between it and `buildSourceItemId` is evidence that
both match the documented frame rather than evidence that one copied the other.

Note also that Python's `str.encode('utf-8')` raises `UnicodeEncodeError` on a lone
surrogate — the exact refusal `encodeUtf8Strict` expresses as `null`, which is why
the surrogate cases below have no vector and assert `null` instead.

VERSION, KIND_CONTENT, KIND_PLATFORM = 0x01, 0x01, 0x02

def basename(uri):
    return uri.rsplit("/", 1)[-1] if "/" in uri else uri

def content_id(timestamp_seconds, text, link_url, media_uris):
    names = sorted((basename(u) for u in media_uris), key=lambda n: n.encode("utf-8"))
    out = bytearray([VERSION, KIND_CONTENT])
    out += struct.pack(">q", timestamp_seconds)
    tb = text.encode("utf-8");  out += struct.pack(">I", len(tb)) + tb
    ub = b"" if link_url is None else link_url.encode("utf-8")
    out += struct.pack(">I", len(ub)) + ub
    out += struct.pack(">I", len(names))
    for name in names:
        nb = name.encode("utf-8");  out += struct.pack(">I", len(nb)) + nb
    return bytes(out)

def platform_id(fbid):
    b = fbid.encode("utf-8")
    return bytes(bytearray([VERSION, KIND_PLATFORM]) + struct.pack(">I", len(b)) + b)
*/

import {
  SOURCE_ITEM_ID_KIND_CONTENT,
  SOURCE_ITEM_ID_KIND_PLATFORM,
  SOURCE_ITEM_ID_VERSION,
  basenameOfUri,
  buildSourceItemId,
  sortBasenamesUtf8,
  type SourceItemIdInput,
} from '../sourceItemId';
import { repairMojibake } from '../mojibake';
import { mojibakeEscape } from '../testUtils/builders';
import { encodeUtf8Strict } from '../../../utils/utf8';

/**
 * Local on purpose: a shared hex helper from app code could drift (padding,
 * case) and drag every vector with it. These vectors are a contract, so the
 * rendering of them is spelled out here.
 */
function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** A `null` frame is a test failure, not a hex string — fail loudly. */
function frameHex(input: SourceItemIdInput): string {
  const frame = buildSourceItemId(input);
  if (frame === null) throw new Error('buildSourceItemId returned null for a well-formed input');
  return hex(frame);
}

/** The long-form media prefix of a Facebook export; `posts/media/` is the other. */
const FB = 'your_facebook_activity/posts/media/';

const HEX_BEACH_WITH_VIDEO =
  '0101000000005f5e10000000001f42656163682064617920f09f8f96efb88f207769746820746865206b696473000000000000000300000005612e6a706700000005622e6a706700000005632e6d7034';
const HEX_BEACH_PHOTOS_ONLY =
  '0101000000005f5e10000000001f42656163682064617920f09f8f96efb88f207769746820746865206b696473000000000000000200000005612e6a706700000005622e6a7067';
const HEX_CAFE_EMOJI = '0101000000005f5e100100000009436166c3a920e298950000000000000000';
const HEX_CAFE_PRECOMPOSED = '0101000000005f5e100200000005436166c3a90000000000000000';
const HEX_CAFE_DECOMPOSED = '0101000000005f5e10020000000643616665cc810000000000000000';
const HEX_LINK_ONLY_A =
  '0101000000005f5e1005000000000000001568747470733a2f2f6578616d706c652e6f72672f6100000000';
const HEX_LINK_ONLY_B =
  '0101000000005f5e1005000000000000001568747470733a2f2f6578616d706c652e6f72672f6200000000';

interface Vector {
  readonly label: string;
  readonly input: SourceItemIdInput;
  readonly expected: string;
}

const VECTORS: Vector[] = [
  {
    label: 'astral emoji, mixed media, unsorted uris',
    input: {
      kind: 'content',
      timestampSeconds: 1600000000,
      // U+1F3D6 plus the U+FE0F variation selector: the selector is part of the
      // member's text and must be framed, not stripped.
      text: 'Beach day \u{1F3D6}️ with the kids',
      linkUrl: null,
      mediaUris: [`${FB}b.jpg`, `${FB}a.jpg`, 'posts/media/c.mp4'],
    },
    expected: HEX_BEACH_WITH_VIDEO,
  },
  {
    label: 'same post without the video',
    input: {
      kind: 'content',
      timestampSeconds: 1600000000,
      text: 'Beach day \u{1F3D6}️ with the kids',
      linkUrl: null,
      mediaUris: [`${FB}b.jpg`, `${FB}a.jpg`],
    },
    expected: HEX_BEACH_PHOTOS_ONLY,
  },
  {
    label: 'mojibake-repaired text equals typed text',
    input: {
      kind: 'content',
      timestampSeconds: 1600000001,
      text: 'Café ☕',
      linkUrl: null,
      mediaUris: [],
    },
    expected: HEX_CAFE_EMOJI,
  },
  {
    label: 'precomposed e-acute',
    input: {
      kind: 'content',
      timestampSeconds: 1600000002,
      text: 'Café',
      linkUrl: null,
      mediaUris: [],
    },
    expected: HEX_CAFE_PRECOMPOSED,
  },
  {
    label: 'decomposed e-acute (MUST differ)',
    input: {
      kind: 'content',
      timestampSeconds: 1600000002,
      text: 'Café',
      linkUrl: null,
      mediaUris: [],
    },
    expected: HEX_CAFE_DECOMPOSED,
  },
  {
    label: 'duplicate basenames kept, sort stable',
    input: {
      kind: 'content',
      timestampSeconds: 1600000003,
      text: 'album',
      linkUrl: null,
      mediaUris: ['x/a.jpg', 'y/a.jpg', 'z/b.jpg'],
    },
    expected:
      '0101000000005f5e100300000005616c62756d000000000000000300000005612e6a706700000005612e6a706700000005622e6a7067',
  },
  {
    label: 'UTF-8 byte order, not UTF-16 order',
    input: {
      kind: 'content',
      timestampSeconds: 1600000004,
      text: '',
      linkUrl: null,
      // U+FFFD (EF BF BD) sorts BEFORE U+10000 (F0 90 80 80) in UTF-8 bytes and
      // after it in UTF-16 units — the vector pins the byte order.
      mediaUris: ['\u{10000}.jpg', '�.jpg'],
    },
    expected:
      '0101000000005f5e100400000000000000000000000200000007efbfbd2e6a706700000008f09080802e6a7067',
  },
  {
    label: 'link-only post, url a',
    input: {
      kind: 'content',
      timestampSeconds: 1600000005,
      text: '',
      linkUrl: 'https://example.org/a',
      mediaUris: [],
    },
    expected: HEX_LINK_ONLY_A,
  },
  {
    label: 'link-only post, url b',
    input: {
      kind: 'content',
      timestampSeconds: 1600000005,
      text: '',
      linkUrl: 'https://example.org/b',
      mediaUris: [],
    },
    expected: HEX_LINK_ONLY_B,
  },
  {
    label: 'text plus link',
    input: {
      kind: 'content',
      timestampSeconds: 1600000006,
      text: 'Read this',
      linkUrl: 'https://example.org/a',
      mediaUris: [],
    },
    expected:
      '0101000000005f5e1006000000095265616420746869730000001568747470733a2f2f6578616d706c652e6f72672f6100000000',
  },
  {
    label: 'empty degenerate post',
    input: {
      kind: 'content',
      timestampSeconds: 0,
      text: '',
      linkUrl: null,
      mediaUris: [],
    },
    expected: '01010000000000000000000000000000000000000000',
  },
  {
    label: 'negative timestamp (pre-1970)',
    input: {
      kind: 'content',
      timestampSeconds: -86400,
      text: 'old',
      linkUrl: null,
      mediaUris: [],
    },
    expected: '0101fffffffffffeae80000000036f6c640000000000000000',
  },
  {
    label: 'instagram fbid, kind 0x02',
    input: { kind: 'platform', platformId: '17912345678901234' },
    expected: '0102000000113137393132333435363738393031323334',
  },
];

describe('buildSourceItemId golden vectors', () => {
  it.each(VECTORS)('$label', ({ input, expected }) => {
    expect(frameHex(input)).toBe(expected);
  });
});

describe('buildSourceItemId identity behaviour', () => {
  it('treats a post with a video as a different post from the same post without it', () => {
    // Video items are framed even though #925 holds them: a post whose only
    // difference is an attached video is a different post, and its identity
    // must not change if video support lands later.
    expect(HEX_BEACH_WITH_VIDEO).not.toBe(HEX_BEACH_PHOTOS_ONLY);
  });

  it('frames mojibake-repaired text identically to the text the member typed', () => {
    // The whole point of the repair: an export that byte-escaped `é` and one
    // that did not must dedup against each other.
    expect(
      frameHex({
        kind: 'content',
        timestampSeconds: 1600000001,
        text: repairMojibake(mojibakeEscape('Café ☕')),
        linkUrl: null,
        mediaUris: [],
      }),
    ).toBe(HEX_CAFE_EMOJI);
  });

  it('frames precomposed and decomposed text differently (deliberate pre-NFC choice)', () => {
    // NOT a defect. The id is taken PRE-NFC because the archive's bytes are
    // deterministic while Hermes's platform-backed normalisation tables are
    // not — normalising here would let the same post frame differently on two
    // OS versions. NFC applies to the stored body only.
    expect(HEX_CAFE_PRECOMPOSED).not.toBe(HEX_CAFE_DECOMPOSED);
  });

  it('frames two link-only posts with different urls differently', () => {
    // A link-only post has no text to tell it apart; the url has to carry the
    // whole identity.
    expect(HEX_LINK_ONLY_A).not.toBe(HEX_LINK_ONLY_B);
  });

  it('returns null for every string position that holds a lone surrogate', () => {
    // `null` is the caller's `malformed_post`. TextEncoder would substitute
    // U+FFFD here, which is lossy and would let two different posts share an id.
    expect(
      buildSourceItemId({
        kind: 'content',
        timestampSeconds: 1600000000,
        text: 'bad \uD800 end',
        linkUrl: null,
        mediaUris: [],
      }),
    ).toBeNull();
    expect(
      buildSourceItemId({
        kind: 'content',
        timestampSeconds: 1600000000,
        text: '',
        linkUrl: 'https://example.org/\uD800',
        mediaUris: [],
      }),
    ).toBeNull();
    expect(
      buildSourceItemId({
        kind: 'content',
        timestampSeconds: 1600000000,
        text: '',
        linkUrl: null,
        mediaUris: ['posts/media/\uDC00.jpg'],
      }),
    ).toBeNull();
    expect(buildSourceItemId({ kind: 'platform', platformId: '\uDC00' })).toBeNull();
  });

  it('returns null for a timestamp that is not a safe integer', () => {
    // The framing's own floor below the caller's `missing_timestamp` check:
    // `setBigInt64` would throw or round, and a rounded timestamp is a silently
    // wrong identity.
    for (const timestampSeconds of [1.5, Number.MAX_SAFE_INTEGER + 2, NaN]) {
      expect(
        buildSourceItemId({
          kind: 'content',
          timestampSeconds,
          text: 'x',
          linkUrl: null,
          mediaUris: [],
        }),
      ).toBeNull();
    }
  });
});

describe('encodeUtf8Strict', () => {
  it('refuses non-strings instead of encoding their toString', () => {
    // Every string here comes out of `JSON.parse` on an attacker-supplied file,
    // so "it is a string" is a runtime fact. TextEncoder would happily encode
    // the nine bytes of "undefined".
    expect(encodeUtf8Strict(undefined)).toBeNull();
    expect(encodeUtf8Strict(null)).toBeNull();
    expect(encodeUtf8Strict(42)).toBeNull();
    expect(encodeUtf8Strict({})).toBeNull();
  });

  it('encodes the empty string to zero bytes rather than refusing it', () => {
    // An empty post text is ordinary; only `null` means malformed, so the
    // empty case must not be confused with the refusal.
    const bytes = encodeUtf8Strict('');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes?.length).toBe(0);
  });
});

describe('basenameOfUri', () => {
  it('takes everything after the last slash, because export prefixes differ', () => {
    // The same photo is `your_facebook_activity/posts/media/x.jpg` in one
    // export layout and `posts/media/x.jpg` in another.
    expect(basenameOfUri('a/b/c.jpg')).toBe('c.jpg');
    expect(basenameOfUri('c.jpg')).toBe('c.jpg');
    expect(basenameOfUri('a/')).toBe('');
    expect(basenameOfUri('')).toBe('');
  });
});

describe('sortBasenamesUtf8', () => {
  it('sorts by UTF-8 byte order, which is the opposite of the default sort here', () => {
    // `[...].sort()` compares UTF-16 units and would put the astral name first
    // (D800… < FFFD). Only the byte order is a property of the bytes rather
    // than of the engine, so the vectors pin it.
    const names = ['\u{10000}.jpg', '�.jpg'];
    expect(sortBasenamesUtf8(names)).toEqual(['�.jpg', '\u{10000}.jpg']);
    expect([...names].sort()).toEqual(['\u{10000}.jpg', '�.jpg']);
  });

  it('keeps duplicates, because two attachments of one photo are two media items', () => {
    expect(sortBasenamesUtf8(['a.jpg', 'a.jpg', 'b.jpg'])).toEqual(['a.jpg', 'a.jpg', 'b.jpg']);
  });

  it('returns null when a name is not strictly encodable', () => {
    expect(sortBasenamesUtf8(['ok.jpg', 'bad\uD800.jpg'])).toBeNull();
  });

  it('returns an empty list for a post with no media', () => {
    expect(sortBasenamesUtf8([])).toEqual([]);
  });
});

describe('frame header', () => {
  it('starts every frame with the exported version and kind constants', () => {
    // Pins the vectors to the constants: renaming or re-valuing either one can
    // no longer drift away from the golden bytes unnoticed.
    const content = buildSourceItemId({
      kind: 'content',
      timestampSeconds: 0,
      text: '',
      linkUrl: null,
      mediaUris: [],
    });
    const platform = buildSourceItemId({ kind: 'platform', platformId: '1' });
    if (content === null || platform === null) throw new Error('expected both frames to build');

    expect(content[0]).toBe(SOURCE_ITEM_ID_VERSION);
    expect(content[1]).toBe(SOURCE_ITEM_ID_KIND_CONTENT);
    expect(platform[0]).toBe(SOURCE_ITEM_ID_VERSION);
    expect(platform[1]).toBe(SOURCE_ITEM_ID_KIND_PLATFORM);
  });
});
