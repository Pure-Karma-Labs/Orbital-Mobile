/// <reference types="node" />

/**
 * Hostile-input JSON handling for the Meta import (#925).
 *
 * Three things are pinned here:
 *
 *  1. **Cap parity with Rust.** `MAX_JSON_BYTES` is read out of `limits.rs`
 *     rather than copied into a snapshot, because the Rust constant IS the
 *     contract — and because lowering it would flip Instagram posts from the
 *     `fbid` identity scheme to the content-derived one and duplicate a
 *     member's history on re-import (`sourceItemId.ts`).
 *  2. **The depth scan is iterative and string-aware.** A recursive scanner
 *     would blow the stack on the very input it exists to refuse; a naive
 *     bracket count would be defeated by brackets inside strings.
 *  3. **The pruning reviver actually prunes**, including the subtrees that
 *     carry GPS — exercised end to end against a synthetic archive opened
 *     through the real policy layer.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  MAX_JSON_BYTES,
  MAX_JSON_DEPTH,
  parseJsonSafely,
  pickArray,
  pickField,
  pickInteger,
  pickObject,
  pickString,
  pruningReviver,
  scanJsonDepth,
} from '../jsonSafety';
import { fbArchive } from '../testUtils/builders';

const LIMITS_RS = path.join(
  __dirname,
  '../../../../packages/orbital-archive-reader/rust/orbital_archive_reader/src/limits.rs',
);

/** `n` nested arrays around `"x"`. Depth here means bracket depth. */
function nest(depth: number): string {
  return `${'['.repeat(depth)}"x"${']'.repeat(depth)}`;
}

describe('MAX_JSON_BYTES parity with the Rust limits table', () => {
  let rust: string;

  beforeAll(() => {
    expect(fs.existsSync(LIMITS_RS)).toBe(true);
    rust = fs.readFileSync(LIMITS_RS, 'utf-8');
  });

  it('equals limits.rs MAX_JSON_BYTES', () => {
    const match = /pub const MAX_JSON_BYTES: u64 = (\d+) \* MIB;/.exec(rust);
    expect(match).not.toBeNull();
    expect(MAX_JSON_BYTES).toBe(Number((match as RegExpExecArray)[1]) * 1024 * 1024);
  });

  it('equals the Json row of the Rust KIND_CAPS table', () => {
    // The two Rust constants are documented as equal; if they ever diverge,
    // the parser must track the one that bounds `read_json`.
    const match = /\(EntryKind::Json, (\d+) \* MIB\)/.exec(rust);
    expect(match).not.toBeNull();
    expect(MAX_JSON_BYTES).toBe(Number((match as RegExpExecArray)[1]) * 1024 * 1024);
  });

  it('is 12 MiB', () => {
    expect(MAX_JSON_BYTES).toBe(12 * 1024 * 1024);
  });
});

describe('scanJsonDepth', () => {
  it('accepts exactly MAX_JSON_DEPTH', () => {
    expect(scanJsonDepth(nest(MAX_JSON_DEPTH))).toBe(true);
  });

  it('refuses MAX_JSON_DEPTH + 1', () => {
    expect(scanJsonDepth(nest(MAX_JSON_DEPTH + 1))).toBe(false);
  });

  it('counts objects and arrays alike', () => {
    expect(scanJsonDepth('{"a":{"b":{"c":1}}}', 3)).toBe(true);
    expect(scanJsonDepth('{"a":{"b":{"c":1}}}', 2)).toBe(false);
  });

  it('tracks SIBLING depth, not cumulative brackets', () => {
    // Ten siblings at depth 2 are depth 2, not depth 20.
    const siblings = `[${'[1],'.repeat(9)}[1]]`;
    expect(scanJsonDepth(siblings, 2)).toBe(true);
  });

  it('ignores brackets inside strings', () => {
    expect(scanJsonDepth('{"post":"[[[[[[[[[[["}', 2)).toBe(true);
    expect(scanJsonDepth('{"post":"{{{{{{{{{{{"}', 2)).toBe(true);
  });

  it('honours escaped quotes', () => {
    // The `\"` must NOT close the string, or everything after it would be
    // scanned as structure.
    expect(scanJsonDepth('{"post":"he said \\"[[[[\\" loudly"}', 2)).toBe(true);
  });

  it('honours an escaped backslash before a quote', () => {
    // `"a\\"` DOES close: the backslash is escaped, the quote is not.
    expect(scanJsonDepth('{"a":"x\\\\","b":[[[1]]]}', 2)).toBe(false);
    expect(scanJsonDepth('{"a":"x\\\\","b":[[[1]]]}', 4)).toBe(true);
  });

  it('clamps at zero rather than going negative', () => {
    // Otherwise `}}}}` would buy credit for real nesting that follows.
    expect(scanJsonDepth(`]]]]${nest(4)}`, 4)).toBe(true);
    expect(scanJsonDepth(`]]]]${nest(5)}`, 4)).toBe(false);
  });

  it('is iterative: 100,000 levels neither recurses nor throws', () => {
    const deep = nest(100_000);
    expect(() => scanJsonDepth(deep)).not.toThrow();
    expect(scanJsonDepth(deep)).toBe(false);
  });

  it('says nothing about validity', () => {
    // Not a validator: `JSON.parse` owns that verdict.
    expect(scanJsonDepth('not json at all')).toBe(true);
    expect(scanJsonDepth('[{')).toBe(true);
  });
});

