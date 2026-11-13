/**
 * `instagramParser.ts` — the flat content files, and the fbid join that gives
 * their posts a stable identity.
 *
 * Content ALWAYS comes from `posts_N.json`; `posts.json` contributes nothing
 * but `fbid`s. Both halves are pure functions of text, so no session is opened
 * here either. Fixtures are synthetic (`testUtils/builders.ts`).
 */

import {
  MAX_FBID_WALK_NODES,
  buildFbidIndex,
  parseInstagramFlatFile,
  type FbidIndex,
} from '../instagramParser';
import { buildSourceItemId } from '../sourceItemId';
import {
  igFlatJsonText,
  igLabelledJsonText,
  mojibakeEscape,
  type IgFlatFileSpec,
  type IgLabelledFileSpec,
} from '../testUtils/builders';

import type { ParseFileContext, ParsedSkip, RawParseResult, RawParsedPost } from '../types';

const SOURCE_FILE = 'posts_1.json';

/** 2020-09-13T12:26:40Z. */
const TS = 1_600_000_000;

const CTX: ParseFileContext = { sourceFile: SOURCE_FILE, nowUtcDay: '2026-11-12' };

function parse(
  file: IgFlatFileSpec,
  fbidIndex: FbidIndex | null = null,
  overrides: Partial<ParseFileContext> = {},
): RawParseResult[] {
  const result = parseInstagramFlatFile(igFlatJsonText(file), { ...CTX, ...overrides }, fbidIndex);
  if (!result.ok) throw new Error(`unexpected file issue: ${result.reason}`);
  return [...result.items];
}

function onePost(
  file: IgFlatFileSpec,
  fbidIndex: FbidIndex | null = null,
  overrides: Partial<ParseFileContext> = {},
): RawParsedPost {
  const [item] = parse(file, fbidIndex, overrides);
  if (item.outcome !== 'post') throw new Error(`expected a post, got skip ${item.reason}`);
  return item;
}

function oneSkip(file: IgFlatFileSpec, fbidIndex: FbidIndex | null = null): ParsedSkip {
  const [item] = parse(file, fbidIndex);
  if (item.outcome !== 'skip') throw new Error('expected a skip, got a post');
  return item;
}

function index(file: IgLabelledFileSpec): FbidIndex {
  const result = buildFbidIndex(igLabelledJsonText(file));
  if (!result.ok) throw new Error(`unexpected labelled file issue: ${result.reason}`);
  return result.index;
}

