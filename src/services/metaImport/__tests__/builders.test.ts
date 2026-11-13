/**
 * Self-tests for the synthetic Meta-archive builders (#925).
 *
 * The parser tests in the next PR assert against what these builders produce,
 * so a builder that modelled the archive wrongly would make those tests agree
 * with a bug. These tests pin the builders against the ONE oracle that cannot
 * drift: the real `archiveAccess` policy layer, opened through the real
 * `openArchiveSession`. Nothing here hand-rolls a session.
 *
 * Every fixture value is INVENTED — this repo is public. See the directory
 * README.
 */

import * as fs from 'fs';
import * as path from 'path';

import { repairMojibake } from '../mojibake';
import {
  IG_LABELLED_JSON_PATH,
  RUST_EXTENSIONS,
  fbArchive,
  fbEntrySpecs,
  fbJsonPath,
  fbMediaUri,
  igFlat,
  igFlatEntrySpecs,
  igFlatJsonPath,
  igLabelled,
  igLabelledEntrySpecs,
  igMediaUri,
  mojibakeEscape,
  mp4Head,
  svgHead,
  unknownHead,
  buildArchive,
  type BuiltArchive,
  type FbLayout,
  type IgFlatLayout,
} from '../testUtils/builders';

beforeEach(() => {
  jest.clearAllMocks();
});

/** Read one built JSON entry back through the real session. */
async function readJsonText(archive: BuiltArchive, suffix: string): Promise<string> {
  const session = await archive.open();
  const outcome = await session.readEntryJson(archive.entryIdFor(suffix));
  if (!outcome.ok) throw new Error(`readEntryJson refused with ${outcome.skip}`);
  return outcome.text;
}

function parseArray(text: string): unknown[] {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error('built JSON is not a top-level array');
  return parsed;
}

// ---------------------------------------------------------------------------

/**
 * The Rust allowlist, read the same way `jsonSafety.test.ts` reads
 * `limits.rs`: from disk, so the Rust source IS the oracle rather than a
 * snapshot of it taken once.
 */
const ALLOWLIST_RS = path.join(
  __dirname,
  '../../../../packages/orbital-archive-reader/rust/orbital_archive_reader/src/allowlist.rs',
);

