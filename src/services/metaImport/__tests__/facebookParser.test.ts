/**
 * `facebookParser.ts` — one post JSON file in, items out.
 *
 * The parser is pure, so every test here is a string and an assertion; no
 * session is opened and no uri is resolved. Fixtures are the synthetic
 * builders (`testUtils/builders.ts`) — nothing in this file is derived from a
 * real export.
 */

import { parseFacebookFile } from '../facebookParser';
import { todayUtcDay } from '../dateBounds';
import { MAX_MEDIA_PER_POST } from '../jsonSafety';
import { fbJsonText, mojibakeEscape, type FbFileSpec } from '../testUtils/builders';

import type { ParseFileContext, ParsedSkip, RawParseResult, RawParsedPost } from '../types';

const SOURCE_FILE = 'your_posts__check_ins__photos_and_videos_1.json';

/** 2020-09-13T12:26:40Z — a date comfortably inside the import window. */
const TS = 1_600_000_000;

const CTX: ParseFileContext = { sourceFile: SOURCE_FILE, nowUtcDay: '2026-11-12' };

function parse(file: FbFileSpec, overrides: Partial<ParseFileContext> = {}): RawParseResult[] {
  const result = parseFacebookFile(fbJsonText(file), { ...CTX, ...overrides });
  if (!result.ok) throw new Error(`unexpected file issue: ${result.reason}`);
  return [...result.items];
}

function onePost(file: FbFileSpec, overrides: Partial<ParseFileContext> = {}): RawParsedPost {
  const [item] = parse(file, overrides);
  if (item.outcome !== 'post') throw new Error(`expected a post, got skip ${item.reason}`);
  return item;
}

function oneSkip(file: FbFileSpec, overrides: Partial<ParseFileContext> = {}): ParsedSkip {
  const [item] = parse(file, overrides);
  if (item.outcome !== 'skip') throw new Error('expected a skip, got a post');
  return item;
}