describe('parseInstagramFlatFile content', () => {
  it('reads a single-media post’s caption and date off its only media item', () => {
    // A single IG post has NO post-level timestamp and no post-level title:
    // both live on `media[0]`, and `title` there is the member's caption.
    const post = onePost({
      posts: [{ media: [{ name: 'a.jpg', creationTimestamp: TS, title: 'a caption' }] }],
    });
    expect(post).toMatchObject({
      outcome: 'post',
      source: 'instagram',
      sourceFile: SOURCE_FILE,
      sourceIndex: 0,
      originalDate: TS * 1000,
      body: 'a caption',
      idScheme: 'content',
    });
    expect(post.mediaUris).toEqual(['media/posts/a.jpg']);
  });

  it('prefers the post-level caption and timestamp on a carousel', () => {
    const post = onePost({
      posts: [
        {
          creationTimestamp: TS,
          title: 'post caption',
          media: [
            { name: 'b.jpg', creationTimestamp: TS - 5, title: 'item label' },
            { name: 'a.jpg', creationTimestamp: TS - 9 },
          ],
        },
      ],
    });
    expect(post.body).toBe('post caption');
    expect(post.originalDate).toBe(TS * 1000);
  });

  it('keeps a carousel’s stored order, and does not reverse it', () => {
    // Alex, 2026-11-12: the stored order IS the imported order. The real
    // sample gives a carousel's children one identical timestamp and unordered
    // filenames, so the export states nothing about display order — reversing
    // would get half of all carousels wrong instead of half right.
    const post = onePost({
      posts: [
        {
          creationTimestamp: TS,
          title: 'c',
          media: [
            { name: 'first.jpg', creationTimestamp: TS - 1 },
            { name: 'second.jpg', creationTimestamp: TS - 2 },
            { name: 'third.jpg', creationTimestamp: TS - 3 },
          ],
        },
      ],
    });
    expect(post.mediaUris).toEqual([
      'media/posts/first.jpg',
      'media/posts/second.jpg',
      'media/posts/third.jpg',
    ]);
    // The dates travel with their own media item, not with the position.
    expect(post.mediaDates).toEqual([(TS - 1) * 1000, (TS - 2) * 1000, (TS - 3) * 1000]);
  });

  it('imports a carousel whose media dates are out of range, stating no date for them', () => {
    // Same rule as Facebook's, applied by the same `mediaDateMs` — which is
    // the entire reason `dateBounds.ts` exists as one module rather than two
    // copies of a boundary rule. A media date decorates; it never gates the
    // import and never enters `source_item_id`, so a nonsense value costs
    // that item its date and nothing else. Unchecked it reaches #928 as
    // `new Date(1e303).toISOString()`, a RangeError far from the file that
    // stated it.
    //
    // A CAROUSEL, not a single-media post, on purpose: on a single-media
    // post `media[0].creation_timestamp` is ALSO the post's own timestamp
    // fallback, so an out-of-window value there refuses the whole post
    // (`invalid_timestamp`) and the media date would never be under test.
    // The post-level `creationTimestamp` here keeps the two apart.
    //
    // Three values, three different gates: `1e300` is refused by
    // `pickInteger` (`Number.isSafeInteger`) before the window is consulted;
    // `253_402_300_800` is a safe integer (year 10000 in seconds) and is the
    // only one that exercises the upper bound; `1_000_000_000` is 2001,
    // under the 2004 floor the server also applies.
    const post = onePost({
      posts: [
        {
          creationTimestamp: TS,
          title: 'carousel with bad media dates',
          media: [
            { name: 'unsafe.jpg', creationTimestamp: 1e300 },
            { name: 'year10000.jpg', creationTimestamp: 253_402_300_800 },
            { name: 'before-instagram.jpg', creationTimestamp: 1_000_000_000 },
            { name: 'fine.jpg', creationTimestamp: TS - 10 },
          ],
        },
      ],
    });

    expect(post.originalDate).toBe(TS * 1000);
    expect(post.mediaUris).toHaveLength(4);
    expect(post.mediaDates).toEqual([null, null, null, (TS - 10) * 1000]);
  });

  it('does not use a carousel child’s label as the post caption', () => {
    const post = onePost({
      posts: [
        {
          creationTimestamp: TS,
          media: [{ name: 'b.jpg', title: 'item label' }, { name: 'a.jpg' }],
        },
      ],
    });
    expect(post.body).toBe('');
  });

  it('reports a post with no caption and no media as empty_post', () => {
    expect(oneSkip({ posts: [{ creationTimestamp: TS }] }).reason).toBe('empty_post');
  });

  it('refuses a post with no timestamp anywhere', () => {
    const skip = oneSkip({ posts: [{ media: [{ name: 'a.jpg' }] }] });
    expect(skip).toMatchObject({
      reason: 'missing_timestamp',
      sourceItemId: null,
      originalDate: null,
    });
  });

  it('fails a post closed when a media item has no usable uri', () => {
    const result = parseInstagramFlatFile(
      JSON.stringify([{ creation_timestamp: TS, media: [{ uri: '' }] }]),
      CTX,
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]).toMatchObject({ outcome: 'skip', reason: 'malformed_post' });
  });
});

