/**
 * Pure FB/IG spec types, path/uri helpers and *JsonText producers.
 *
 * Extracted from builders.ts so smokeArchive.ts and the CLI can generate
 * valid archive JSON without importing archiveAccess or any __mocks__.
 *
 * ## Constraints
 *
 * - Dependency-free: NO imports — this leaf is loaded by both Jest and the
 *   Node --experimental-strip-types CLI.
 * - Erasable syntax only: `import type`, no enums, no namespaces, no
 *   parameter properties.
 * - No `node:crypto` (invariant 30) and no `node:*` at all.
 *
 * ## Local type mirrors
 *
 * `FbMediaSpec` and `IgMediaSpec` carry the same `kind`/`skip`/`readSkip`
 * fields that builders.ts adds to EntrySpec: they mirror the Rust-crate types
 * so builders.ts can re-export them with no structural change. The mirrors are
 * private; callers that need the archive-reader nominal types should import
 * from archiveAccess directly.
 */

// ---------------------------------------------------------------------------
// Local mirrors of archive-reader types
// ---------------------------------------------------------------------------
//
// These replicate the unions from packages/orbital-archive-reader/src/index.tsx
// EXACTLY so that builders.ts can re-export FbMediaSpec/IgMediaSpec unchanged
// and TypeScript structural typing stays satisfied. If the crate adds a new
// skip code, update BOTH this list AND the crate's RustEntrySkipCode.

type _EntryKind = 'json' | 'image' | 'video';

type _RustEntrySkipCode =
  | 'ENTRY_PATH_INVALID'
  | 'ENTRY_PATH_TRAVERSAL'
  | 'ENTRY_SYMLINK'
  | 'ENTRY_SPECIAL_FILE'
  | 'ENTRY_ENCRYPTED'
  | 'ENTRY_NESTED_ARCHIVE'
  | 'ENTRY_UNSUPPORTED_METHOD'
  | 'ENTRY_DUPLICATE'
  | 'ENTRY_OVER_CAP'
  | 'ENTRY_RATIO_EXCEEDED'
  | 'ENTRY_CORRUPT'
  | 'ENTRY_KIND_NOT_ENABLED'
  | 'ENTRY_KIND_MISMATCH'
  | 'ENTRY_NOT_UTF8'
  | 'ENTRY_NOT_ALLOWLISTED';

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
  readonly kind?: _EntryKind;
  /** `false` ⇒ the uri appears in the JSON but no entry is listed. */
  readonly listed?: boolean;
  readonly skip?: _RustEntrySkipCode | null;
  /**
   * Include the real export's heavy subtrees (`media_metadata.photo_metadata.
   * exif_data` with GPS, `media_variants`, `ai_stickers`, `dubbing_info`) so
   * the pruning reviver has something to prune.
   */
  readonly withMetadata?: boolean;
  /** A READ-time skip: the entry is listed clean but `peekHead`/`readJson` fails. */
  readonly readSkip?: _RustEntrySkipCode;
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
  readonly kind?: _EntryKind;
  /** `false` ⇒ the uri appears in the JSON but no entry is listed. */
  readonly listed?: boolean;
  readonly skip?: _RustEntrySkipCode | null;
  /** A READ-time skip: the entry is listed clean but `peekHead`/`readJson` fails. */
  readonly readSkip?: _RustEntrySkipCode;
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
   * The order the archive stores the post's media in — which is also the order
   * the parser hands on (Alex, 2026-11-12: the export states nothing about
   * display order, so it is kept exactly as written).
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

/** The JSON text of one Instagram per-part content file (see `fbJsonText`). */
export function igFlatJsonText(file: IgFlatFileSpec): string {
  return JSON.stringify(file.posts.map(igPostJson));
}

// ---------------------------------------------------------------------------
// Instagram labelled
// ---------------------------------------------------------------------------

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
