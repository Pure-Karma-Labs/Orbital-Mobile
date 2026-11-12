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
import { fbJsonText, type FbFileSpec } from '../testUtils/builders';

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
      posts: [{ timestamp: TS, link: { url: 'javascript:alert(1)' } }],
    });
    expect(skip.reason).toBe('empty_post');
  });
});

describe('parseFacebookFile media', () => {
  it('keeps media uris in file order with their creation dates', () => {
    const post = onePost({
      posts: [
        {
          timestamp: TS,
          post: 'album',
          media: [
            { name: 'one.jpg', creationTimestamp: TS - 10 },
            { name: 'two.jpg' },
          ],
        },
      ],
    });
    expect(post.mediaUris).toEqual([
      'your_facebook_activity/posts/media/one.jpg',
      'your_facebook_activity/posts/media/two.jpg',
    ]);
    expect(post.mediaDates).toEqual([(TS - 10) * 1000, null]);
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

  it('derives today from UTC, so the bound is the same on every device', () => {
    expect(todayUtcDay(Date.UTC(2026, 10, 12, 23, 59, 59))).toBe('2026-11-12');
    expect(todayUtcDay(Date.UTC(2026, 10, 13, 0, 0, 0))).toBe('2026-11-13');
  });
});

describe('parseFacebookFile file-level outcomes', () => {
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
