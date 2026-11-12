/**
 * Synthetic Meta-archive builders for the import parser tests (#925).
 *
 * ## The oracle is the real policy layer
 *
 * These builders do NOT hand-roll an `ArchiveImportSession`. They fill the
 * existing jest manual mock's `makeMockArchiveSession` (which is the native
 * `ArchiveSession` shape) and then open it through the REAL
 * `openArchiveSession` from `archiveAccess.ts`. Every test therefore runs
 * against the production denied-root tripwire, the production sniff table and
 * — crucially for #925 — the production `peekEntryKind` ORDER contract (a
 * listed video wins before a listing skip is consulted, contract (e)). A
 * second hand-written session fake would be a second policy, and the thing
 * most worth testing would be the thing not under test.
 *
 * ## Everything here is SYNTHETIC
 *
 * The Orbital-Mobile repo is PUBLIC. No fixture in this directory is derived
 * from a real Meta export — not a caption, not a filename, not a timestamp.
 * The SHAPES were read from the two local sample exports; the CONTENT is
 * invented. See `README.md` in this directory.
 */

import {
  MOCK_TOKEN,
  makeMockArchiveSession,
  openArchive,
  type MockArchiveSession,
} from '../../../../__mocks__/orbital-archive-reader';
import { openArchiveSession } from '../archiveAccess';

import type {
  ArchiveEntry,
  ArchiveImportSession,
  ArchivePartToken,
  UriResolution,
} from '../archiveAccess';

// ---------------------------------------------------------------------------
// Media heads
// ---------------------------------------------------------------------------
//
// The 128-byte heads `peekHead` returns and `sniffContentType` classifies.
// Extracted from `archiveAccess.test.ts`, which now imports them from here:
// one definition, so a sniff-table change cannot be half-adopted.

/** JPEG SOI + first marker byte: what `sniffContentType` needs for image/jpeg. */
export const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** An `ftyp` box with major brand `isom`: video/mp4. */
export function mp4Head(): Uint8Array {
  const head = new Uint8Array(32);
  head[3] = 32; // box size
  head.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  head.set([0x69, 0x73, 0x6f, 0x6d], 8); // 'isom'
  return head;
}

/** SVG: an image by extension, NOT an image by sniff — `image/svg+xml`. */
export function svgHead(): Uint8Array {
  const text = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">';
  return new Uint8Array(Array.from(text, (c) => c.charCodeAt(0)));
}

/** Bytes no sniffer recognises: `ENTRY_SNIFF_INDETERMINATE` (WebM, MKV, junk). */
export function unknownHead(): Uint8Array {
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
}

// ---------------------------------------------------------------------------
// Mojibake
// ---------------------------------------------------------------------------

/**
 * Turn a synthetic string into the mojibake Meta's exporter would produce.
 *
 * Meta writes every non-ASCII character as a `\u00XX` escape of a UTF-8 BYTE,
 * so `JSON.parse` yields one code point per byte: `'é'` → `'Ã©'`. This is the
 * exact inverse of `repairMojibake`, which is why the mojibake tests can be
 * written in readable text rather than in escape soup.
 *
 * Deliberately hand-rolled rather than `encodeUtf8Strict`: a fixture builder
 * that shared the implementation under test could agree with it about a bug.
 */
