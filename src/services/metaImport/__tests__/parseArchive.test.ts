/**
 * `parseArchive.ts` — the whole Meta import, end to end (#925).
 *
 * ## The oracle is the real policy layer
 *
 * Every session in this suite is the jest manual mock's native-shaped session
 * opened through the PRODUCTION `openArchiveSession`, so the denied-root
 * tripwire, the F1 sniff table and `peekEntryKind`'s order contract (e) are
 * the things under test rather than a second fake's idea of them. The parsers,
 * the pre-pass and the layout planner are the real ones too: the only injected
 * seam is `deriveImportKey`, which belongs to #924 and is deterministic here.
 *
 * ## What an e2e test is for
 *
 * The parser suites own "which skip reason", the pre-pass suite owns "which
 * media decision". This suite owns the things only the orchestration can get
 * wrong: the ORDER of the files, the fbid index being built before any content
 * file, the fold's verdict actually reaching the emitted item, the run-wide
 * dedup, the caps, the abort, and the summary's arithmetic.
 *
 * The load-bearing assertion, repeated once per hold reason, is the NEGATIVE
 * one: a held post is never emitted with `outcome: 'import'`. That is #983's
 * hold obligation, and it is the one thing no unit test downstream can prove.
 */

import { ARCHIVE_ERROR_DISPOSITIONS, ArchiveReaderError } from '../archiveAccess';
import { MAX_JSON_BYTES, MAX_MEDIA_PER_POST, MAX_POSTS_PER_FILE } from '../jsonSafety';
import { MAX_POST_JSON_FILES } from '../layout';
import { MAX_MEDIA_URIS_PER_FILE } from '../mediaPrePass';
import { MAX_POSTS_PER_RUN, parseArchive } from '../parseArchive';
import {
  buildArchive,
  fbEntrySpecs,
  fbJsonPath,
  fbMediaUri,
  igFlatEntrySpecs,
  igLabelledEntrySpecs,
  mp4Head,
  unknownHead,
  type BuiltArchive,
  type EntrySpec,
  type FbPostSpec,
  type IgLabelledPostSpec,
} from '../testUtils/builders';

import type { ArchiveEntryKindOutcome, ArchiveImportSession } from '../archiveAccess';
import type { ParseOptions, ParseProgress, ParseSummary, ParsedItem, ParsedPost } from '../types';

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** 2020-09-13T12:26:40Z, comfortably inside the importable window. */
const TS = 1_600_000_000;

/** Pinned so the UTC-day bound never depends on the machine running this. */
const NOW_UTC_DAY = '2026-11-12';

/**
 * A deterministic stand-in for #924's `hmacSha256(K_import, …)[0..16]`.
 *
 * Four independent FNV-1a lanes over the framed bytes: 16 bytes wide like the
 * real one, stable across runs, and distinct for distinct input — which is all
 * the dedup set needs. It is deliberately NOT a real MAC: this suite must not
 * depend on #924 having landed, and a parser that reached for crypto would be
 * the bug.
 */
