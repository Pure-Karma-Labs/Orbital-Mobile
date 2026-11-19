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
  EntryKind as _ArchiveEntryKind,
  RustEntrySkipCode as _ArchiveSkipCode,
  UriResolution,
} from '../archiveAccess';

// Import the pure JSON functions for internal use by fbEntrySpecs /
// igFlatEntrySpecs / igLabelledEntrySpecs.
import {
  JPEG_HEAD,
  IG_LABELLED_JSON_PATH,
  fbJsonPath,
  fbJsonText,
  fbMediaUri,
  igFlatJsonPath,
  igFlatJsonText,
  igLabelledJsonText,
  igMediaUri,
  mp4Head,
} from './metaJson';

import type {
  FbFileSpec,
  IgFlatFileSpec,
  IgLabelledFileSpec,
  IgMediaSpec,
  MetaEntryKind,
  MetaRustEntrySkipCode,
} from './metaJson';

// C5: two-way assignability check — if the crate adds OR removes a skip code or
// kind, one of these assignments becomes `never` and tsc fails. These
// declarations are purely type-level; the initialiser is unreachable.
declare const _metaKindFwd: MetaEntryKind extends _ArchiveEntryKind ? true : never;
declare const _metaKindBwd: _ArchiveEntryKind extends MetaEntryKind ? true : never;
declare const _metaSkipFwd: MetaRustEntrySkipCode extends _ArchiveSkipCode ? true : never;
declare const _metaSkipBwd: _ArchiveSkipCode extends MetaRustEntrySkipCode ? true : never;

// Re-export all types and helpers so callers can import from builders.ts
// unchanged. smokeArchive.ts and the CLI import from metaJson.ts directly to
// stay free of the archiveAccess / __mocks__ dependency graph.
// C3: JPEG_HEAD and mp4Head are now defined in metaJson.ts; re-exported here
// so existing callers (archiveAccess.test.ts etc.) need no import changes.
export {
  JPEG_HEAD,
  IG_LABELLED_JSON_PATH,
  fbJsonPath,
  fbJsonText,
  fbMediaUri,
  igFlatJsonPath,
  igFlatJsonText,
  igLabelledJsonText,
  igMediaUri,
  mp4Head,
  type FbFileSpec,
  type FbLayout,
  type FbMediaSpec,
  type FbPostSpec,
  type IgFlatFileSpec,
  type IgFlatLayout,
  type IgLabelledFileSpec,
  type IgLabelledPostSpec,
  type IgMediaSpec,
  type IgPostSpec,
} from './metaJson';

// ---------------------------------------------------------------------------
// Media heads
// ---------------------------------------------------------------------------
//
// The 128-byte heads `peekHead` returns and `sniffContentType` classifies.
// Canonical definitions live in metaJson.ts (C3); re-exported above.
// svgHead and unknownHead remain here — they have no duplicate in smokeArchive.

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
 * Re-exported from its own leaf module so the three pure-text suites can take
 * it without pulling the archive mock graph in behind it.
 */
export { mojibakeEscape } from './mojibakeEscape';

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

/**
 * The Rust extension classifier, mirrored exactly.
 *
 * `allowlist.rs`'s `IMAGE_EXTS` and `VIDEO_EXTS` are what the REAL listing
 * uses to label an entry, and these builders exist to stand in for that
 * listing. The previous lists disagreed with it in three places — `.3gp` was
 * an image here and a video in Rust, `.avi` was a video here and unclassified
 * there, and anything unrecognised defaulted to `image` — so a fixture could
 * assert a decision the real archive would never offer. `builders.test.ts`
 * reads `allowlist.rs` and asserts these tables equal it, the same way
 * `jsonSafety.test.ts` reads `limits.rs`.
 */
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'avif', 'gif'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', '3gp', 'webm', 'mkv'];

/** The two tables, for the parity test. Extensions WITHOUT the dot. */
export const RUST_EXTENSIONS: Readonly<Record<'image' | 'video', readonly string[]>> = {
  image: IMAGE_EXTENSIONS,
  video: VIDEO_EXTENSIONS,
};

/**
 * Which kind the listing would give this path — or a THROW.
 *
 * Throwing is the point. An unrecognised extension is not an image, and a
 * builder that quietly called it one would let a test assert an import
 * decision for bytes the real archive refuses to list as media at all. A
 * fixture that really wants an odd name states `kind` explicitly, which is a
 * visible claim rather than a default.
 */
function inferKind(path: string): ArchiveEntry['kind'] {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot === -1 ? '' : lower.slice(dot + 1);
  if (ext === 'json') return 'json';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  throw new Error(
    `builders: cannot infer a kind for \`${path}\` — \`.${ext}\` is in neither allowlist.rs table; state \`kind\` explicitly if that is the point of the fixture`,
  );
}

/**
 * Opaque, and unique across every archive built in one test FILE.
 *
 * Restarting at `fp0:1` per build made two live archives share entry ids: a
 * peek memo, a dedup set or an `entryIdFor` lookup from the first would
 * silently answer for the second, and the test would pass for the wrong
 * reason. The counter is module-level and never resets — ids are opaque, so
 * nothing may depend on their values anyway.
 */
let nextEntryOrdinal = 1;

function nextEntryId(): string {
  return `fp0:${nextEntryOrdinal++}`;
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

  specs.forEach((spec) => {
    const kind = spec.kind ?? inferKind(spec.path);
    const entryId = nextEntryId();
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
      // Armed HERE, not at build time. `openArchive` is one shared jest mock,
      // so arming it at build made the LAST archive built the one every
      // subsequent `open()` returned — including an earlier archive's own.
      openArchive.mockResolvedValue(mock);
      return openArchiveSession(tokens);
    },
  };
}

// ---------------------------------------------------------------------------
// Facebook — entry specs (archive-dependent layer; JSON types in metaJson.ts)
// ---------------------------------------------------------------------------

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
// Instagram — entry specs (archive-dependent layer; JSON types in metaJson.ts)
// ---------------------------------------------------------------------------

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