describe('pruningReviver', () => {
  const parse = (text: string): unknown => JSON.parse(text, pruningReviver) as unknown;

  it.each([
    'media_metadata',
    'exif_data',
    'camera_metadata',
    'tags',
    'place',
    'coordinate',
    'dubbing_info',
    'media_variants',
    'cross_post_source',
    'ai_stickers',
  ])('drops %s', (key) => {
    const parsed = parse(`{"keep":1,"${key}":{"latitude":1}}`) as Record<string, unknown>;
    expect(parsed.keep).toBe(1);
    expect(key in parsed).toBe(false);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('drops %s', (key) => {
    const parsed = parse(`{"keep":1,"${key}":{"polluted":true}}`) as Record<string, unknown>;
    expect(parsed.keep).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(parsed, key)).toBe(false);
  });

  it('does not pollute Object.prototype', () => {
    parse('{"__proto__":{"polluted":true}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('prunes at every depth, not only the top level', () => {
    const parsed = parse('{"a":{"b":{"exif_data":[1,2],"uri":"x"}}}') as {
      a: { b: Record<string, unknown> };
    };
    expect(parsed.a.b.uri).toBe('x');
    expect('exif_data' in parsed.a.b).toBe(false);
  });

  it('leaves arrays hole-free', () => {
    // The denylist holds property NAMES; an array element's key is its index,
    // so an element can never be pruned and an array can never gain a hole.
    const parsed = parse('{"media":[{"uri":"a","exif_data":[1]},{"uri":"b"}]}') as {
      media: { uri: string }[];
    };
    expect(parsed.media).toHaveLength(2);
    expect(parsed.media.map((m) => m.uri)).toEqual(['a', 'b']);
    expect(Object.keys(parsed.media)).toEqual(['0', '1']);
  });

  it('keeps every field a parser actually reads', () => {
    const parsed = parse(
      '{"timestamp":1,"title":"t","data":[{"post":"p"}],"attachments":[{"data":[{"media":{"uri":"u","creation_timestamp":2}}]}]}',
    ) as Record<string, unknown>;
    expect(parsed.timestamp).toBe(1);
    expect(parsed.data).toEqual([{ post: 'p' }]);
    expect(parsed.attachments).toEqual([
      { data: [{ media: { uri: 'u', creation_timestamp: 2 } }] },
    ]);
  });
});

describe('parseJsonSafely', () => {
  it('parses a well-formed document', () => {
    const outcome = parseJsonSafely('[{"timestamp":1}]');
    expect(outcome).toEqual({ ok: true, value: [{ timestamp: 1 }] });
  });

  it('prunes while parsing', () => {
    const outcome = parseJsonSafely('{"uri":"x","exif_data":[{"latitude":1}]}');
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value).toEqual({ uri: 'x' });
  });

  it('refuses over-deep input before parsing', () => {
    expect(parseJsonSafely(nest(MAX_JSON_DEPTH + 1))).toEqual({
      ok: false,
      reason: 'json_too_deep',
    });
  });

  it.each([
    ['empty input', ''],
    ['prose', 'not json'],
    ['a truncated document', '[{"a":1'],
    ['a trailing comma', '[1,2,]'],
    ['a single quote', "{'a':1}"],
    ['an unterminated string', '{"a":"b'],
  ])('reports %s as json_unparseable', (_label, text) => {
    expect(parseJsonSafely(text)).toEqual({ ok: false, reason: 'json_unparseable' });
  });

  it.each([
    [
      'a RangeError',
      (): never => {
        throw new RangeError('Maximum call stack size exceeded');
      },
    ],
    [
      'a bare string',
      (): never => {
        throw 'nope';
      },
    ],
    [
      'a null',
      (): never => {
        throw null;
      },
    ],
  ])('catches %s thrown by the engine', (_label, thrower) => {
    // The catch is deliberately untyped. Hermes has its OWN nesting limit
    // (510, above our 32) which surfaces as a `RangeError`, an out-of-memory
    // may surface as something else, and V8's parser is iterative so the real
    // engine limit cannot be reached from Node at all — hence the stub. What
    // matters is that NOTHING escapes into the middle of an import run.
    const spy = jest.spyOn(JSON, 'parse').mockImplementation(thrower);
    try {
      expect(parseJsonSafely('[1]')).toEqual({ ok: false, reason: 'json_unparseable' });
    } finally {
      spy.mockRestore();
    }
  });

  it('never throws, whatever it is handed', () => {
    for (const text of ['', '\u0000', '[', '{"a":', nest(60), '\\', '"\\u"']) {
      expect(() => parseJsonSafely(text)).not.toThrow();
    }
  });
});

describe('schema pick helpers', () => {
  it('pickObject accepts only plain objects', () => {
    expect(pickObject({ a: 1 })).toEqual({ a: 1 });
    expect(pickObject([])).toBeNull();
    expect(pickObject(null)).toBeNull();
    expect(pickObject('x')).toBeNull();
    expect(pickObject(undefined)).toBeNull();
  });

  it('pickArray accepts only arrays', () => {
    expect(pickArray([1])).toEqual([1]);
    expect(pickArray({})).toBeNull();
    expect(pickArray('x')).toBeNull();
  });

  it('pickString accepts only strings', () => {
    expect(pickString('')).toBe('');
    expect(pickString(1)).toBeNull();
    expect(pickString(null)).toBeNull();
  });

  it('pickInteger accepts only finite integers', () => {
    expect(pickInteger(0)).toBe(0);
    expect(pickInteger(-1)).toBe(-1);
    expect(pickInteger(1.5)).toBeNull();
    expect(pickInteger(NaN)).toBeNull();
    expect(pickInteger(Infinity)).toBeNull();
    expect(pickInteger('12')).toBeNull();
  });

  it('pickField reads own properties only', () => {
    expect(pickField({ a: 1 }, 'a')).toBe(1);
    expect(pickField({ a: 1 }, 'b')).toBeUndefined();
    // An inherited member must never answer a schema question: the file did
    // not contain it.
    expect(pickField({}, 'toString')).toBeUndefined();
    expect(pickField({}, 'constructor')).toBeUndefined();
    expect(pickField([1], '0')).toBeUndefined();
    expect(pickField(null, 'a')).toBeUndefined();
  });
});

describe('end to end over a synthetic archive', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads a built Facebook file through the real policy layer and prunes it', async () => {
    const archive = fbArchive({
      posts: [
        {
          timestamp: 1_600_000_000,
          title: 'Alex added a photo.',
          tags: ['Someone Else'],
          post: 'Beach day',
          media: [{ name: 'a.jpg', creationTimestamp: 1_600_000_000, withMetadata: true }],
        },
      ],
    });
    const session = await archive.open();
    const json = await session.readEntryJson(archive.entryIdFor('.json'));
    expect(json.ok).toBe(true);
    if (!json.ok) return;

    // The raw text carries the heavy subtrees the real export carries...
    expect(json.text).toContain('exif_data');
    expect(json.text).toContain('latitude');

    const outcome = parseJsonSafely(json.text);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // ...and nothing survives revive except what a parser reads.
    const posts = pickArray(outcome.value);
    expect(posts).toHaveLength(1);
    const post = posts?.[0];
    expect(pickInteger(pickField(post, 'timestamp'))).toBe(1_600_000_000);
    expect(pickField(post, 'tags')).toBeUndefined();

    const media = pickField(
      pickArray(pickField(pickArray(pickField(post, 'attachments'))?.[0], 'data'))?.[0],
      'media',
    );
    expect(pickString(pickField(media, 'uri'))).toBe('your_facebook_activity/posts/media/a.jpg');
    expect(pickField(media, 'media_metadata')).toBeUndefined();
    expect(pickField(media, 'media_variants')).toBeUndefined();
    expect(pickField(media, 'ai_stickers')).toBeUndefined();
    expect(pickField(media, 'cross_post_source')).toBeUndefined();
    expect(JSON.stringify(outcome.value)).not.toContain('latitude');
  });
});