describe('parseInstagramFlatFile content breadth', () => {
  it('parses every flat layout identically, since the uri is root-relative in all four', () => {
    // The layout only names the file's own path; the uri inside is relative to
    // the archive root, so body, uris and identity cannot depend on it.
    const layouts: IgFlatFileSpec['layout'][] = [
      'activity-media',
      'activity-content',
      'content',
      'media',
    ];
    const posts = layouts.map((layout) =>
      onePost({
        layout,
        posts: [{ media: [{ name: 'a.jpg', creationTimestamp: TS, title: 'same' }] }],
      }),
    );
    for (const post of posts) {
      expect(post.body).toBe('same');
      expect(post.mediaUris).toEqual(['media/posts/a.jpg']);
      expect([...post.sourceItemId]).toEqual([...posts[0].sourceItemId]);
    }
  });

  it('numbers posts by their position in the file, imported and skipped alike', () => {
    const items = parse({
      posts: [
        { media: [{ name: 'a.jpg', creationTimestamp: TS, title: 'zero' }] },
        { title: 'no date' },
        { media: [{ name: 'b.jpg', creationTimestamp: TS + 1, title: 'two' }] },
        { creationTimestamp: TS },
      ],
    });
    expect(items.map((item) => item.sourceIndex)).toEqual([0, 1, 2, 3]);
    expect(items.map((item) => item.outcome)).toEqual(['post', 'skip', 'post', 'skip']);
  });

  it('numbers an all-imported file 0, 1, 2 in file order', () => {
    const items = parse({
      posts: [
        { media: [{ name: 'a.jpg', creationTimestamp: TS, title: 'first' }] },
        { media: [{ name: 'b.jpg', creationTimestamp: TS + 1, title: 'second' }] },
        { media: [{ name: 'c.jpg', creationTimestamp: TS + 2, title: 'third' }] },
      ],
    });
    expect(items.map((item) => item.sourceIndex)).toEqual([0, 1, 2]);
    expect(items.map((item) => (item.outcome === 'post' ? item.body : null))).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('prefers a non-empty post title over the media’s own on a single-media post', () => {
    const post = onePost({
      posts: [
        {
          title: 'post caption',
          media: [{ name: 'a.jpg', creationTimestamp: TS, title: 'media caption' }],
        },
      ],
    });
    expect(post.body).toBe('post caption');
  });

  it('falls back to the media’s title when the post title is an empty string', () => {
    const post = onePost({
      posts: [
        {
          title: '',
          media: [{ name: 'a.jpg', creationTimestamp: TS, title: 'media caption' }],
        },
      ],
    });
    expect(post.body).toBe('media caption');
  });

  it('falls back to the media’s timestamp when the post-level one is a string', () => {
    // Only an integer counts as a timestamp; a string is "not stated", so the
    // single-media fallback still applies.
    const post = onePost({
      posts: [
        {
          raw: { creation_timestamp: String(TS + 99) },
          media: [{ name: 'a.jpg', creationTimestamp: TS, title: 'x' }],
        },
      ],
    });
    expect(post.originalDate).toBe(TS * 1000);
  });

  it('refuses a post whose post-level and media timestamps are both unusable', () => {
    const skip = oneSkip({
      posts: [
        {
          raw: { creation_timestamp: String(TS) },
          media: [{ name: 'a.jpg', title: 'x' }],
        },
      ],
    });
    expect(skip).toMatchObject({
      reason: 'missing_timestamp',
      sourceItemId: null,
      originalDate: null,
    });
  });

  it('repairs byte-escaped mojibake in a caption and frames the repaired text', () => {
    const escaped = onePost({
      posts: [
        { media: [{ name: 'a.jpg', creationTimestamp: TS, title: mojibakeEscape('café ☕') }] },
      ],
    });
    const typed = onePost({
      posts: [{ media: [{ name: 'a.jpg', creationTimestamp: TS, title: 'café ☕' }] }],
    });
    expect(escaped.body).toBe('café ☕');
    expect([...escaped.sourceItemId]).toEqual([...typed.sourceItemId]);
  });

  it('reports an element that is not an object as malformed_post with no id', () => {
    const result = parseInstagramFlatFile('[42]', CTX, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]).toMatchObject({
      outcome: 'skip',
      reason: 'malformed_post',
      sourceItemId: null,
    });
  });
});

describe('parseInstagramFlatFile file-level outcomes', () => {
  it('reports a top level that is not an array as json_unparseable', () => {
    expect(parseInstagramFlatFile('{"media":[]}', CTX, null)).toEqual({
      ok: false,
      reason: 'json_unparseable',
    });
  });

  it('reports unparseable text as json_unparseable', () => {
    expect(parseInstagramFlatFile('[{', CTX, null)).toEqual({
      ok: false,
      reason: 'json_unparseable',
    });
  });

  it('reports over-deep nesting as json_too_deep', () => {
    const deep = `${'['.repeat(40)}${']'.repeat(40)}`;
    expect(parseInstagramFlatFile(deep, CTX, null)).toEqual({
      ok: false,
      reason: 'json_too_deep',
    });
  });

  it('parses an empty array as ok with no items', () => {
    expect(parseInstagramFlatFile('[]', CTX, null)).toEqual({ ok: true, items: [] });
  });
});

describe('buildFbidIndex', () => {
  it('walks cover media and carousel children, which sit at different depths', () => {
    // The real file hangs the cover off `label_values[].media[]` and the
    // children three levels deeper. A walk that knew only one depth would
    // silently lose every carousel's join.
    const map = index({
      posts: [
        {
          fbid: '1111',
          coverMedia: [{ name: 'cover.jpg' }],
          childMedia: [{ name: 'child1.jpg' }, { name: 'child2.jpg' }],
        },
      ],
    });
    expect(map.get('cover.jpg')).toBe('1111');
    expect(map.get('child1.jpg')).toBe('1111');
    expect(map.get('child2.jpg')).toBe('1111');
  });

  it('marks a basename claimed by two posts as ambiguous rather than guessing', () => {
    const map = index({
      posts: [
        { fbid: '1111', coverMedia: [{ name: 'shared.jpg' }] },
        { fbid: '2222', coverMedia: [{ name: 'shared.jpg' }] },
      ],
    });
    expect(map.get('shared.jpg')).toBeNull();
  });

  it('contributes nothing for an element with no fbid', () => {
    // An explicit `undefined` is dropped by JSON.stringify, so the key is
    // genuinely absent from the text the parser reads.
    const map = index({
      posts: [{ fbid: '1111', raw: { fbid: undefined }, coverMedia: [{ name: 'orphan.jpg' }] }],
    });
    expect(map.has('orphan.jpg')).toBe(false);
  });

  it('contributes nothing for an element whose fbid is not a string', () => {
    // A numeric fbid would be a different file shape than the one the join is
    // defined against; guessing at `String(n)` could mint a wrong identity.
    const map = index({
      posts: [{ fbid: '1111', raw: { fbid: 1111 }, coverMedia: [{ name: 'numeric.jpg' }] }],
    });
    expect(map.has('numeric.jpg')).toBe(false);
  });

  it('contributes nothing for an element whose fbid is an empty string', () => {
    const map = index({ posts: [{ fbid: '', coverMedia: [{ name: 'blank.jpg' }] }] });
    expect(map.has('blank.jpg')).toBe(false);
  });

  it('indexes a nested media uri by basename, so the flat form joins', () => {
    // The labelled file hangs media one directory deeper (`.../YYYYMM/<name>`)
    // than the flat file's uri; only the basename is common to both.
    const map = index({
      posts: [{ fbid: '5050', coverMedia: [{ name: '202001/nested.jpg' }] }],
    });
    expect(map.get('nested.jpg')).toBe('5050');
    expect(map.has('202001/nested.jpg')).toBe(false);

    const post = onePost(
      { posts: [{ media: [{ name: 'nested.jpg', creationTimestamp: TS }] }] },
      map,
    );
    expect(post.idScheme).toBe('fbid');
  });

  it('reports an unparseable labelled file instead of throwing', () => {
    expect(buildFbidIndex('{')).toEqual({ ok: false, reason: 'json_unparseable' });
    expect(buildFbidIndex('{"posts":[]}')).toEqual({ ok: false, reason: 'json_unparseable' });
  });
});

// ---------------------------------------------------------------------------
// The walk's node ceiling
// ---------------------------------------------------------------------------
//
// `MAX_FBID_WALK_NODES` bounds the labelled-file walk so a crafted 12 MiB
// file of one-character keys cannot turn a member's preflight into a hang.
// The real ceiling needs a multi-megabyte fixture to reach, so `maxNodes` is
// injected here instead — a budget nobody has ever seen bite is a budget that
// could be off by an order of magnitude in either direction.

describe('the fbid walk ceiling', () => {
  /**
   * Containers (objects and arrays) in one parsed value, itself included.
   *
   * This IS the walk's budget unit: only containers go on its stack, and the
   * graph is a tree, so each one is pushed and popped exactly once. Counting
   * it here rather than hard-coding a number means these rows keep testing
   * the ceiling even when the labelled-file builder changes shape.
   */
  function countContainers(value: unknown): number {
    if (typeof value !== 'object' || value === null) return 0;
    const children: unknown[] = Array.isArray(value) ? [...value] : Object.values(value);
    return children.reduce<number>((sum, child) => sum + countContainers(child), 1);
  }

  /** Scalar leaves — what the old walk charged for and this one does not. */
  function countScalars(value: unknown): number {
    if (typeof value !== 'object' || value === null) return 1;
    const children: unknown[] = Array.isArray(value) ? [...value] : Object.values(value);
    return children.reduce<number>((sum, child) => sum + countScalars(child), 0);
  }

  /** Exactly how many nodes the walk charges for one labelled file. */
  function walkCost(text: string): number {
    const root = JSON.parse(text) as unknown[];
    return root.reduce<number>((sum, element) => sum + countContainers(element), 0);
  }

  it('refuses the whole index rather than returning a truncated one', () => {
    const text = igLabelledJsonText({
      posts: [
        { fbid: '8001', coverMedia: [{ name: 'cover.jpg' }], childMedia: [{ name: 'c1.jpg' }] },
        { fbid: '8002', coverMedia: [{ name: 'other.jpg' }] },
      ],
    });
    // 25 containers for this two-post fixture, as counted above.
    const nodes = walkCost(text);
    expect(nodes).toBe(25);

    // One node short. A PARTIAL index would still be deterministic, but it
    // would give some posts fbid ids and others content ids depending on a
    // walk order nobody can see — so the whole file is refused.
    expect(buildFbidIndex(text, { maxNodes: nodes - 1 })).toEqual({
      ok: false,
      reason: 'json_too_large',
    });

    // The boundary itself passes: the ceiling is "more than", and a row that
    // only proved the refusal would pass on a walk that refused everything.
    const atCeiling = buildFbidIndex(text, { maxNodes: nodes });
    expect(atCeiling.ok).toBe(true);
    if (!atCeiling.ok) return;
    expect(atCeiling.index.get('c1.jpg')).toBe('8001');

    // And omitting the option is the production ceiling, not some other one.
    expect(buildFbidIndex(text)).toEqual(buildFbidIndex(text, { maxNodes: MAX_FBID_WALK_NODES }));
  });

  it('charges the budget in containers, so a file of scalar leaves still indexes', () => {
    // 400 scalar leaves hung off two containers. The real labelled file is
    // ~3× more leaves than containers, so a walk that pushed leaves would
    // make the ceiling bite three times sooner than its own docblock claims
    // — and tripping it flips EVERY Instagram post to a content-derived id,
    // which is a silent duplicate of the member's history on re-import.
    const text = igLabelledJsonText({
      posts: [
        {
          fbid: '8003',
          coverMedia: [{ name: 'padded.jpg' }],
          raw: {
            pad_object: Object.fromEntries(
              Array.from({ length: 200 }, (_unused, i) => [`k${i}`, `v${i}`]),
            ),
            pad_array: Array.from({ length: 200 }, (_unused, i) => `v${i}`),
          },
        },
      ],
    });

    const nodes = walkCost(text);
    const leaves = countScalars(JSON.parse(text));
    // 11 containers against 406 leaves (the 400 above plus the post's own
    // fbid, uri and labels): the leaf-charging walk would have needed 417
    // nodes to finish this file, nearly 38× the budget handed to it below —
    // so this row fails loudly the moment a scalar goes back on the stack.
    expect(nodes).toBe(11);
    expect(leaves).toBe(406);

    const built = buildFbidIndex(text, { maxNodes: nodes });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.index.get('padded.jpg')).toBe('8003');
  });

  // The parseArchive leg — the refusal reaching `summary.fileIssues` while
  // every post still parses under a content-derived id — is already proven
  // end to end by `parseArchive.test.ts`'s `instagram identity fallbacks`
  // describe, so it is not rebuilt here.
});