describe('the extension tables mirror allowlist.rs', () => {
  // These builders stand in for the REAL listing, and the real listing labels
  // an entry from `allowlist.rs`. The previous hand-copied lists disagreed
  // with it in three places — `.3gp` was an image here and a video there,
  // `.avi` was a video here and unclassified there, and anything unknown
  // defaulted to `image` — so a fixture could assert an import decision for
  // bytes the archive would never have offered, and the parser suites would
  // have agreed with the bug.
  let rust: string;

  beforeAll(() => {
    // Assert the file is there before reading it: a moved crate would
    // otherwise make this suite fail with a confusing ENOENT, or — worse, if
    // the read were guarded — pass by comparing against nothing.
    expect(fs.existsSync(ALLOWLIST_RS)).toBe(true);
    rust = fs.readFileSync(ALLOWLIST_RS, 'utf-8');
  });

  /** `const NAME: [&str; N] = ["a", "b"];` → its strings, with N checked. */
  function rustTable(name: string): string[] {
    const match = new RegExp(`const ${name}: \\[&str; (\\d+)\\] = \\[([^\\]]*)\\];`).exec(rust);
    expect(match).not.toBeNull();
    const [, declared, body] = match as RegExpExecArray;
    const items = [...body.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
    // Rust's own declared length, so a half-edited table cannot slip past.
    expect(items).toHaveLength(Number(declared));
    return items;
  }

  it.each([
    ['image', 'IMAGE_EXTS'],
    ['video', 'VIDEO_EXTS'],
  ] as const)('the %s table equals Rust’s %s, in order', (kind, constant) => {
    expect(RUST_EXTENSIONS[kind]).toEqual(rustTable(constant));
  });

  it('labels every extension in both tables the way Rust would', () => {
    // Textual parity is not enough on its own: the tables are exported for
    // this test, and `inferKind` reads the arrays behind them. This row is
    // what ties the two together.
    for (const ext of rustTable('IMAGE_EXTS')) {
      const [, media] = fbEntrySpecs({ posts: [{ post: 'x', media: [{ name: `a.${ext}` }] }] });
      expect(media.kind).toBe('image');
    }
    for (const ext of rustTable('VIDEO_EXTS')) {
      const [, media] = fbEntrySpecs({ posts: [{ post: 'x', media: [{ name: `a.${ext}` }] }] });
      expect(media.kind).toBe('video');
    }
  });

  it('throws rather than guess a kind for an extension in neither table', () => {
    // The throw is the point. An unrecognised extension is not an image, and
    // a builder that quietly called it one would let a test assert an import
    // decision for bytes the real archive refuses to list as media at all.
    expect(() => fbEntrySpecs({ posts: [{ post: 'x', media: [{ name: 'notes.txt' }] }] })).toThrow(
      /neither allowlist\.rs table/,
    );
    // `.svg` is the sharp one: the sniff table knows it, so it looks like an
    // image — but Rust's listing never labels one, and the real session
    // refuses its bytes as `ENTRY_SNIFF_INDETERMINATE`.
    expect(() => igFlatEntrySpecs({ posts: [{ media: [{ name: 'vector.svg' }] }] })).toThrow(
      /neither allowlist\.rs table/,
    );

    // Stating `kind` is the visible claim that gets past it — a fixture
    // saying "I know this is odd and it is the point", not a default.
    const specs = igFlatEntrySpecs({
      posts: [{ media: [{ name: 'vector.svg', kind: 'image' }] }],
    });
    expect(specs[1].kind).toBe('image');
  });
});

// ---------------------------------------------------------------------------

describe('listing shape', () => {
  it('lists exactly the JSON entry plus one entry per LISTED media', async () => {
    const archive = fbArchive({
      posts: [
        { timestamp: 1_700_000_000, post: 'first', media: [{ name: 'one.jpg' }] },
        {
          timestamp: 1_700_000_100,
          post: 'second',
          // `listed: false` is a uri with no entry; the duplicate is the same
          // photo in two posts and must collapse to one entry.
          media: [{ name: 'two.jpg' }, { name: 'one.jpg' }, { name: 'gone.jpg', listed: false }],
        },
      ],
    });

    expect(archive.entries.map((e) => e.path)).toEqual([
      fbJsonPath(),
      fbMediaUri('one.jpg'),
      fbMediaUri('two.jpg'),
    ]);

    const posts = parseArray(await readJsonText(archive, '.json'));
    expect(posts).toHaveLength(2);
  });

  it('round-trips the JSON text verbatim through the real session', async () => {
    const archive = fbArchive({ posts: [{ post: 'only' }] });
    const text = await readJsonText(archive, '.json');
    expect(text).toBe(JSON.stringify(parseArray(text)));
  });

  it.each<[FbLayout, string, string]>([
    [
      'activity',
      'your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_1.json',
      'your_facebook_activity/posts/media/a.jpg',
    ],
    [
      'across',
      'your_activity_across_facebook/posts/your_posts__check_ins__photos_and_videos_1.json',
      'your_activity_across_facebook/posts/media/a.jpg',
    ],
    ['flat', 'posts/your_posts_1.json', 'posts/media/a.jpg'],
  ])('puts the %s Facebook layout at its documented paths', (layout, json, media) => {
    const specs = fbEntrySpecs({ layout, posts: [{ post: 'x', media: [{ name: 'a.jpg' }] }] });
    expect(specs.map((s) => s.path)).toEqual([json, media]);
  });

  it.each<[IgFlatLayout, string]>([
    ['activity-media', 'your_instagram_activity/media/posts_1.json'],
    ['activity-content', 'your_instagram_activity/content/posts_1.json'],
    ['content', 'content/posts_1.json'],
    ['media', 'media/posts_1.json'],
  ])('puts the %s Instagram content file at its documented path', (layout, json) => {
    const specs = igFlatEntrySpecs({ layout, posts: [{ media: [{ name: 'a.jpg' }] }] });
    // The media path is root-relative and identical in all four layouts: that
    // is what lets one entry back a uri from the content AND labelled files.
    expect(specs.map((s) => s.path)).toEqual([json, 'media/posts/a.jpg']);
  });

  it('indexes Instagram part files like Facebook does', () => {
    expect(igFlatJsonPath(3, 'content')).toBe('content/posts_3.json');
  });

  it('builds the Instagram labelled file with NO media entries by default', async () => {
    const archive = igLabelled({
      posts: [
        {
          fbid: '100000000000001',
          timestamp: 1_700_000_200,
          coverMedia: [{ name: 'cover.jpg' }],
          childMedia: [{ name: 'child.jpg' }],
        },
      ],
    });
    // Its uris are the content file's files; listing them here would make
    // every reference URI_AMBIGUOUS once the two files are concatenated.
    expect(archive.entries.map((e) => e.path)).toEqual([IG_LABELLED_JSON_PATH]);

    const session = await archive.open();
    expect(session.resolveMediaUris([igMediaUri('cover.jpg')])).toEqual([
      { ok: false, skip: 'URI_UNRESOLVED' },
    ]);
  });

  it('lists the labelled file’s own media on request', () => {
    const specs = igLabelledEntrySpecs({
      listMedia: true,
      posts: [{ fbid: '1', coverMedia: [{ name: 'cover.jpg' }], childMedia: [{ name: 'c.mp4' }] }],
    });
    expect(specs.map((s) => s.path)).toEqual([
      IG_LABELLED_JSON_PATH,
      'media/posts/cover.jpg',
      'media/posts/c.mp4',
    ]);
    expect(specs[2].kind).toBe('video');
  });

  it('composes a content file and a labelled file into one archive', async () => {
    const archive = buildArchive([
      ...igFlatEntrySpecs({ posts: [{ media: [{ name: 'one.jpg' }] }] }),
      ...igLabelledEntrySpecs({ posts: [{ fbid: '7', coverMedia: [{ name: 'one.jpg' }] }] }),
    ]);
    expect(archive.entries.map((e) => e.path)).toEqual([
      'your_instagram_activity/media/posts_1.json',
      'media/posts/one.jpg',
      IG_LABELLED_JSON_PATH,
    ]);
    const session = await archive.open();
    // One entry, so the shared uri stays unambiguous across the two files.
    expect(session.resolveMediaUris([igMediaUri('one.jpg')])).toEqual([
      { ok: true, entryId: archive.entryIdFor('media/posts/one.jpg') },
    ]);
  });
});

describe('Instagram JSON shape', () => {
  it('omits an absent creation_timestamp rather than nulling it', async () => {
    const archive = igFlat({
      posts: [
        // A single-media post: no post-level timestamp, caption on the media.
        { media: [{ name: 'single.jpg', creationTimestamp: 1_700_000_300, title: 'a caption' }] },
        // A carousel: post-level timestamp present.
        { creationTimestamp: 1_700_000_400, title: 'carousel', media: [{ name: 'b.jpg' }] },
      ],
    });
    const posts = parseArray(await readJsonText(archive, 'posts_1.json'));
    expect(posts[0]).not.toHaveProperty('creation_timestamp');
    expect(posts[0]).not.toHaveProperty('title');
    expect(posts[1]).toMatchObject({ creation_timestamp: 1_700_000_400, title: 'carousel' });
    expect(posts[0]).toMatchObject({
      media: [
        {
          uri: 'media/posts/single.jpg',
          creation_timestamp: 1_700_000_300,
          title: 'a caption',
        },
      ],
    });
  });

  it('scatters the labelled file’s uris across two different depths', async () => {
    const archive = igLabelled({
      posts: [{ fbid: '42', coverMedia: [{ name: 'cover.jpg' }], childMedia: [{ name: 'c.jpg' }] }],
    });
    const text = await readJsonText(archive, 'posts.json');
    const [post] = parseArray(text) as [Record<string, unknown>];

    // Top level is present and empty: a reader that stops here sees no media.
    expect(post.media).toEqual([]);
    expect(post.fbid).toBe('42');

    const shallow = JSON.stringify(post.label_values).indexOf('cover.jpg');
    expect(shallow).toBeGreaterThan(-1);
    // The child uri exists only under label_values[].dict[].dict[].media[].
    expect(text).toContain('media/posts/c.jpg');
    expect(JSON.stringify((post.label_values as [{ media: unknown }])[0].media)).not.toContain(
      'c.jpg',
    );
  });

  it('writes the heavy subtrees only when withMetadata is set', async () => {
    const plain = await readJsonText(igFlat({ posts: [{ media: [{ name: 'p.jpg' }] }] }), '.json');
    expect(plain).not.toContain('exif_data');

    const heavy = await readJsonText(
      igFlat({ posts: [{ media: [{ name: 'p.jpg', withMetadata: true }] }] }),
      '.json',
    );
    // What the next PR's pruning reviver has to strip before anything is kept.
    expect(heavy).toContain('exif_data');
    expect(heavy).toContain('latitude');
    expect(heavy).toContain('media_variants');
  });

  it('merges raw last so a test can write a hostile shape', async () => {
    const archive = igFlat({
      posts: [{ creationTimestamp: 1, media: [{ name: 'a.jpg' }], raw: { media: 'not an array' } }],
    });
    const [post] = parseArray(await readJsonText(archive, '.json')) as [Record<string, unknown>];
    expect(post.media).toBe('not an array');
  });
});

describe('resolveMediaUris', () => {
  it('is 1:1 with its input and in input order', async () => {
    const archive = igFlat({
      posts: [{ media: [{ name: 'a.jpg' }, { name: 'b.jpg' }, { name: 'c.jpg' }] }],
    });
    const session = await archive.open();
    const uris = [igMediaUri('c.jpg'), igMediaUri('a.jpg'), igMediaUri('c.jpg')];
    expect(session.resolveMediaUris(uris)).toEqual([
      { ok: true, entryId: archive.entryIdFor('c.jpg') },
      { ok: true, entryId: archive.entryIdFor('a.jpg') },
      { ok: true, entryId: archive.entryIdFor('c.jpg') },
    ]);
  });

  it('refuses an unlisted uri and a listing-skipped entry identically', async () => {
    const archive = fbArchive({
      posts: [
        {
          post: 'x',
          media: [
            { name: 'absent.jpg', listed: false },
            { name: 'skipped.jpg', skip: 'ENTRY_OVER_CAP' },
            { name: 'fine.jpg' },
          ],
        },
      ],
    });
    const session = await archive.open();
    // A skipped entry is indistinguishable from one that was never there —
    // the caller learns nothing beyond "not available".
    expect(
      session.resolveMediaUris([
        fbMediaUri('absent.jpg'),
        fbMediaUri('skipped.jpg'),
        fbMediaUri('fine.jpg'),
      ]),
    ).toEqual([
      { ok: false, skip: 'URI_UNRESOLVED' },
      { ok: false, skip: 'URI_UNRESOLVED' },
      { ok: true, entryId: archive.entryIdFor('fine.jpg') },
    ]);
  });

  it('never resolves a JSON entry’s own path', async () => {
    const archive = fbArchive({ posts: [{ post: 'x', media: [{ name: 'a.jpg' }] }] });
    const session = await archive.open();
    expect(session.resolveMediaUris([fbJsonPath()])).toEqual([
      { ok: false, skip: 'URI_UNRESOLVED' },
    ]);
  });

  it('reports URI_AMBIGUOUS from the archive itself, with no override', async () => {
    // The `uriOverrides` row below FORCES the other three refusal codes
    // because no synthetic archive can produce them; this one is produced by
    // the archive. Two content files in one multi-part export each list
    // `media/posts/twin.jpg`, so the listing genuinely cannot say which
    // entry the uri means. Worth a row of its own: an override proves only
    // that the override is honoured, while this proves the resolver's own
    // ambiguity branch — and that the builders do NOT deduplicate across
    // files, which is what keeps that branch reachable at all.
    const archive = buildArchive([
      ...igFlatEntrySpecs({ index: 1, posts: [{ media: [{ name: 'twin.jpg' }] }] }),
      ...igFlatEntrySpecs({ index: 2, posts: [{ media: [{ name: 'twin.jpg' }] }] }),
    ]);
    expect(archive.entries.filter((entry) => entry.path === igMediaUri('twin.jpg'))).toHaveLength(
      2,
    );

    const session = await archive.open();
    expect(session.resolveMediaUris([igMediaUri('twin.jpg')])).toEqual([
      { ok: false, skip: 'URI_AMBIGUOUS' },
    ]);
  });

  it('forces the non-path refusals through uriOverrides', async () => {
    const outside = 'messages/inbox/secret.jpg';
    const archive = igFlat(
      { posts: [{ media: [{ name: 'a.jpg' }] }] },
      { uriOverrides: { [outside]: { ok: false, skip: 'URI_OUTSIDE_ALLOWLIST' } } },
    );
    const session = await archive.open();
    expect(session.resolveMediaUris([outside, igMediaUri('a.jpg')])).toEqual([
      { ok: false, skip: 'URI_OUTSIDE_ALLOWLIST' },
      { ok: true, entryId: archive.entryIdFor('a.jpg') },
    ]);
  });
});

describe('two archives in one test', () => {
  it('gives an opened archive its OWN entries, ids and bytes', async () => {
    const a = fbArchive({
      posts: [{ timestamp: 1_700_000_000, post: 'archive A', media: [{ name: 'a.jpg' }] }],
    });
    const b = igFlat({ posts: [{ media: [{ name: 'b.jpg', creationTimestamp: 1_700_000_000 }] }] });

    // Opened AFTER B was built, which is the whole point. `openArchive` is
    // ONE shared jest mock: armed at build time, the last archive built was
    // the one every later `open()` returned — including an earlier
    // archive's own — and a test comparing a session against the wrong
    // fixture passes or fails for reasons that have nothing to do with it.
    const session = await a.open();

    expect(session.entries.map((entry) => entry.path)).toEqual([fbJsonPath(), fbMediaUri('a.jpg')]);
    expect(session.resolveMediaUris([fbMediaUri('a.jpg')])).toEqual([
      { ok: true, entryId: a.entryIdFor('a.jpg') },
    ]);
    // And it knows nothing of B.
    expect(session.resolveMediaUris([igMediaUri('b.jpg')])).toEqual([
      { ok: false, skip: 'URI_UNRESOLVED' },
    ]);
    expect(await readJsonText(a, '.json')).toContain('archive A');

    // Entry ids come from a module-level counter that never restarts, so the
    // two archives share none. Restarting at `fp0:1` per build made a peek
    // memo, a dedup set or an `entryIdFor` lookup from the first silently
    // answer for the second — and the test would pass for the wrong reason.
    const aIds = new Set(a.entries.map((entry) => entry.entryId));
    expect(b.entries.some((entry) => aIds.has(entry.entryId))).toBe(false);
  });
});

describe('peekEntryKind through the real policy layer', () => {
  async function peek(archive: BuiltArchive, suffix: string) {
    const session = await archive.open();
    return session.peekEntryKind(archive.entryIdFor(suffix));
  }

  it('classifies a JPEG head as an image', async () => {
    const archive = igFlat({ posts: [{ media: [{ name: 'photo.jpg' }] }] });
    await expect(peek(archive, 'photo.jpg')).resolves.toEqual({
      ok: true,
      kind: 'image',
      contentType: 'image/jpeg',
    });
  });

  it('sniffs video bytes under an image name, not the extension', async () => {
    const archive = igFlat({ posts: [{ media: [{ name: 'surprise.jpg', head: mp4Head() }] }] });
    expect(archive.entries[1].kind).toBe('image');
    await expect(peek(archive, 'surprise.jpg')).resolves.toEqual({ ok: true, kind: 'video' });
  });

  it('holds a listed video even when the listing ALSO skipped it', async () => {
    // Production contract (e): the listed kind wins before the skip is
    // consulted, because holding the post reads no bytes. This is the reason
    // these fixtures go through the real module instead of a session fake.
    const archive = igFlat({
      posts: [{ media: [{ name: 'clip.mp4', kind: 'video', skip: 'ENTRY_OVER_CAP' }] }],
    });
    await expect(peek(archive, 'clip.mp4')).resolves.toEqual({ ok: true, kind: 'video' });
  });

  it('refuses an SVG head without falling back to the extension', async () => {
    const archive = igFlat({ posts: [{ media: [{ name: 'vector.jpg', head: svgHead() }] }] });
    await expect(peek(archive, 'vector.jpg')).resolves.toEqual({
      ok: false,
      skip: 'ENTRY_SNIFF_INDETERMINATE',
    });
  });

  it('refuses unrecognised bytes distinctly', async () => {
    const archive = igFlat({ posts: [{ media: [{ name: 'matroska.jpg', head: unknownHead() }] }] });
    await expect(peek(archive, 'matroska.jpg')).resolves.toEqual({
      ok: false,
      skip: 'ENTRY_SNIFF_INDETERMINATE',
    });
  });

  it('passes a READ-time skip through', async () => {
    const archive = igFlat({
      posts: [{ media: [{ name: 'torn.jpg', readSkip: 'ENTRY_CORRUPT' }] }],
    });
    await expect(peek(archive, 'torn.jpg')).resolves.toEqual({
      ok: false,
      skip: 'ENTRY_CORRUPT',
    });
  });
});

describe('mojibakeEscape', () => {
  it.each([
    ['accented', 'Café résumé — naïve'],
    ['emoji', 'party 🎉 time 👨‍👩‍👧'],
    ['pure ASCII', 'plain old text 123'],
  ])('is the exact inverse of repairMojibake for %s text', (_label, original) => {
    expect(repairMojibake(mojibakeEscape(original))).toBe(original);
  });

  it('leaves ASCII untouched on the way out', () => {
    expect(mojibakeEscape('abc')).toBe('abc');
  });

  it('actually mangles non-ASCII, so the repair under test has work to do', () => {
    expect(mojibakeEscape('é')).not.toBe('é');
  });
});