export function mojibakeEscape(text: string): string {
  let out = '';
  for (const codePoint of text) {
    const cp = codePoint.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      out += String.fromCharCode(cp);
    } else if (cp < 0x800) {
      out += String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out += String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out += String.fromCharCode(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry specs
// ---------------------------------------------------------------------------

export interface EntrySpec {
  /** Archive-relative path AFTER the wrapper strip, as the listing reports it. */
  readonly path: string;
  /** Inferred from the extension when omitted. */
  readonly kind?: ArchiveEntry['kind'];
  /** JSON text, for `kind: 'json'`. */
  readonly text?: string;
  /** The ≤128-byte head `peekHead` returns. Defaults to `JPEG_HEAD` for images. */
  readonly head?: Uint8Array;
  /** A LISTING-time skip: Rust rejected this entry. */
  readonly skip?: ArchiveEntry['skip'];
  readonly declaredSize?: number;
  /** A READ-time skip: the entry is listed clean but `peekHead`/`readJson` fails. */
  readonly readSkip?: NonNullable<ArchiveEntry['skip']>;
}

export interface BuiltArchive {
  /** The listing, in the order it was built. */
  readonly entries: readonly ArchiveEntry[];
  /** The underlying jest mock, for call assertions and per-test overrides. */
  readonly mock: MockArchiveSession;
  readonly tokens: readonly ArchivePartToken[];
  /** Entry id of the first entry whose path ends with `suffix`. */
  entryIdFor(suffix: string): string;
  /** Open through the REAL policy layer. */
  open(): Promise<ArchiveImportSession>;
}

export interface BuildArchiveOptions {
  /**
   * Force a resolution for specific uris, bypassing the path match — the only
   * way to produce `URI_OUTSIDE_ALLOWLIST`, `URI_INVALID`,
   * `URI_UNSUPPORTED_KIND` or `URI_AMBIGUOUS` deterministically.
   */
  readonly uriOverrides?: Readonly<Record<string, UriResolution>>;
  readonly tokens?: readonly ArchivePartToken[];
  readonly rejectedCounts?: MockArchiveSession['rejectedCounts'];
}

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'];

function inferKind(path: string): ArchiveEntry['kind'] {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext)) ? 'video' : 'image';
}

/** Opaque, stable within one build. Tests must never parse this. */
function entryIdAt(ordinal: number): string {
  return `fp0:${ordinal}`;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Fill the mock session from entry specs and wire `openArchive` to resolve it.
 *
 * `resolveMediaUris` mirrors the native resolver's observable contract: 1:1
 * with the input, synchronous, and `URI_UNRESOLVED` for a uri whose target is
 * absent, was skipped at listing time, or is a JSON entry (the native resolver
 * never resolves JSON). Two matching entries are `URI_AMBIGUOUS`.
 */
export function buildArchive(
  specs: readonly EntrySpec[],
  options: BuildArchiveOptions = {},
): BuiltArchive {
  const tokens = options.tokens ?? [MOCK_TOKEN];
  const entries: ArchiveEntry[] = [];
  const texts = new Map<string, string>();
  const heads = new Map<string, Uint8Array>();
  const readSkips = new Map<string, NonNullable<ArchiveEntry['skip']>>();

  specs.forEach((spec, index) => {
    const kind = spec.kind ?? inferKind(spec.path);
    const entryId = entryIdAt(index + 1);
    const head = spec.head ?? (kind === 'image' ? JPEG_HEAD : mp4Head());
    const declaredSize =
      spec.declaredSize ?? (spec.text !== undefined ? utf8Length(spec.text) : 1024);

    entries.push({ entryId, path: spec.path, kind, declaredSize, skip: spec.skip ?? null });
    if (spec.text !== undefined) texts.set(entryId, spec.text);
    if (kind !== 'json') heads.set(entryId, head);
    if (spec.readSkip !== undefined) readSkips.set(entryId, spec.readSkip);
  });

  const byPath = new Map<string, ArchiveEntry[]>();
  for (const entry of entries) {
    const existing = byPath.get(entry.path);
    if (existing === undefined) byPath.set(entry.path, [entry]);
    else existing.push(entry);
  }

  const resolveOne = (uri: string): UriResolution => {
    const override = options.uriOverrides?.[uri];
    if (override !== undefined) return override;

    const matches = entries.filter((entry) => entry.path === uri || entry.path.endsWith(`/${uri}`));
    if (matches.length === 0) return { ok: false, skip: 'URI_UNRESOLVED' };
    if (matches.length > 1) return { ok: false, skip: 'URI_AMBIGUOUS' };
    const [match] = matches;
    // A skipped entry and a JSON entry are both unresolvable, and the caller
    // cannot tell either of them from "never in the archive".
    if (match.skip !== null || match.kind === 'json') {
      return { ok: false, skip: 'URI_UNRESOLVED' };
    }
    return { ok: true, entryId: match.entryId };
  };

  const mock = makeMockArchiveSession({
    parts: [...tokens],
    entries,
    rejectedCounts: options.rejectedCounts ?? {},
    resolveMediaUris: jest.fn((uris: readonly string[]) => uris.map(resolveOne)),
    readJson: jest.fn((entryId: string) => {
      const skip = readSkips.get(entryId);
      if (skip !== undefined) return Promise.resolve({ ok: false, skip });
      const text = texts.get(entryId);
      if (text === undefined) return Promise.resolve({ ok: false, skip: 'ENTRY_CORRUPT' });
      return Promise.resolve({ ok: true, text });
    }),
    peekHead: jest.fn((entryId: string) => {
      const skip = readSkips.get(entryId);
      if (skip !== undefined) return Promise.resolve({ ok: false, skip });
      const head = heads.get(entryId);
      if (head === undefined) return Promise.resolve({ ok: false, skip: 'ENTRY_CORRUPT' });
      return Promise.resolve({ ok: true, head });
    }),
    extractEntry: jest.fn((entryId: string) => {
      const head = heads.get(entryId) ?? JPEG_HEAD;
      return Promise.resolve({
        ok: true,
        path: `/staging/${entryId.replace(':', '-')}`,
        byteLength: head.length,
        head,
      });
    }),
  });

  openArchive.mockResolvedValue(mock);

  return {
    entries,
    mock,
    tokens,
    entryIdFor(suffix: string): string {
      const match = entries.find((entry) => entry.path.endsWith(suffix));
      if (match === undefined) throw new Error(`no built entry ends with ${suffix}`);
      return match.entryId;
    },
    open(): Promise<ArchiveImportSession> {
      return openArchiveSession(tokens);
    },
  };
}

// ---------------------------------------------------------------------------
// Facebook
// ---------------------------------------------------------------------------

/**
 * The three Facebook post-file layouts #925 detects.
 *
 * `activity` and `across` differ only in their root segment; `flat` is the
 * older `posts/your_posts_N.json` shape with media under `posts/media/`.
 */
export type FbLayout = 'activity' | 'across' | 'flat';

export interface FbMediaSpec {
  /** Basename inside the layout's media directory. */
  readonly name: string;
  readonly creationTimestamp?: number;
  /** Defaults to `JPEG_HEAD` for images, `mp4Head()` for videos. */
  readonly head?: Uint8Array;
  readonly kind?: ArchiveEntry['kind'];
  /** `false` ⇒ the uri appears in the JSON but no entry is listed. */
  readonly listed?: boolean;
  readonly skip?: ArchiveEntry['skip'];
  readonly readSkip?: NonNullable<ArchiveEntry['skip']>;
  /**
   * Include the real export's heavy subtrees (`media_metadata.photo_metadata.
   * exif_data` with GPS, `media_variants`, `ai_stickers`, `dubbing_info`) so
   * the pruning reviver has something to prune.
   */
  readonly withMetadata?: boolean;
}

export interface FbPostSpec {
  /** Epoch SECONDS. `null`/a string/omitted exercises the timestamp refusals. */
  readonly timestamp?: number | string | null;
  /** One or many `data[].post` strings. */
  readonly post?: string | readonly string[];
  /** FB's generated sentence. NEVER read by the parser — present to prove it. */
  readonly title?: string;
  /** Tagged people. NEVER read by the parser — present to prove it. */
  readonly tags?: readonly string[];
  readonly media?: readonly FbMediaSpec[];
  /** A shared link: only `url` is ever read. */
  readonly link?: { readonly url?: unknown; readonly name?: string; readonly source?: string };
  readonly lifeEvent?: boolean;
  readonly event?: boolean;
  /** Merged last, so a test can write any hostile shape it needs. */
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface FbFileSpec {
  readonly layout?: FbLayout;
  readonly posts: readonly FbPostSpec[];
  /** The `_N` suffix. Default 1. */
  readonly index?: number;
}

const FB_ROOTS: Readonly<Record<FbLayout, { json: (n: number) => string; media: string }>> = {
  activity: {
    json: (n) => `your_facebook_activity/posts/your_posts__check_ins__photos_and_videos_${n}.json`,
    media: 'your_facebook_activity/posts/media/',
  },
  across: {
    json: (n) =>
      `your_activity_across_facebook/posts/your_posts__check_ins__photos_and_videos_${n}.json`,
    media: 'your_activity_across_facebook/posts/media/',
  },
  flat: {
    json: (n) => `posts/your_posts_${n}.json`,
    media: 'posts/media/',
  },
};

/** The uri a Facebook post's JSON would carry for one media basename. */
export function fbMediaUri(name: string, layout: FbLayout = 'activity'): string {
  return `${FB_ROOTS[layout].media}${name}`;
}

/** The archive path of a Facebook post file. */
export function fbJsonPath(index = 1, layout: FbLayout = 'activity'): string {
  return FB_ROOTS[layout].json(index);
}

/** The heavy subtree a real export hangs off every photo. */
function fbMediaMetadata(): Readonly<Record<string, unknown>> {
  return {
    media_metadata: {
      photo_metadata: {
        exif_data: [
          {
            latitude: 37.7749,
            longitude: -122.4194,
            camera_make: 'SyntheticCam',
            camera_model: 'Fixture',
            taken_timestamp: 1_500_000_000,
            upload_ip: '203.0.113.7',
          },
        ],
      },
      camera_metadata: { has_camera_metadata: true },
    },
    media_variants: [{ uri: 'variant.jpg' }],
    ai_stickers: [{ id: 'sticker' }],
    dubbing_info: [{ language: 'en' }],
    cross_post_source: { source_app: 'FB' },
  };
}

function fbPostJson(post: FbPostSpec, layout: FbLayout): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (post.timestamp !== undefined && post.timestamp !== null) out.timestamp = post.timestamp;
  if (post.title !== undefined) out.title = post.title;
  if (post.tags !== undefined) out.tags = post.tags.map((name) => ({ name }));

  if (post.post !== undefined) {
    const parts = typeof post.post === 'string' ? [post.post] : post.post;
    out.data = parts.map((text) => ({ post: text }));
  }

  const attachments: Record<string, unknown>[] = [];
  for (const media of post.media ?? []) {
    attachments.push({
      data: [
        {
          media: {
            uri: fbMediaUri(media.name, layout),
            ...(media.creationTimestamp === undefined
              ? {}
              : { creation_timestamp: media.creationTimestamp }),
            title: '',
            description: '',
            ...(media.withMetadata === true ? fbMediaMetadata() : {}),
          },
        },
      ],
    });
  }
  if (post.link !== undefined) {
    const context: Record<string, unknown> = {};
    if (post.link.url !== undefined) context.url = post.link.url;
    if (post.link.name !== undefined) context.name = post.link.name;
    if (post.link.source !== undefined) context.source = post.link.source;
    attachments.push({ data: [{ external_context: context }] });
  }
  if (post.lifeEvent === true) {
    attachments.push({
      data: [
        {
          life_event: {
            title: 'Moved',
            place: { name: 'Somewhere', coordinate: { latitude: 1, longitude: 2 } },
          },
        },
      ],
    });
  }
  if (post.event === true) {
    attachments.push({
      data: [{ event: { name: 'A party', start_timestamp: 1, end_timestamp: 2 } }],
    });
  }
  if (attachments.length > 0) out.attachments = attachments;

  return { ...out, ...(post.raw ?? {}) };
}

/**
 * The JSON text of one Facebook post file, with no archive around it.
 *
 * The parsers are PURE — text in, decisions out — so a parser test wants this
 * and not a session. `fbEntrySpecs` builds on it, so the text a parser test
 * reads is byte-for-byte the text an end-to-end test would read back out of
 * the archive.
 */
export function fbJsonText(file: FbFileSpec): string {
  const layout = file.layout ?? 'activity';
  return JSON.stringify(file.posts.map((post) => fbPostJson(post, layout)));
}

/**
 * The entry specs for ONE Facebook post file plus its media.
 *
 * Composable: pass several files' specs to `buildArchive` for a multi-part or
 * multi-file test. Media entries are deduplicated by path, so two posts
 * sharing a photo produce one entry (and `resolveMediaUris` stays
 * unambiguous).
 */
export function fbEntrySpecs(file: FbFileSpec): EntrySpec[] {
  const layout = file.layout ?? 'activity';
  const specs: EntrySpec[] = [
    { path: fbJsonPath(file.index ?? 1, layout), kind: 'json', text: fbJsonText(file) },
  ];

  const seen = new Set<string>();
  for (const post of file.posts) {
    for (const media of post.media ?? []) {
      if (media.listed === false) continue;
      const path = fbMediaUri(media.name, layout);
      if (seen.has(path)) continue;
      seen.add(path);
      const kind = media.kind ?? inferKind(path);
      specs.push({
        path,
        kind,
        head: media.head ?? (kind === 'video' ? mp4Head() : JPEG_HEAD),
        ...(media.skip === undefined ? {} : { skip: media.skip }),
        ...(media.readSkip === undefined ? {} : { readSkip: media.readSkip }),
      });
    }
  }
  return specs;
}

/** One Facebook post file, built and ready to `open()`. */
export function fbArchive(file: FbFileSpec, options: BuildArchiveOptions = {}): BuiltArchive {
  return buildArchive(fbEntrySpecs(file), options);
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

/**
 * The four archive prefixes an Instagram content file is found under.
 *
 * Instagram's exporter has changed the wrapper twice, and all four shapes are
 * still in the wild — a detector that only knows the newest one silently
 * imports nothing from an older export, which looks exactly like "you had no
 * posts". Every prefix is therefore buildable.
 */
export type IgFlatLayout = 'activity-media' | 'activity-content' | 'content' | 'media';

const IG_FLAT_PREFIXES: Readonly<Record<IgFlatLayout, string>> = {
  'activity-media': 'your_instagram_activity/media/',
  'activity-content': 'your_instagram_activity/content/',
  content: 'content/',
  media: 'media/',
};

/** The single labelled file that is the only place an Instagram `fbid` lives. */
export const IG_LABELLED_JSON_PATH = 'your_instagram_activity/media/posts.json';

/**
 * The uri an Instagram post's JSON carries for one media basename.
 *
 * Unlike Facebook's, an Instagram uri is NOT relative to the content file's
 * own prefix: it is relative to the archive root, so the same
 * `media/posts/<name>` string appears in all four layouts and in the labelled
 * file. The entry path and the uri are therefore identical, which is what lets
 * one media entry back a reference from either file.
 */
export function igMediaUri(name: string): string {
  return `media/posts/${name}`;
}

/** The archive path of one Instagram per-part content file. */
export function igFlatJsonPath(index = 1, layout: IgFlatLayout = 'activity-media'): string {
  return `${IG_FLAT_PREFIXES[layout]}posts_${index}.json`;
}

export interface IgMediaSpec {
  /** Basename inside `media/posts/`. */
  readonly name: string;
  readonly creationTimestamp?: number;
  /** The per-media caption. A single-media post's caption lives HERE, not on the post. */
  readonly title?: string;
  /** Defaults to `JPEG_HEAD` for images, `mp4Head()` for videos. */
  readonly head?: Uint8Array;
  readonly kind?: ArchiveEntry['kind'];
  /** `false` ⇒ the uri appears in the JSON but no entry is listed. */
  readonly listed?: boolean;
  readonly skip?: ArchiveEntry['skip'];
  readonly readSkip?: NonNullable<ArchiveEntry['skip']>;
  /**
   * Include the real export's heavy subtrees (`media_metadata.photo_metadata.
   * exif_data` with GPS, `media_variants`, `dubbing_info`, `cross_post_source`)
   * so the pruning reviver has something to prune.
   */
  readonly withMetadata?: boolean;
}

export interface IgPostSpec {
  /**
   * Epoch SECONDS. Present on carousels, ABSENT on single-media posts — which
   * is why it is omitted rather than nulled when the spec field is undefined:
   * the parser's fallback to `media[0].creation_timestamp` only fires on a
   * genuinely missing key.
   */
  readonly creationTimestamp?: number;
  /** The post-level caption. Carousels carry it here; single-media posts do not. */
  readonly title?: string;
  /**
   * The stored order, NOT the display order: Instagram writes a carousel's
   * children reversed. A test modelling a carousel lists them the way the
   * archive holds them, so the parser's un-reversal is observable.
   */
  readonly media?: readonly IgMediaSpec[];
  /** Merged last, so a test can write any hostile shape it needs. */
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface IgFlatFileSpec {
  readonly layout?: IgFlatLayout;
  readonly posts: readonly IgPostSpec[];
  /** The `_N` suffix. Default 1. */
  readonly index?: number;
}

/** The heavy subtree a real Instagram export hangs off every photo. */
function igMediaMetadata(): Readonly<Record<string, unknown>> {
  return {
    media_metadata: {
      photo_metadata: {
        exif_data: [
          {
            latitude: 41.8781,
            longitude: -87.6298,
            device_id: 'synthetic-device',
            source_type: 'library',
            date_time_original: '2021:03:04 11:22:33',
          },
        ],
      },
      camera_metadata: { has_camera_metadata: false },
    },
    media_variants: [{ uri: 'variant.jpg', width: 640, height: 640 }],
    dubbing_info: [{ language: 'en', is_dubbed: false }],
    cross_post_source: { source_app: 'IG' },
  };
}

function igMediaJson(media: IgMediaSpec): Record<string, unknown> {
  return {
    uri: igMediaUri(media.name),
    ...(media.creationTimestamp === undefined
      ? {}
      : { creation_timestamp: media.creationTimestamp }),
    ...(media.title === undefined ? {} : { title: media.title }),
    ...(media.withMetadata === true ? igMediaMetadata() : {}),
  };
}

function igPostJson(post: IgPostSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (post.creationTimestamp !== undefined) out.creation_timestamp = post.creationTimestamp;
  if (post.title !== undefined) out.title = post.title;
  if (post.media !== undefined) out.media = post.media.map(igMediaJson);
  return { ...out, ...(post.raw ?? {}) };
}

/**
 * Append one entry spec per LISTED media item, deduplicated by path.
 *
 * Two posts sharing a photo must produce ONE entry, or `resolveMediaUris`
 * would answer `URI_AMBIGUOUS` for a reference the real archive resolves.
 */
function pushIgMediaSpecs(
  specs: EntrySpec[],
  seen: Set<string>,
  media: readonly IgMediaSpec[],
): void {
  for (const item of media) {
    if (item.listed === false) continue;
    const path = igMediaUri(item.name);
    if (seen.has(path)) continue;
    seen.add(path);
    const kind = item.kind ?? inferKind(path);
    specs.push({
      path,
      kind,
      head: item.head ?? (kind === 'video' ? mp4Head() : JPEG_HEAD),
      ...(item.skip === undefined ? {} : { skip: item.skip }),
      ...(item.readSkip === undefined ? {} : { readSkip: item.readSkip }),
    });
  }
}

/** The JSON text of one Instagram per-part content file (see `fbJsonText`). */
export function igFlatJsonText(file: IgFlatFileSpec): string {
  return JSON.stringify(file.posts.map(igPostJson));
}

/**
 * The entry specs for ONE Instagram per-part content file plus its media.
 *
 * Composable with `igLabelledEntrySpecs` and with other files' specs: pass the
 * concatenation to `buildArchive`. The media entries belong to THIS file, so
 * a labelled file concatenated alongside must not list them again.
 */
export function igFlatEntrySpecs(file: IgFlatFileSpec): EntrySpec[] {
  const layout = file.layout ?? 'activity-media';
  const specs: EntrySpec[] = [
    { path: igFlatJsonPath(file.index ?? 1, layout), kind: 'json', text: igFlatJsonText(file) },
  ];
  const seen = new Set<string>();
  for (const post of file.posts) pushIgMediaSpecs(specs, seen, post.media ?? []);
  return specs;
}

/** One Instagram content file, built and ready to `open()`. */
export function igFlat(file: IgFlatFileSpec, options: BuildArchiveOptions = {}): BuiltArchive {
  return buildArchive(igFlatEntrySpecs(file), options);
}

export interface IgLabelledPostSpec {
  /** The only identifier that survives an Instagram export. */
  readonly fbid: string;
  /** Epoch SECONDS. */
  readonly timestamp?: number;
  /** Media directly under `label_values[].media[]` — the post's cover. */
  readonly coverMedia?: readonly IgMediaSpec[];
  /** Media two dicts deeper, under `label_values[].dict[].dict[].media[]`. */
  readonly childMedia?: readonly IgMediaSpec[];
  /** Merged last, so a test can write any hostile shape it needs. */
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface IgLabelledFileSpec {
  readonly posts: readonly IgLabelledPostSpec[];
  /**
   * List entries for this file's uris too.
   *
   * Off by default, because a labelled file's uris are the SAME files the
   * content file lists — listing them twice would make every reference
   * `URI_AMBIGUOUS`. Turn it on for a labelled file built alone, or to model a
   * cover uri that the content file never mentions.
   */
  readonly listMedia?: boolean;
}

function igLabelledPostJson(post: IgLabelledPostSpec): Record<string, unknown> {
  const children = post.childMedia ?? [];
  const out: Record<string, unknown> = {
    fbid: post.fbid,
    ...(post.timestamp === undefined ? {} : { timestamp: post.timestamp }),
    // Present and empty in the real export: the media hangs off label_values,
    // so a reader that only looks here finds nothing and reports no media.
    media: [],
    label_values: [
      {
        label: 'Shared post',
        media: (post.coverMedia ?? []).map(igMediaJson),
        dict: [
          {
            label: 'Items',
            title: 'Items in this post',
            value: '',
            dict: children.map((child, i) => ({
              label: `Item ${i + 1}`,
              ...(child.title === undefined ? {} : { title: child.title }),
              value: 'shared',
              ...(child.creationTimestamp === undefined
                ? {}
                : { timestamp_value: child.creationTimestamp }),
              media: [igMediaJson(child)],
              vec: [{ value: 'synthetic' }],
              dict: [{ label: 'Source', value: 'synthetic' }],
            })),
          },
        ],
      },
    ],
  };
  return { ...out, ...(post.raw ?? {}) };
}

/** The JSON text of the labelled `posts.json` (see `fbJsonText`). */
export function igLabelledJsonText(file: IgLabelledFileSpec): string {
  return JSON.stringify(file.posts.map(igLabelledPostJson));
}

/**
 * The entry specs for the single labelled `posts.json`.
 *
 * Its uris sit at two different depths on purpose: the cover under
 * `label_values[].media[]` and the children under
 * `label_values[].dict[].dict[].media[]`. A consumer that walks only one of
 * those depths demonstrably loses the other's media, which is the whole reason
 * this file needs a recursive walk rather than a path.
 */
export function igLabelledEntrySpecs(file: IgLabelledFileSpec): EntrySpec[] {
  const specs: EntrySpec[] = [
    { path: IG_LABELLED_JSON_PATH, kind: 'json', text: igLabelledJsonText(file) },
  ];
  if (file.listMedia === true) {
    const seen = new Set<string>();
    for (const post of file.posts) {
      pushIgMediaSpecs(specs, seen, post.coverMedia ?? []);
      pushIgMediaSpecs(specs, seen, post.childMedia ?? []);
    }
  }
  return specs;
}

/** One Instagram labelled file, built and ready to `open()`. */
export function igLabelled(
  file: IgLabelledFileSpec,
  options: BuildArchiveOptions = {},
): BuiltArchive {
  return buildArchive(igLabelledEntrySpecs(file), options);
}