function fakeDeriveImportKey(sourceItemId: Uint8Array): Promise<Uint8Array> {
  const key = new Uint8Array(16);
  for (let lane = 0; lane < 4; lane++) {
    let hash = (0x811c9dc5 ^ Math.imul(lane, 0x9e3779b9)) >>> 0;
    for (const byte of sourceItemId) {
      hash = (hash ^ (byte + lane)) >>> 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    key.set([hash >>> 24, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff, hash & 0xff], lane * 4);
  }
  return Promise.resolve(key);
}

interface RunResult {
  readonly items: readonly ParsedItem[];
  readonly keys: readonly (Uint8Array | null)[];
  readonly progress: readonly ParseProgress[];
  readonly summary: ParseSummary;
  readonly session: ArchiveImportSession;
}

/**
 * Open a built archive through the real policy layer and parse it.
 *
 * `prepare` runs against the opened session before the parse, which is the
 * only way to produce the outcomes no synthetic ZIP can (an archive-wide
 * throw; a skip code `peekEntryKind` cannot currently return).
 */
async function run(
  built: BuiltArchive,
  options: Partial<ParseOptions> = {},
  prepare?: (session: ArchiveImportSession) => void,
): Promise<RunResult> {
  const session = await built.open();
  prepare?.(session);

  const items: ParsedItem[] = [];
  const keys: (Uint8Array | null)[] = [];
  const progress: ParseProgress[] = [];

  const summary = await parseArchive(session, {
    source: 'facebook',
    nowUtcDay: NOW_UTC_DAY,
    deriveImportKey: fakeDeriveImportKey,
    onItem: (item, importKey) => {
      items.push(item);
      keys.push(importKey);
      return Promise.resolve();
    },
    onProgress: (p) => progress.push(p),
    ...options,
  });

  return { items, keys, progress, summary, session };
}

/** The emitted items, narrowed to the importable ones. */
function imports(result: RunResult): ParsedPost[] {
  return result.items.filter((item): item is ParsedPost => item.outcome === 'import');
}

/** Every item's reason, `'import'` for the importable ones. */
function outcomes(result: RunResult): string[] {
  return result.items.map((item) => (item.outcome === 'import' ? 'import' : item.reason));
}

/**
 * Let every pending promise job run.
 *
 * A macrotask, not `await Promise.resolve()`: the parse's own awaits (the JSON
 * read, the peeks) are several microtask turns deep, and counting those turns
 * would make the back-pressure test a test of this file's arithmetic.
 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Every entry id that earned an import licence anywhere in the run.
 *
 * The hold rows assert against this rather than against one post's media: the
 * obligation is that the held entry is in NO emitted post's media, not merely
 * that it is absent from the post that named it.
 */
function importedEntryIds(result: RunResult): string[] {
  return imports(result).flatMap((post) => post.media.map((media) => media.entryId));
}

/** The basename #928 shows for a Facebook post file — i.e. what `sourceFile` is. */
function fbSourceFile(index: number): string {
  return `your_posts__check_ins__photos_and_videos_${index}.json`;
}

/**
 * One post under test, followed by a plain photo post, in a single file.
 *
 * Every hold row needs this shape. Without a companion that DOES import,
 * "no emitted media carries the held entry id" would pass on a run that
 * imported nothing at all, which proves nothing about the hold.
 */
function heldPlusCompanion(held: FbPostSpec): EntrySpec[] {
  return fbEntrySpecs({
    posts: [held, { timestamp: TS + 1, post: 'the companion', media: [{ name: 'companion.jpg' }] }],
  });
}

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe('facebook end to end', () => {
  it('imports, holds and skips one file’s posts, and adds them up', async () => {
    const built = buildArchive([
      ...fbEntrySpecs({
        posts: [
          {
            timestamp: TS,
            post: 'a photo post',
            media: [{ name: 'photo.jpg', creationTimestamp: TS - 60, withMetadata: true }],
          },
          { timestamp: TS + 10, post: 'words only' },
          {
            timestamp: TS + 20,
            post: 'a clip',
            media: [{ name: 'clip.mp4', head: mp4Head() }],
          },
          { timestamp: TS + 30 },
        ],
      }),
      // The OTHER platform's post file, listed but never read for a facebook
      // run: it is what `otherSourceDetected` reports.
      ...igFlatEntrySpecs({ posts: [{ media: [{ name: 'ig.jpg', creationTimestamp: TS }] }] }),
    ]);

    const result = await run(built);

    expect(outcomes(result)).toEqual(['import', 'import', 'held_video', 'empty_post']);
    const [photoPost, textPost] = imports(result);
    expect(photoPost).toMatchObject({
      outcome: 'import',
      source: 'facebook',
      sourceFile: 'your_posts__check_ins__photos_and_videos_1.json',
      sourceIndex: 0,
      originalDate: TS * 1000,
      body: 'a photo post',
    });
    expect(photoPost.media).toEqual([
      { entryId: built.entryIdFor('photo.jpg'), originalDate: (TS - 60) * 1000 },
    ]);
    expect(textPost.media).toEqual([]);

    // Every emitted item carries the 16-byte key #921 persists.
    expect(result.keys.every((key) => key !== null && key.length === 16)).toBe(true);

    expect(result.summary).toMatchObject({
      importable: 2,
      importableMedia: 1,
      earliestDate: TS * 1000,
      latestDate: (TS + 10) * 1000,
      // Three, not four: `idScheme` counts the posts that got as far as
      // having an identity scheme. The empty post is a content-level refusal
      // the parser settled before any id was minted.
      idScheme: { fbid: 0, content: 3 },
      otherSourceDetected: true,
      locationDataRemoved: true,
      fileIssues: [],
    });
    expect(result.summary.skipped).toMatchObject({
      held_video: 1,
      empty_post: 1,
      media_missing: 0,
    });
  });
});

describe('instagram end to end', () => {
  it('builds the fbid index from posts.json before reading a content file', async () => {
    const built = buildArchive([
      ...igLabelledEntrySpecs({
        posts: [
          {
            fbid: '17900000000000001',
            coverMedia: [{ name: 'cover.jpg' }],
            childMedia: [{ name: 'child.jpg' }],
          },
        ],
      }),
      ...igFlatEntrySpecs({
        posts: [
          {
            creationTimestamp: TS,
            title: 'a carousel',
            media: [
              { name: 'cover.jpg', creationTimestamp: TS },
              { name: 'child.jpg', creationTimestamp: TS },
            ],
          },
          { media: [{ name: 'lone.jpg', creationTimestamp: TS + 5, title: 'alone' }] },
        ],
      }),
    ]);

    const result = await run(built, { source: 'instagram' });

    expect(outcomes(result)).toEqual(['import', 'import']);
    const [carousel, lone] = imports(result);
    // Stored order, kept as stored (Alex, 2026-11-12).
    expect(carousel.media.map((media) => media.entryId)).toEqual([
      built.entryIdFor('cover.jpg'),
      built.entryIdFor('child.jpg'),
    ]);
    expect(lone.body).toBe('alone');

    // The carousel's media is claimed by the labelled file, so it takes the
    // platform id; the lone post is in no label tree and falls back.
    expect(result.summary.idScheme).toEqual({ fbid: 1, content: 1 });
    expect(result.summary).toMatchObject({ importable: 2, importableMedia: 3, fileIssues: [] });

    // The labelled file was read FIRST, and exactly once.
    const readIds = built.mock.readJson.mock.calls.map(([entryId]) => entryId);
    expect(readIds).toEqual([
      built.entryIdFor('media/posts.json'),
      built.entryIdFor('posts_1.json'),
    ]);
  });
});

// ---------------------------------------------------------------------------
// The onItem contract
// ---------------------------------------------------------------------------

describe('the onItem contract', () => {
  it('awaits each item before parsing on, and abandons the run on a rejection', async () => {
    const built = buildArchive(
      fbEntrySpecs({
        posts: [
          { timestamp: TS, post: 'one' },
          { timestamp: TS + 1, post: 'two' },
          { timestamp: TS + 2, post: 'three' },
        ],
      }),
    );
    const session = await built.open();

    // Back-pressure: the second item's promise is held open, and nothing may
    // be emitted while it is pending.
    const seen: string[] = [];
    let releaseSecond: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const parse = parseArchive(session, {
      source: 'facebook',
      nowUtcDay: NOW_UTC_DAY,
      deriveImportKey: fakeDeriveImportKey,
      onItem: (item) => {
        seen.push(item.outcome === 'import' ? item.body : item.reason);
        return seen.length === 2 ? held : Promise.resolve();
      },
    });

    await flush();
    expect(seen).toEqual(['one', 'two']);
    releaseSecond?.();
    await expect(parse).resolves.toMatchObject({ importable: 3 });
    expect(seen).toEqual(['one', 'two', 'three']);
  });

  it('propagates an onItem rejection and returns no summary', async () => {
    const built = buildArchive(
      fbEntrySpecs({
        posts: [
          { timestamp: TS, post: 'one' },
          { timestamp: TS + 1, post: 'two' },
        ],
      }),
    );
    const session = await built.open();
    const seen: ParsedItem[] = [];

    await expect(
      parseArchive(session, {
        source: 'facebook',
        nowUtcDay: NOW_UTC_DAY,
        deriveImportKey: fakeDeriveImportKey,
        onItem: (item) => {
          seen.push(item);
          return seen.length === 1
            ? Promise.reject(new Error('persistence failed'))
            : Promise.resolve();
        },
      }),
    ).rejects.toThrow('persistence failed');

    // Abandoned where it stood: the second post was never parsed on to.
    expect(seen).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The hold obligation (#983)
// ---------------------------------------------------------------------------
//
// One row per hold reason, and every row asserts the NEGATIVE: the post is
// emitted as a skip with that reason, it is NEVER emitted with
// `outcome: 'import'`, and the entry its JSON named appears in no emitted
// post's media. This is the block the rest of the suite exists to support —
// a partially imported post is the one failure no downstream unit test can
// see, because by then the media list looks perfectly well-formed.

describe('the hold obligation', () => {
  it('holds a post whose media is a video', async () => {
    // A `.mp4` basename is enough: `inferKind` lists the entry as a video and
    // `peekEntryKind` answers from the listing without reading a byte
    // (contract (e)), which is the path a real export takes.
    const built = buildArchive(
      heldPlusCompanion({ timestamp: TS, post: 'a clip', media: [{ name: 'held.mp4' }] }),
    );

    const result = await run(built);

    expect(outcomes(result)).toEqual(['held_video', 'import']);
    expect(importedEntryIds(result)).toEqual([built.entryIdFor('companion.jpg')]);
    expect(importedEntryIds(result)).not.toContain(built.entryIdFor('held.mp4'));
    expect(result.summary.skipped.held_video).toBe(1);
  });

  it('holds a post whose media is in a part the member did not select', async () => {
    const built = buildArchive(
      heldPlusCompanion({
        timestamp: TS,
        post: 'a photo from another part',
        media: [{ name: 'absent.jpg', listed: false }],
      }),
    );
    // The uri is in the JSON and nothing is listed for it: `URI_UNRESOLVED`,
    // which is the one hold class worth retrying with a fuller selection.
    expect(() => built.entryIdFor('absent.jpg')).toThrow();

    const result = await run(built);

    expect(outcomes(result)).toEqual(['media_missing', 'import']);
    expect(importedEntryIds(result)).toEqual([built.entryIdFor('companion.jpg')]);
    expect(result.summary.skipped.media_missing).toBe(1);
  });

  it('holds a post whose media reference the allowlist refuses', async () => {
    const built = buildArchive(
      heldPlusCompanion({
        timestamp: TS,
        post: 'a reference we will not follow',
        media: [{ name: 'outside.jpg' }],
      }),
      // The entry is listed and is a perfectly good JPEG; the REFERENCE is
      // what is refused, so this is the sharpest form of the negative.
      {
        uriOverrides: { [fbMediaUri('outside.jpg')]: { ok: false, skip: 'URI_OUTSIDE_ALLOWLIST' } },
      },
    );

    const result = await run(built);

    expect(outcomes(result)).toEqual(['media_unsupported_reference', 'import']);
    expect(importedEntryIds(result)).toEqual([built.entryIdFor('companion.jpg')]);
    expect(importedEntryIds(result)).not.toContain(built.entryIdFor('outside.jpg'));
    expect(result.summary.skipped.media_unsupported_reference).toBe(1);
  });

  it('holds a post whose media bytes no sniffer recognises', async () => {
    const built = buildArchive(
      heldPlusCompanion({
        timestamp: TS,
        post: 'bytes we cannot classify',
        media: [{ name: 'unreadable.jpg', head: unknownHead() }],
      }),
    );

    const result = await run(built);

    // `ENTRY_SNIFF_INDETERMINATE`: the sniff recognises ISO-BMFF video and
    // still images only, so "unrecognised" is never evidence of "not a video".
    expect(outcomes(result)).toEqual(['media_unreadable', 'import']);
    expect(importedEntryIds(result)).toEqual([built.entryIdFor('companion.jpg')]);
    expect(importedEntryIds(result)).not.toContain(built.entryIdFor('unreadable.jpg'));
    expect(result.summary.skipped.media_unreadable).toBe(1);
  });

  it('holds a post whose media is an image format the app cannot handle', async () => {
    const built = buildArchive(
      heldPlusCompanion({
        timestamp: TS,
        post: 'an exotic still',
        media: [{ name: 'exotic.jpg' }],
      }),
    );
    const exotic = built.entryIdFor('exotic.jpg');

    const result = await run(built, {}, (session) => {
      // The ONLY row in this block that cannot be produced through a real
      // session. `peekEntryKind` maps every exotic head to
      // `ENTRY_SNIFF_INDETERMINATE` (verified 2026-11-12): `classifySniff`'s
      // non-image branch needs a sniffed type that is neither `image/` nor
      // `video/`, and `sniffContentType` returns no such thing. The live
      // producer of `unsupported_image_format` is #926's upload-time
      // `sanitizeStillImage` failure, long after this pre-pass. The reason is
      // nevertheless in the hold table and in the fold's priority order, so
      // the orchestration's handling of it is pinned here with a spy rather
      // than left to the day Rust or the sniff table starts emitting it.
      const unsupported: ArchiveEntryKindOutcome = {
        ok: false,
        skip: 'ENTRY_UNSUPPORTED_IMAGE_FORMAT',
      };
      // Bound BEFORE the spy replaces it, so the companion post still takes
      // the production path and the negative assertion keeps its teeth.
      const real = session.peekEntryKind.bind(session);
      jest
        .spyOn(session, 'peekEntryKind')
        .mockImplementation((entryId, options) =>
          entryId === exotic ? Promise.resolve(unsupported) : real(entryId, options),
        );
    });

    expect(outcomes(result)).toEqual(['unsupported_image_format', 'import']);
    expect(importedEntryIds(result)).toEqual([built.entryIdFor('companion.jpg')]);
    expect(importedEntryIds(result)).not.toContain(exotic);
    expect(result.summary.skipped.unsupported_image_format).toBe(1);
  });

  it('holds the WHOLE post when only one of its media is a video', async () => {
    const built = buildArchive(
      fbEntrySpecs({
        posts: [
          {
            timestamp: TS,
            post: 'a mixed album',
            media: [{ name: 'mixed.jpg' }, { name: 'mixed.mp4' }],
          },
          { timestamp: TS + 1, post: 'photos only', media: [{ name: 'alone.jpg' }] },
        ],
      }),
    );

    const result = await run(built);

    // Emitted ONCE, as the hold — never once per media item, and never as a
    // post carrying the half of its album that happened to be importable.
    expect(outcomes(result)).toEqual(['held_video', 'import']);
    expect(importedEntryIds(result)).toEqual([built.entryIdFor('alone.jpg')]);
    expect(importedEntryIds(result)).not.toContain(built.entryIdFor('mixed.jpg'));
    // The hold is per POST: the second post in the same file is unaffected.
    expect(imports(result).map((post) => post.body)).toEqual(['photos only']);
  });
});

// ---------------------------------------------------------------------------
// Per-post interleaving
// ---------------------------------------------------------------------------

describe('per-post interleaving', () => {
  it('awaits post N’s onItem before peeking post N+1’s media', async () => {
    const built = buildArchive(
      fbEntrySpecs({
        posts: [
          { timestamp: TS, post: 'one', media: [{ name: 'one.jpg' }] },
          { timestamp: TS + 1, post: 'two', media: [{ name: 'two.jpg' }] },
          { timestamp: TS + 2, post: 'three', media: [{ name: 'three.jpg' }] },
        ],
      }),
    );

    let seen = 0;
    let releaseFirst: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const onItem = jest.fn<Promise<void>, [ParsedItem, Uint8Array | null]>(() => {
      seen += 1;
      return seen === 1 ? held : Promise.resolve();
    });

    const parse = run(built, { onItem });

    // The run is parked inside the first item's `onItem`. If the parse peeked
    // ahead, the second post's entry would already have been read — which is
    // the failure that matters: a peek is an FFI inflation competing with
    // #921's inserts for Rust's four job slots.
    await flush();
    expect(built.mock.peekHead).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await parse;

    // Jest's invocation counter is global across mocks, so merging the two
    // call orders recovers the real interleaving without wrapping either one.
    const timeline = [
      ...built.mock.peekHead.mock.invocationCallOrder.map((at) => ({ at, mark: 'peek' })),
      ...onItem.mock.invocationCallOrder.map((at) => ({ at, mark: 'item' })),
    ]
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.mark);
    expect(timeline).toEqual(['peek', 'item', 'peek', 'item', 'peek', 'item']);
  });
});

// ---------------------------------------------------------------------------
// Run-wide dedup
// ---------------------------------------------------------------------------

describe('duplicate_in_archive', () => {
  /** Two byte-identical posts: same timestamp, same text, same media uri. */
  const twins: FbPostSpec[] = [
    { timestamp: TS, post: 'said once', media: [{ name: 'twin.jpg' }] },
    { timestamp: TS, post: 'said once', media: [{ name: 'twin.jpg' }] },
  ];

  it('settles the first occurrence and reports the second under the same key', async () => {
    const built = buildArchive(fbEntrySpecs({ posts: twins }));

    const result = await run(built);

    expect(outcomes(result)).toEqual(['import', 'duplicate_in_archive']);
    // The SAME `import_key`: this is what makes the server's dedup and #921's
    // row the same identity rather than two rows one of them cannot keep.
    expect(result.keys[1]).toEqual(result.keys[0]);
    expect(result.keys[0]).not.toBeNull();
    // The duplicate's media is never looked at — the first occurrence already
    // reported whatever its outcome was.
    expect(built.mock.peekHead).toHaveBeenCalledTimes(1);
    expect(result.summary).toMatchObject({ importable: 1, importableMedia: 1 });
  });

  it('dedups run-WIDE, across two files', async () => {
    // Text-only twins: the same media listed by two files would be
    // `URI_AMBIGUOUS`, which is a different test's subject.
    const post: FbPostSpec = { timestamp: TS, post: 'said once, exported twice' };
    const built = buildArchive([
      ...fbEntrySpecs({ index: 1, posts: [post] }),
      ...fbEntrySpecs({ index: 2, posts: [post] }),
    ]);

    const result = await run(built);

    expect(outcomes(result)).toEqual(['import', 'duplicate_in_archive']);
    expect(result.items.map((item) => item.sourceFile)).toEqual([fbSourceFile(1), fbSourceFile(2)]);
    expect(result.keys[1]).toEqual(result.keys[0]);
  });

  it('reports a duplicate of a HELD post as a duplicate, not as a second hold', async () => {
    const heldTwins: FbPostSpec[] = [
      { timestamp: TS, post: 'a clip, twice', media: [{ name: 'twin.mp4' }] },
      { timestamp: TS, post: 'a clip, twice', media: [{ name: 'twin.mp4' }] },
    ];
    const built = buildArchive(fbEntrySpecs({ posts: heldTwins }));

    const result = await run(built);

    // Counting it as a second `held_video` would tell the member two videos
    // did not migrate when the archive only ever named one.
    expect(outcomes(result)).toEqual(['held_video', 'duplicate_in_archive']);
    expect(result.summary.skipped).toMatchObject({ held_video: 1, duplicate_in_archive: 1 });
    expect(result.keys[1]).toEqual(result.keys[0]);
  });
});

// ---------------------------------------------------------------------------
// The file plan
// ---------------------------------------------------------------------------

describe('the file plan', () => {
  it('says nothing about a file repeated across ZIP parts', async () => {
    const [json, ...media] = fbEntrySpecs({
      posts: [
        { timestamp: TS, post: 'first' },
        { timestamp: TS + 1, post: 'second' },
      ],
    });
    // Meta repeats a file in every part and Rust lists the first, marking the
    // rest `ENTRY_DUPLICATE`. Telling a member their archive has a problem
    // because it is a multi-part archive would be pure noise.
    const built = buildArchive([json, { ...json, skip: 'ENTRY_DUPLICATE' }, ...media]);

    const result = await run(built);

    expect(result.summary.fileIssues).toEqual([]);
    expect(outcomes(result)).toEqual(['import', 'import']);
    expect(built.mock.readJson).toHaveBeenCalledTimes(1);
  });

  it('reads posts_2 before posts_10', async () => {
    // Lexicographic order would put `_10` first and interleave the member's
    // history — and because the FIRST occurrence of a duplicated post wins,
    // it would also change WHICH copy is kept.
    const built = buildArchive([
      ...fbEntrySpecs({ index: 10, posts: [{ timestamp: TS + 10, post: 'from ten' }] }),
      ...fbEntrySpecs({ index: 2, posts: [{ timestamp: TS, post: 'from two' }] }),
    ]);

    const result = await run(built);

    expect(result.items.map((item) => item.sourceFile)).toEqual([
      fbSourceFile(2),
      fbSourceFile(10),
    ]);
    expect(imports(result).map((post) => post.body)).toEqual(['from two', 'from ten']);
  });
});

// ---------------------------------------------------------------------------
// File issues
// ---------------------------------------------------------------------------
//
// Every row asserts BOTH halves of the contract: the issue reaches the summary,
// and the file's posts produce no items at all. "0 posts from a file that
// clearly had some" is exactly the outcome a member needs a reason for.

describe('file issues', () => {
  /** The one-file archive these rows vary, with its json spec replaced. */
  function fileWith(overrides: Partial<EntrySpec>): BuiltArchive {
    const [json, ...media] = fbEntrySpecs({
      posts: [
        { timestamp: TS, post: 'never read' },
        { timestamp: TS + 1, post: 'also never read' },
      ],
    });
    return buildArchive([{ ...json, ...overrides }, ...media]);
  }

  it('refuses a json entry whose declared size is over the byte cap', async () => {
    const built = fileWith({ declaredSize: MAX_JSON_BYTES + 1 });

    const result = await run(built);

    expect(result.summary.fileIssues).toEqual([
      { sourceFile: fbSourceFile(1), reason: 'json_too_large' },
    ]);
    expect(result.items).toEqual([]);
    // Never opened: the cap is enforced from the LISTING, before a read.
    expect(built.mock.readJson).not.toHaveBeenCalled();
  });

  it('refuses a json entry Rust listed as over the cap', async () => {
    const built = fileWith({ skip: 'ENTRY_OVER_CAP' });

    const result = await run(built);

    expect(result.summary.fileIssues).toEqual([
      { sourceFile: fbSourceFile(1), reason: 'json_too_large' },
    ]);
    expect(result.items).toEqual([]);
  });

  it('refuses a json entry that is not JSON', async () => {
    const built = buildArchive([{ path: fbJsonPath(1), kind: 'json', text: 'not json at all' }]);

    const result = await run(built);

    expect(result.summary.fileIssues).toEqual([
      { sourceFile: fbSourceFile(1), reason: 'json_unparseable' },
    ]);
    expect(result.items).toEqual([]);
  });

  it('refuses a json file whose top level is an object', async () => {
    // It parsed, but it is not a Facebook post file. Guessing at some other
    // container is how a parser ends up reading a file it was never pointed at.
    const built = buildArchive([
      { path: fbJsonPath(1), kind: 'json', text: JSON.stringify({ posts: [] }) },
    ]);

    const result = await run(built);

    expect(result.summary.fileIssues).toEqual([
      { sourceFile: fbSourceFile(1), reason: 'json_unparseable' },
    ]);
    expect(result.items).toEqual([]);
  });

  it('reports a json entry that lists clean but cannot be read', async () => {
    const built = fileWith({ readSkip: 'ENTRY_CORRUPT' });

    const result = await run(built);

    // `readEntryJson`'s skips are VALUES, not throws, and a skipped JSON entry
    // is precisely what the member needs to be told about that file.
    expect(result.summary.fileIssues).toEqual([
      { sourceFile: fbSourceFile(1), reason: 'json_entry_skipped' },
    ]);
    expect(result.items).toEqual([]);
    expect(built.mock.readJson).toHaveBeenCalledTimes(1);
  });

  it('holds every post in a file that names more media than the pre-pass resolves', async () => {
    // Built from unlisted media, so the fixture is 25,050 uri STRINGS and not
    // one archive entry: the cap is about what `resolveMediaUris` would be
    // asked to walk synchronously, and nothing has to exist for that.
    const postCount = Math.ceil((MAX_MEDIA_URIS_PER_FILE + 1) / MAX_MEDIA_PER_POST);
    const built = buildArchive(
      fbEntrySpecs({
        posts: Array.from({ length: postCount }, (_unused, post) => ({
          timestamp: TS + post,
          post: `post ${post}`,
          media: Array.from({ length: MAX_MEDIA_PER_POST }, (_item, index) => ({
            name: `m${post}_${index}.jpg`,
            listed: false,
          })),
        })),
      }),
    );

    const result = await run(built);

    expect(result.summary.fileIssues).toEqual([
      { sourceFile: fbSourceFile(1), reason: 'json_too_many_media' },
    ]);
    // NOTHING in the file was classified, so no post in it has a licence to
    // import any of its media — every one is held, and none is imported.
    expect(result.items).toHaveLength(postCount);
    expect(new Set(outcomes(result))).toEqual(new Set(['media_unreadable']));
    expect(result.summary).toMatchObject({ importable: 0, importableMedia: 0 });
    expect(built.mock.peekHead).not.toHaveBeenCalled();
  });

  it('refuses the archive past the post-file cap, and reads no further file', async () => {
    const built = buildArchive(
      Array.from({ length: MAX_POST_JSON_FILES + 1 }, (_unused, index) =>
        fbEntrySpecs({
          index: index + 1,
          posts: [{ timestamp: TS + index, post: `file ${index}` }],
        }),
      ).flat(),
    );

    const result = await run(built);

    expect(result.summary.fileIssues).toEqual([
      { sourceFile: fbSourceFile(MAX_POST_JSON_FILES + 1), reason: 'archive_too_large' },
    ]);
    expect(result.summary.importable).toBe(MAX_POST_JSON_FILES);
    // The member is told rather than left to discover the tail missing.
    expect(built.mock.readJson).toHaveBeenCalledTimes(MAX_POST_JSON_FILES);
    const readIds = built.mock.readJson.mock.calls.map(([entryId]) => entryId);
    expect(readIds).not.toContain(built.entryIdFor(fbSourceFile(MAX_POST_JSON_FILES + 1)));
  });

  it('refuses the archive once the run-wide post cap is reached', async () => {
    // COST: the most expensive row in this suite by far — 50,001 posts parsed
    // and 50,000 emitted, which is the only way to reach a 50,000 cap.
    // `MAX_POSTS_PER_FILE` bounds one file at 20,000, so three files is the
    // minimum, and the third carries only the single post that trips it.
    const file = (index: number, count: number, from: number): EntrySpec[] =>
      fbEntrySpecs({
        index,
        posts: Array.from({ length: count }, (_unused, at) => ({
          timestamp: TS,
          // Distinct text, so the dedup set never fires and every post counts.
          post: `p${from + at}`,
        })),
      });
    const last = MAX_POSTS_PER_RUN - 2 * MAX_POSTS_PER_FILE + 1;
    const built = buildArchive([
      ...file(1, MAX_POSTS_PER_FILE, 0),
      ...file(2, MAX_POSTS_PER_FILE, MAX_POSTS_PER_FILE),
      ...file(3, last, 2 * MAX_POSTS_PER_FILE),
    ]);
    const session = await built.open();

    // Deliberately NOT `run()`: retaining 50,000 emitted items would measure
    // this file's memory rather than the parser's, and the parser's own claim
    // is that it keeps no item after `onItem` resolves.
    let emitted = 0;
    const summary = await parseArchive(session, {
      source: 'facebook',
      nowUtcDay: NOW_UTC_DAY,
      deriveImportKey: fakeDeriveImportKey,
      onItem: () => {
        emitted += 1;
        return Promise.resolve();
      },
    });

    expect(emitted).toBe(MAX_POSTS_PER_RUN);
    expect(summary.importable).toBe(MAX_POSTS_PER_RUN);
    expect(summary.fileIssues).toEqual([
      { sourceFile: fbSourceFile(3), reason: 'archive_too_large' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe('abort', () => {
  it('rejects ECANCELLED without emitting anything when the signal is already aborted', async () => {
    const built = buildArchive(fbEntrySpecs({ posts: [{ timestamp: TS, post: 'never seen' }] }));
    const session = await built.open();
    const controller = new AbortController();
    controller.abort();

    const seen: ParsedItem[] = [];
    const parse = parseArchive(session, {
      source: 'facebook',
      nowUtcDay: NOW_UTC_DAY,
      deriveImportKey: fakeDeriveImportKey,
      signal: controller.signal,
      onItem: (item) => {
        seen.push(item);
        return Promise.resolve();
      },
    });

    // The archive reader's own cancellation code, so #926 can tell a member's
    // cancel apart from a failure with `isArchiveCancellation`.
    await expect(parse).rejects.toBeInstanceOf(ArchiveReaderError);
    await expect(parse).rejects.toMatchObject({ code: 'ECANCELLED' });
    expect(seen).toEqual([]);
    expect(built.mock.readJson).not.toHaveBeenCalled();
  });

  it('stops the run when onItem aborts the signal', async () => {
    const built = buildArchive(
      fbEntrySpecs({
        posts: [
          { timestamp: TS, post: 'one' },
          { timestamp: TS + 1, post: 'two' },
          { timestamp: TS + 2, post: 'three' },
        ],
      }),
    );
    const session = await built.open();
    const controller = new AbortController();

    const seen: ParsedItem[] = [];
    const parse = parseArchive(session, {
      source: 'facebook',
      nowUtcDay: NOW_UTC_DAY,
      deriveImportKey: fakeDeriveImportKey,
      signal: controller.signal,
      onItem: (item) => {
        seen.push(item);
        controller.abort();
        return Promise.resolve();
      },
    });

    // The rejection propagates and there is NO summary: a summary describing
    // items the caller never stored would be a promise about an import that
    // cannot happen.
    await expect(parse).rejects.toMatchObject({ code: 'ECANCELLED' });
    expect(seen).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Archive-wide throws
// ---------------------------------------------------------------------------

describe('an archive throw', () => {
  // There is no `catch` in `parseArchive`, and these two rows are why.
  // `ARCHIVE_BUSY` is `retryable-pause` and `ARCHIVE_ACCESS_LOST` is
  // `requires-repick`: #926 pauses or asks for the files again. Swallowing
  // either into a `media_unreadable` skip would turn a resumable pause into a
  // permanent, silent "your photo did not migrate" that the member can never
  // undo.

  it('propagates a peek failure instead of holding the post', async () => {
    expect(ARCHIVE_ERROR_DISPOSITIONS.ARCHIVE_BUSY).toBe('retryable-pause');
    const built = buildArchive(
      fbEntrySpecs({
        posts: [{ timestamp: TS, post: 'a photo post', media: [{ name: 'busy.jpg' }] }],
      }),
    );
    const busy = new ArchiveReaderError('ARCHIVE_BUSY');

    await expect(
      run(built, {}, (session) => {
        jest.spyOn(session, 'peekEntryKind').mockRejectedValue(busy);
      }),
    ).rejects.toBe(busy);
  });

  it('propagates a json read failure instead of reporting a file issue', async () => {
    expect(ARCHIVE_ERROR_DISPOSITIONS.ARCHIVE_ACCESS_LOST).toBe('requires-repick');
    const built = buildArchive(fbEntrySpecs({ posts: [{ timestamp: TS, post: 'unreachable' }] }));
    const lost = new ArchiveReaderError('ARCHIVE_ACCESS_LOST');

    // `readEntryJson`'s SKIPS are values, but a throw from it is still a
    // run-level fact: the member re-picks their files, they do not lose a file.
    await expect(
      run(built, {}, (session) => {
        jest.spyOn(session, 'readEntryJson').mockRejectedValue(lost);
      }),
    ).rejects.toBe(lost);
  });
});

// ---------------------------------------------------------------------------
// The summary's arithmetic
// ---------------------------------------------------------------------------

describe('the summary', () => {
  it('reports no other source when the archive holds only this one’s files', async () => {
    const built = buildArchive(fbEntrySpecs({ posts: [{ timestamp: TS, post: 'alone' }] }));

    const result = await run(built);

    expect(result.summary.otherSourceDetected).toBe(false);
  });

  it('claims no location data was removed when nothing imported carries media', async () => {
    const built = buildArchive(
      fbEntrySpecs({
        posts: [
          { timestamp: TS, post: 'words only' },
          // A HELD post's media is never uploaded, so it cannot be what makes
          // the claim true either.
          { timestamp: TS + 1, post: 'a clip', media: [{ name: 'clip.mp4' }] },
        ],
      }),
    );

    const result = await run(built);

    expect(result.summary).toMatchObject({ importableMedia: 0, locationDataRemoved: false });
  });

  it('claims location data was removed as soon as one image imports', async () => {
    const built = buildArchive(
      fbEntrySpecs({
        posts: [
          { timestamp: TS, post: 'words only' },
          { timestamp: TS + 1, post: 'a photo', media: [{ name: 'photo.jpg' }] },
        ],
      }),
    );

    const result = await run(built);

    // True iff there is imported media at all, and valid ONLY because #926
    // uploads every imported image through `sanitizeStillImage`.
    expect(result.summary).toMatchObject({ importableMedia: 1, locationDataRemoved: true });
  });

  it('spans the IMPORTABLE posts only', async () => {
    const built = buildArchive(
      fbEntrySpecs({
        posts: [
          { timestamp: TS, post: 'the earliest import' },
          { timestamp: TS + 100, post: 'the latest import' },
          // Dated after both, and held: its date belongs in #928's per-item
          // list, not in the "your history spans…" headline.
          { timestamp: TS + 9_000, post: 'a clip', media: [{ name: 'late.mp4' }] },
        ],
      }),
    );

    const result = await run(built);

    expect(result.summary).toMatchObject({
      earliestDate: TS * 1000,
      latestDate: (TS + 100) * 1000,
    });
  });

  it('has no date range at all when nothing is importable', async () => {
    const built = buildArchive(
      fbEntrySpecs({
        posts: [{ timestamp: TS, post: 'a clip', media: [{ name: 'only.mp4' }] }],
      }),
    );

    const result = await run(built);

    expect(result.summary).toMatchObject({
      importable: 0,
      earliestDate: null,
      latestDate: null,
    });
  });

  it('counts every skip reason, zeros included', async () => {
    const built = buildArchive(
      fbEntrySpecs({
        posts: [{ timestamp: TS, post: 'a clip', media: [{ name: 'only.mp4' }] }],
      }),
    );

    const result = await run(built);

    // `toEqual`, not `toMatchObject`: `skipped` is exhaustive by construction,
    // and a partial record would leave #928 rendering `undefined` for a reason
    // nobody counted.
    expect(result.summary.skipped).toEqual({
      held_video: 1,
      unsupported_image_format: 0,
      media_missing: 0,
      media_unsupported_reference: 0,
      media_unreadable: 0,
      unsupported_post_type: 0,
      empty_post: 0,
      text_too_long: 0,
      invalid_timestamp: 0,
      missing_timestamp: 0,
      duplicate_in_archive: 0,
      malformed_post: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

describe('onProgress', () => {
  it('reports non-decreasing counters that end on the run’s totals', async () => {
    const built = buildArchive(
      fbEntrySpecs({
        posts: [
          { timestamp: TS, post: 'one', media: [{ name: 'one.jpg' }] },
          { timestamp: TS + 1, post: 'two' },
          {
            timestamp: TS + 2,
            post: 'three',
            media: [{ name: 'three.jpg' }, { name: 'four.jpg' }],
          },
        ],
      }),
    );

    const result = await run(built);

    expect(result.progress.length).toBeGreaterThan(0);
    for (let at = 1; at < result.progress.length; at++) {
      // A counter that went backwards would show a member a progress bar
      // retreating, which reads as "it is going wrong" rather than "it is slow".
      expect(result.progress[at].postsSeen).toBeGreaterThanOrEqual(
        result.progress[at - 1].postsSeen,
      );
      expect(result.progress[at].mediaPeeked).toBeGreaterThanOrEqual(
        result.progress[at - 1].mediaPeeked,
      );
    }

    // Three distinct entries, all images, so each one reached `peekHead`
    // exactly once and each charged the run-wide budget exactly once.
    expect(result.progress[result.progress.length - 1]).toEqual({
      postsSeen: result.items.length,
      mediaPeeked: 3,
    });
    expect(built.mock.peekHead).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Instagram identity fallbacks
// ---------------------------------------------------------------------------
//
// An fbid is the identity that survives a member re-downloading their archive
// next month, so losing one is a real behaviour change — but it is never a
// reason to refuse a post. Every row here proves the same pair: the file issue
// is reported, AND every post still parses under a content-derived id.

describe('instagram identity fallbacks', () => {
  /** The flat content file these rows share: one post, one media. */
  function igContent(): EntrySpec[] {
    return igFlatEntrySpecs({
      posts: [
        {
          creationTimestamp: TS,
          title: 'a caption',
          media: [{ name: 'shot.jpg', creationTimestamp: TS }],
        },
      ],
    });
  }

  /**
   * The labelled `posts.json` alone.
   *
   * `listMedia` is off by default, so this is exactly one spec: its uris are
   * the same files the content file lists, and listing them twice would make
   * every reference `URI_AMBIGUOUS`.
   */
  function igLabelledJson(posts: readonly IgLabelledPostSpec[]): EntrySpec {
    const [labelled] = igLabelledEntrySpecs({ posts });
    return labelled;
  }

  it('falls back to content ids when the labelled file is over the byte cap', async () => {
    const built = buildArchive([
      {
        ...igLabelledJson([{ fbid: '17900000000000001', coverMedia: [{ name: 'shot.jpg' }] }]),
        skip: 'ENTRY_OVER_CAP',
      },
      ...igContent(),
    ]);

    const result = await run(built, { source: 'instagram' });

    expect(result.summary.fileIssues).toEqual([
      { sourceFile: 'posts.json', reason: 'json_too_large' },
    ]);
    expect(result.summary.idScheme).toEqual({ fbid: 0, content: 1 });
    expect(outcomes(result)).toEqual(['import']);
  });

  it('falls back to a content id for media two posts claim', async () => {
    const built = buildArchive([
      igLabelledJson([
        { fbid: '17900000000000001', coverMedia: [{ name: 'shot.jpg' }] },
        { fbid: '17900000000000002', coverMedia: [{ name: 'shot.jpg' }] },
      ]),
      ...igContent(),
    ]);

    const result = await run(built, { source: 'instagram' });

    // A first-one-wins index would hand this post a CONFIDENTLY WRONG
    // identity — the one failure mode that survives into the server's dedup.
    // The file itself is fine, so there is no issue to report.
    expect(result.summary.fileIssues).toEqual([]);
    expect(result.summary.idScheme).toEqual({ fbid: 0, content: 1 });
    expect(outcomes(result)).toEqual(['import']);
  });

  it('falls back to content ids when the labelled file cannot be read', async () => {
    const built = buildArchive([
      {
        ...igLabelledJson([{ fbid: '17900000000000001', coverMedia: [{ name: 'shot.jpg' }] }]),
        readSkip: 'ENTRY_CORRUPT',
      },
      ...igContent(),
    ]);

    const result = await run(built, { source: 'instagram' });

    // The one file whose absence changes identities, so it is never silent.
    expect(result.summary.fileIssues).toEqual([
      { sourceFile: 'posts.json', reason: 'json_entry_skipped' },
    ]);
    expect(result.summary.idScheme).toEqual({ fbid: 0, content: 1 });
    expect(outcomes(result)).toEqual(['import']);
  });
});
