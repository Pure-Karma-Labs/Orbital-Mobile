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

import { parseArchive } from '../parseArchive';
import {
  buildArchive,
  fbEntrySpecs,
  igFlatEntrySpecs,
  igLabelledEntrySpecs,
  mp4Head,
  type BuiltArchive,
} from '../testUtils/builders';

import type { ArchiveImportSession } from '../archiveAccess';
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
