/**
 * `instagramParser.ts` — the flat content files, and the fbid join that gives
 * their posts a stable identity.
 *
 * Content ALWAYS comes from `posts_N.json`; `posts.json` contributes nothing
 * but `fbid`s. Both halves are pure functions of text, so no session is opened
 * here either. Fixtures are synthetic (`testUtils/builders.ts`).
 */

import { buildFbidIndex, parseInstagramFlatFile, type FbidIndex } from '../instagramParser';
import { buildSourceItemId } from '../sourceItemId';
import {
  igFlatJsonText,
  igLabelledJsonText,
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

  it('restores display order for a carousel, which the export stores reversed', () => {
    const post = onePost({
      posts: [
        {
          creationTimestamp: TS,
          title: 'c',
          media: [
            { name: 'third.jpg', creationTimestamp: TS - 1 },
            { name: 'second.jpg', creationTimestamp: TS - 2 },
            { name: 'first.jpg', creationTimestamp: TS - 3 },
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
    expect(post.mediaDates).toEqual([(TS - 3) * 1000, (TS - 2) * 1000, (TS - 1) * 1000]);
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

  it('reports an unparseable labelled file instead of throwing', () => {
    expect(buildFbidIndex('{')).toEqual({ ok: false, reason: 'json_unparseable' });
    expect(buildFbidIndex('{"posts":[]}')).toEqual({ ok: false, reason: 'json_unparseable' });
  });
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
    expect(onePost({ posts: [{ media: [{ name: 'a.jpg', creationTimestamp: TS }] }] }, map).idScheme).toBe(
      'content',
    );
  });

  it('falls back to a content id when two different fbids match one post', () => {
    const map = index({
      posts: [
        { fbid: '9095', coverMedia: [{ name: 'a.jpg' }] },
        { fbid: '9096', coverMedia: [{ name: 'b.jpg' }] },
      ],
    });
    const post = onePost(
      { posts: [{ creationTimestamp: TS, title: 'x', media: [{ name: 'a.jpg' }, { name: 'b.jpg' }] }] },
      map,
    );
    expect(post.idScheme).toBe('content');
  });

  it('gives every post a content id when the labelled file was unavailable', () => {
    // The `posts.json`-over-cap case: `layout.ts` reports `json_too_large` and
    // hands the parser a null index.
    const post = onePost({ posts: [{ media: [{ name: 'a.jpg', creationTimestamp: TS }] }] }, null);
    expect(post.idScheme).toBe('content');
  });
});