describe('parseFacebookFile text', () => {
  it('imports a plain text post with its date, source file and index', () => {
    const post = onePost({ posts: [{ timestamp: TS, post: 'hello world' }] });
    expect(post).toMatchObject({
      outcome: 'post',
      source: 'facebook',
      sourceFile: SOURCE_FILE,
      sourceIndex: 0,
      idScheme: 'content',
      originalDate: TS * 1000,
      body: 'hello world',
      mediaUris: [],
    });
    expect(post.sourceItemId.length).toBeGreaterThan(0);
  });

  it('joins several data[].post strings with a blank line', () => {
    // Facebook splits a post's words across `data[]` entries; the member saw
    // them as one post, and the join happens before the length floor so the
    // floor applies to what they saw.
    const post = onePost({ posts: [{ timestamp: TS, post: ['first', 'second'] }] });
    expect(post.body).toBe('first\n\nsecond');
  });

  it('skips a post over the body cap, keeping its id and date for #921', () => {
    const skip = oneSkip({ posts: [{ timestamp: TS, post: 'abcdef' }] }, { bodyMaxChars: 3 });
    expect(skip.reason).toBe('text_too_long');
    expect(skip.sourceItemId).not.toBeNull();
    expect(skip.originalDate).toBe(TS * 1000);
  });

  it('numbers posts by their position in the file, imported and skipped alike', () => {
    // #928 lists skips by `sourceIndex`; if a skip shifted the numbering, the
    // row a member is shown would point at the wrong post in their own file.
    const items = parse({
      posts: [
        { timestamp: TS, post: 'zero' },
        { post: 'no date' },
        { timestamp: TS + 1, post: 'two' },
        { timestamp: TS + 2 },
      ],
    });
    expect(items.map((item) => item.sourceIndex)).toEqual([0, 1, 2, 3]);
    expect(items.map((item) => item.outcome)).toEqual(['post', 'skip', 'post', 'skip']);
  });

  it('numbers an all-imported file 0, 1, 2 in file order', () => {
    const items = parse({
      posts: [
        { timestamp: TS, post: 'first' },
        { timestamp: TS + 1, post: 'second' },
        { timestamp: TS + 2, post: 'third' },
      ],
    });
    expect(items.map((item) => item.sourceIndex)).toEqual([0, 1, 2]);
    expect(items.map((item) => (item.outcome === 'post' ? item.body : null))).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('repairs byte-escaped mojibake in the body and frames the repaired text', () => {
    // The id is minted from the REPAIRED text: a member whose export carries
    // the escape form and one whose export carries the typed form are the same
    // post, and must not re-import as two.
    const escaped = onePost({ posts: [{ timestamp: TS, post: mojibakeEscape('café ☕') }] });
    const typed = onePost({ posts: [{ timestamp: TS, post: 'café ☕' }] });
    expect(escaped.body).toBe('café ☕');
    expect([...escaped.sourceItemId]).toEqual([...typed.sourceItemId]);
  });

  it('gives a different identity to a post with one more media item', () => {
    // Same words, same date, same first photo: the extra attachment is what
    // makes it a different post.
    const base = onePost({ posts: [{ timestamp: TS, post: 'same', media: [{ name: 'a.jpg' }] }] });
    const moreMedia = onePost({
      posts: [{ timestamp: TS, post: 'same', media: [{ name: 'a.jpg' }, { name: 'b.jpg' }] }],
    });
    expect([...moreMedia.sourceItemId]).not.toEqual([...base.sourceItemId]);
  });
});

describe('parseFacebookFile links', () => {
  it('appends an accepted https link on its own line', () => {
    const post = onePost({
      posts: [{ timestamp: TS, post: 'look', link: { url: 'https://example.org/a' } }],
    });
    expect(post.body).toBe('look\nhttps://example.org/a');
  });

  it('imports a link-only post as a body that is just the url', () => {
    const post = onePost({ posts: [{ timestamp: TS, link: { url: 'http://example.org/b' } }] });
    expect(post.body).toBe('http://example.org/b');
  });

  it('never reads the link’s display name or publisher', () => {
    // Alex, 2026-11-12: the member's text plus the URL, nothing Facebook
    // rendered on their behalf.
    const post = onePost({
      posts: [
        {
          timestamp: TS,
          post: 'read',
          link: { url: 'https://example.org/c', name: 'HEADLINE', source: 'PUBLISHER' },
        },
      ],
    });
    expect(post.body).toBe('read\nhttps://example.org/c');
  });

  it('refuses a non-http(s) url, leaving a link-only post empty', () => {
    const skip = oneSkip({
      // eslint-disable-next-line no-script-url -- refusing this exact scheme is the behaviour under test
      posts: [{ timestamp: TS, link: { url: 'javascript:alert(1)' } }],
    });
    expect(skip.reason).toBe('empty_post');
  });

  it('gives a different identity to two posts that differ only by link url', () => {
    // The url is framed into the id, so two otherwise-identical shares of
    // different pages are two posts, not one.
    const a = onePost({
      posts: [{ timestamp: TS, post: 'look', link: { url: 'https://example.org/a' } }],
    });
    const b = onePost({
      posts: [{ timestamp: TS, post: 'look', link: { url: 'https://example.org/b' } }],
    });
    expect([...a.sourceItemId]).not.toEqual([...b.sourceItemId]);
  });

  it('ignores a link whose url is not a string', () => {
    const post = onePost({ posts: [{ timestamp: TS, post: 'words', link: { url: 12345 } }] });
    expect(post.body).toBe('words');
  });

  it('ignores a link with no url key at all', () => {
    // Only a display name: Facebook's rendering, never the member's words.
    const post = onePost({ posts: [{ timestamp: TS, post: 'words', link: { name: 'HEADLINE' } }] });
    expect(post.body).toBe('words');
  });

  it('puts the link line after the text and still carries the media', () => {
    const post = onePost({
      posts: [
        {
          timestamp: TS,
          post: 'look',
          link: { url: 'https://example.org/a' },
          media: [{ name: 'p.jpg' }],
        },
      ],
    });
    expect(post.body).toBe('look\nhttps://example.org/a');
    expect(post.mediaUris).toEqual(['your_facebook_activity/posts/media/p.jpg']);
  });
});

describe('parseFacebookFile media', () => {
  it('keeps media uris in file order with their creation dates', () => {
    const post = onePost({
      posts: [
        {
          timestamp: TS,
          post: 'album',
          media: [{ name: 'one.jpg', creationTimestamp: TS - 10 }, { name: 'two.jpg' }],
        },
      ],
    });
    expect(post.mediaUris).toEqual([
      'your_facebook_activity/posts/media/one.jpg',
      'your_facebook_activity/posts/media/two.jpg',
    ]);
    expect(post.mediaDates).toEqual([(TS - 10) * 1000, null]);
  });

  it('imports a post whose media dates are out of range, stating no date for them', () => {
    // A media date is a DECORATION: it never gates the import and never
    // enters `source_item_id`, so an export that wrote nonsense beside a
    // photo has said nothing about the photo — the post still imports and
    // that one item simply states no date. Without the bounds check the
    // value rides on `ParsedMedia.originalDate` into #928, where
    // `new Date(…).toISOString()` throws a RangeError several layers from
    // the file that stated it.
    //
    // THREE values, because they fail at three different gates and any one
    // of them alone would leave the others untested:
    //  - `1e300` never reaches the window at all; `pickInteger` refuses it
    //    (`Number.isSafeInteger`), so the date is absent, not out of range;
    //  - `253_402_300_800` IS a safe integer (year 10000 in seconds) and is
    //    the only one of the three that exercises the window's upper bound;
    //  - `1_000_000_000` is 2001, below Facebook's own 2004 epoch — the
    //    lower bound, which the server applies too.
    const post = onePost({
      posts: [
        {
          timestamp: TS,
          post: 'an album with bad media dates',
          media: [
            { name: 'unsafe.jpg', creationTimestamp: 1e300 },
            { name: 'year10000.jpg', creationTimestamp: 253_402_300_800 },
            { name: 'before-facebook.jpg', creationTimestamp: 1_000_000_000 },
            { name: 'fine.jpg', creationTimestamp: TS - 10 },
          ],
        },
      ],
    });

    // The POST's own date is untouched by any of it.
    expect(post.originalDate).toBe(TS * 1000);
    expect(post.mediaUris).toHaveLength(4);
    expect(post.mediaDates).toEqual([null, null, null, (TS - 10) * 1000]);
  });

  it('treats a sticker as ordinary media', () => {
    // Facebook stickers live under the same allowlisted media root and carry
    // an ordinary `media.uri`; there is nothing to special-case, and the
    // pre-pass will sniff the bytes like any other image.
    const post = onePost({
      posts: [{ timestamp: TS, media: [{ name: 'sticker_1.png' }] }],
    });
    expect(post.mediaUris).toEqual(['your_facebook_activity/posts/media/sticker_1.png']);
  });

  it('gives the same identity to the same post in every export layout', () => {
    // The layouts differ only by uri prefix, and the id frames BASENAMES — a
    // member re-downloading into a renamed wrapper must not re-import.
    const spec = (layout: FbFileSpec['layout']): FbFileSpec => ({
      layout,
      posts: [{ timestamp: TS, post: 'same', media: [{ name: 'p.jpg' }] }],
    });
    const activity = onePost(spec('activity'));
    const across = onePost(spec('across'));
    const flat = onePost(spec('flat'));
    expect([...across.sourceItemId]).toEqual([...activity.sourceItemId]);
    expect([...flat.sourceItemId]).toEqual([...activity.sourceItemId]);
  });

  it('parses every layout, each carrying its own media uri prefix', () => {
    // The prefix is the only thing the layouts disagree about, and it rides
    // through to the pre-pass untouched (identity frames basenames, the uri
    // is what gets resolved against the archive).
    const spec = (layout: FbFileSpec['layout']): FbFileSpec => ({
      layout,
      posts: [{ timestamp: TS, post: 'same', media: [{ name: 'p.jpg' }] }],
    });
    expect(onePost(spec('activity')).mediaUris).toEqual([
      'your_facebook_activity/posts/media/p.jpg',
    ]);
    expect(onePost(spec('across')).mediaUris).toEqual([
      'your_activity_across_facebook/posts/media/p.jpg',
    ]);
    expect(onePost(spec('flat')).mediaUris).toEqual(['posts/media/p.jpg']);
  });

  it('ignores an attachments field that is not an array', () => {
    const post = onePost({ posts: [{ timestamp: TS, post: 'x', raw: { attachments: 'nope' } }] });
    expect(post.body).toBe('x');
    expect(post.mediaUris).toEqual([]);
  });

  it('ignores an attachment whose data is empty', () => {
    const post = onePost({
      posts: [{ timestamp: TS, post: 'x', raw: { attachments: [{ data: [] }] } }],
    });
    expect(post.body).toBe('x');
    expect(post.mediaUris).toEqual([]);
  });

  it('fails a post closed when an attachment claims media with no usable uri', () => {
    // Importing the post without the photo would be a SILENT partial import,
    // which is exactly what the hold obligation exists to prevent.
    const skip = oneSkip({
      posts: [{ timestamp: TS, post: 'x', raw: { attachments: [{ data: [{ media: {} }] }] } }],
    });
    expect(skip.reason).toBe('malformed_post');
    expect(skip.sourceItemId).toBeNull();
  });

  it('refuses a post with more media than the per-post ceiling', () => {
    const media = Array.from({ length: MAX_MEDIA_PER_POST + 1 }, (_unused, i) => ({
      name: `m${i}.jpg`,
    }));
    expect(oneSkip({ posts: [{ timestamp: TS, media }] }).reason).toBe('malformed_post');
  });

  it('imports a post with exactly the per-post media ceiling', () => {
    // The limit is "more than", so the boundary itself must pass.
    const media = Array.from({ length: MAX_MEDIA_PER_POST }, (_unused, i) => ({
      name: `m${i}.jpg`,
    }));
    expect(onePost({ posts: [{ timestamp: TS, media }] }).mediaUris).toHaveLength(
      MAX_MEDIA_PER_POST,
    );
  });
});

describe('parseFacebookFile fields that are never read', () => {
  it('ignores the generated title and the tag list entirely', () => {
    // The fixture WOULD change the outcome if either were read: the post has
    // no words and no media, so reading `title` would turn an empty post into
    // an imported one.
    const skip = oneSkip({
      posts: [{ timestamp: TS, title: 'Someone shared a post', tags: ['A Friend'] }],
    });
    expect(skip.reason).toBe('empty_post');
  });

  it('imports only the member’s words when a title is also present', () => {
    const post = onePost({
      posts: [{ timestamp: TS, post: 'mine', title: 'Someone shared a post' }],
    });
    expect(post.body).toBe('mine');
  });
});

describe('parseFacebookFile unsupported and empty posts', () => {
  it('reports a life-event-only post as unsupported_post_type, with an id', () => {
    const skip = oneSkip({ posts: [{ timestamp: TS, lifeEvent: true }] });
    expect(skip.reason).toBe('unsupported_post_type');
    expect(skip.sourceItemId).not.toBeNull();
  });

  it('reports an event-only post as unsupported_post_type', () => {
    expect(oneSkip({ posts: [{ timestamp: TS, event: true }] }).reason).toBe(
      'unsupported_post_type',
    );
  });

  it('imports the words of a post that also carries a life event', () => {
    const post = onePost({ posts: [{ timestamp: TS, post: 'moved house', lifeEvent: true }] });
    expect(post.body).toBe('moved house');
  });

  it('reports a post with nothing at all as empty_post', () => {
    expect(oneSkip({ posts: [{ timestamp: TS }] }).reason).toBe('empty_post');
  });

  it('ignores a data element whose post is not a string', () => {
    const post = onePost({
      posts: [{ timestamp: TS, raw: { data: [{ post: 42 }, { post: 'real' }] } }],
    });
    expect(post.body).toBe('real');
  });

  it('reports a post whose only data entry is a non-string as empty_post', () => {
    expect(oneSkip({ posts: [{ timestamp: TS, raw: { data: [{ post: 42 }] } }] }).reason).toBe(
      'empty_post',
    );
  });
});

describe('parseFacebookFile timestamps', () => {
  it('refuses an absent or non-integer timestamp with no id and no date', () => {
    const absent = oneSkip({ posts: [{ post: 'x' }] });
    expect(absent).toMatchObject({
      reason: 'missing_timestamp',
      sourceItemId: null,
      originalDate: null,
    });
    expect(oneSkip({ posts: [{ timestamp: '1600000000', post: 'x' }] }).reason).toBe(
      'missing_timestamp',
    );
  });

  it('refuses a zero or negative timestamp as invalid, not missing', () => {
    // Both are integers, so they get past the shape check and fail the date
    // window; "missing" would tell the member their file lacked a date.
    expect(oneSkip({ posts: [{ timestamp: 0, post: 'x' }] })).toMatchObject({
      reason: 'invalid_timestamp',
      sourceItemId: null,
      originalDate: null,
    });
    expect(oneSkip({ posts: [{ timestamp: -86_400, post: 'x' }] }).reason).toBe(
      'invalid_timestamp',
    );
  });

  it('refuses a fractional timestamp as missing', () => {
    expect(oneSkip({ posts: [{ timestamp: 1_600_000_000.5, post: 'x' }] }).reason).toBe(
      'missing_timestamp',
    );
  });

  it('refuses a post dated before Facebook existed', () => {
    const skip = oneSkip({ posts: [{ timestamp: 1_000_000_000, post: 'x' }] });
    expect(skip).toMatchObject({ reason: 'invalid_timestamp', originalDate: null });
  });

  it('bounds the future by the UTC calendar day, not the device’s local one', () => {
    // A member in UTC+13 is already on the 13th at 20:00 UTC on the 12th. The
    // server compares against ITS `dbUtcToday`, so the bound here is the UTC
    // day — a post stamped 20:00 UTC on the 12th imports, and the first
    // instant of the 13th UTC (13:00 local for that member) does not.
    const lastUtcInstant = Date.UTC(2026, 10, 12, 20, 0, 0) / 1000;
    expect(onePost({ posts: [{ timestamp: lastUtcInstant, post: 'x' }] }).originalDate).toBe(
      lastUtcInstant * 1000,
    );

    const nextUtcDay = Date.UTC(2026, 10, 13, 0, 0, 0) / 1000;
    expect(oneSkip({ posts: [{ timestamp: nextUtcDay, post: 'x' }] }).reason).toBe(
      'invalid_timestamp',
    );
  });

  it.each([
    ['a day that rolled over', '2026-02-31'],
    ['a day that is not one', 'tomorrow'],
  ])('admits nothing when nowUtcDay is %s', (_label, nowUtcDay) => {
    // `Date.UTC` rolls 2026-02-31 silently to 2026-03-03, and a bound that
    // moved on its own is worse than one that refuses. The alternative —
    // falling back to the device clock — would hide a caller bug behind
    // posts that import on one machine and not another, so an unusable
    // `nowUtcDay` admits NOTHING rather than something slightly wrong.
    // (`endOfUtcDayExclusive` is module-private, so this is the rule where a
    // caller can actually observe it.)
    expect(oneSkip({ posts: [{ timestamp: TS, post: 'x' }] }, { nowUtcDay }).reason).toBe(
      'invalid_timestamp',
    );
  });

  it('derives today from UTC, so the bound is the same on every device', () => {
    expect(todayUtcDay(Date.UTC(2026, 10, 12, 23, 59, 59))).toBe('2026-11-12');
    expect(todayUtcDay(Date.UTC(2026, 10, 13, 0, 0, 0))).toBe('2026-11-13');
  });
});

describe('parseFacebookFile file-level outcomes', () => {
  it('parses an empty array as ok with no items', () => {
    expect(parseFacebookFile('[]', CTX)).toEqual({ ok: true, items: [] });
  });

  it('reports a top level that is not an array as json_unparseable', () => {
    expect(parseFacebookFile('{"data":[]}', CTX)).toEqual({
      ok: false,
      reason: 'json_unparseable',
    });
  });

  it('reports unparseable text as json_unparseable', () => {
    expect(parseFacebookFile('[{', CTX)).toEqual({ ok: false, reason: 'json_unparseable' });
  });

  it('reports over-deep nesting as json_too_deep', () => {
    const deep = `${'['.repeat(40)}${']'.repeat(40)}`;
    expect(parseFacebookFile(deep, CTX)).toEqual({ ok: false, reason: 'json_too_deep' });
  });

  it('refuses a non-object element rather than throwing', () => {
    const result = parseFacebookFile('[42]', CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]).toMatchObject({ outcome: 'skip', reason: 'malformed_post' });
  });
});