describe('the fbid join', () => {
  it('uses the fbid when every media hit agrees', () => {
    const map = index({ posts: [{ fbid: '9090', coverMedia: [{ name: 'a.jpg' }] }] });
    const post = onePost({ posts: [{ media: [{ name: 'a.jpg', creationTimestamp: TS }] }] }, map);
    expect(post.idScheme).toBe('fbid');
    const expected = buildSourceItemId({ kind: 'platform', platformId: '9090' });
    expect([...post.sourceItemId]).toEqual([...(expected ?? new Uint8Array())]);
  });

  it('joins a carousel through its children when the cover is not in the flat file', () => {
    // The labelled file's cover uri frequently names a file the content file
    // never mentions; the children carry the join.
    const map = index({
      posts: [
        {
          fbid: '9091',
          coverMedia: [{ name: 'cover-only.jpg' }],
          childMedia: [{ name: 'c1.jpg' }, { name: 'c2.jpg' }],
        },
      ],
    });
    const post = onePost(
      {
        posts: [
          {
            creationTimestamp: TS,
            title: 'carousel',
            media: [{ name: 'c2.jpg' }, { name: 'c1.jpg' }],
          },
        ],
      },
      map,
    );
    expect(post.idScheme).toBe('fbid');
  });

  it('falls back to a content id when no media is in the index', () => {
    const map = index({ posts: [{ fbid: '9092', coverMedia: [{ name: 'elsewhere.jpg' }] }] });
    const post = onePost({ posts: [{ media: [{ name: 'a.jpg', creationTimestamp: TS }] }] }, map);
    expect(post.idScheme).toBe('content');
  });

  it('falls back to a content id when two posts claim one of this post’s media', () => {
    const map = index({
      posts: [
        { fbid: '9093', coverMedia: [{ name: 'a.jpg' }] },
        { fbid: '9094', coverMedia: [{ name: 'a.jpg' }] },
      ],
    });
    expect(
      onePost({ posts: [{ media: [{ name: 'a.jpg', creationTimestamp: TS }] }] }, map).idScheme,
    ).toBe('content');
  });

  it('falls back to a content id when two different fbids match one post', () => {
    const map = index({
      posts: [
        { fbid: '9095', coverMedia: [{ name: 'a.jpg' }] },
        { fbid: '9096', coverMedia: [{ name: 'b.jpg' }] },
      ],
    });
    const post = onePost(
      {
        posts: [
          { creationTimestamp: TS, title: 'x', media: [{ name: 'a.jpg' }, { name: 'b.jpg' }] },
        ],
      },
      map,
    );
    expect(post.idScheme).toBe('content');
  });

  it('gives two flat posts joined to different fbids different fbid ids', () => {
    const map = index({
      posts: [
        { fbid: '7001', coverMedia: [{ name: 'a.jpg' }] },
        { fbid: '7002', coverMedia: [{ name: 'b.jpg' }] },
      ],
    });
    const [first, second] = parse(
      {
        posts: [
          { media: [{ name: 'a.jpg', creationTimestamp: TS }] },
          { media: [{ name: 'b.jpg', creationTimestamp: TS }] },
        ],
      },
      map,
    );
    if (first.outcome !== 'post' || second.outcome !== 'post') throw new Error('expected posts');
    expect([first.idScheme, second.idScheme]).toEqual(['fbid', 'fbid']);
    expect([...first.sourceItemId]).not.toEqual([...second.sourceItemId]);
  });

  it('leaves the body and media uris unchanged when the post joins an fbid', () => {
    // The id scheme decides identity only; what gets imported is the same.
    const map = index({ posts: [{ fbid: '7003', coverMedia: [{ name: 'a.jpg' }] }] });
    const file: IgFlatFileSpec = {
      posts: [{ media: [{ name: 'a.jpg', creationTimestamp: TS, title: 'kept' }] }],
    };
    const joined = onePost(file, map);
    const unjoined = onePost(file, null);
    expect(joined.idScheme).toBe('fbid');
    expect(joined.body).toBe(unjoined.body);
    expect(joined.mediaUris).toEqual(unjoined.mediaUris);
    expect(joined.originalDate).toBe(unjoined.originalDate);
  });

  it('gives every post a content id when the labelled file was unavailable', () => {
    // The `posts.json`-over-cap case: `layout.ts` reports `json_too_large` and
    // hands the parser a null index.
    const post = onePost({ posts: [{ media: [{ name: 'a.jpg', creationTimestamp: TS }] }] }, null);
    expect(post.idScheme).toBe('content');
  });
});
