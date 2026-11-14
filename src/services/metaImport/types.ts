/**
 * The Meta import parser's type surface (#925).
 *
 * Everything the parser hands to #921 (SQLite), #926 (the run) and #928 (UI)
 * is declared here, including the pieces PR 2 fills in (`parseArchive`'s
 * options and summary). Nothing in this file imports anything: it is a
 * contract, and a contract that drags in the archive reader, crypto or the
 * store is one the other issues cannot depend on cheaply.
 *
 * ## Two classes of string live in these types
 *
 *  - `sourceItemId` is **plaintext-class** (see `ParsedPost`).
 *  - `sourceFile` and `sourceIndex` are **local-UI-class**: a basename out of
 *    the user's own export, carried so #928 can tell them WHICH item did not
 *    migrate (Alex, 2026-10-19). F18 applies — never telemetry, never an error
 *    message, never a request body.
 */

/** Which platform's export a file came from. */
export type ImportSource = 'facebook' | 'instagram';

/**
 * Why one post was not imported.
 *
 * The first six are the media holds (#983's hold obligation): a post whose
 * media cannot be POSITIVELY classified as an image is held whole, never
 * partially imported. The rest are content-level refusals.
 */
export type SkipReason =
  | 'held_video'
  | 'unsupported_image_format'
  | 'image_too_large'
  | 'media_missing'
  | 'media_unsupported_reference'
  | 'media_unreadable'
  | 'unsupported_post_type'
  | 'empty_post'
  | 'text_too_long'
  | 'invalid_timestamp'
  | 'missing_timestamp'
  | 'duplicate_in_archive'
  | 'malformed_post';

/**
 * What #928 tells the member they can DO about a skip.
 *
 *  - `held`: nothing is wrong — the content is simply not importable. "Keep
 *    your export."
 *  - `incomplete`: the archive they selected was missing a piece. "Select
 *    every ZIP part."
 *  - `permanent`: re-running the import changes nothing.
 */
export type SkipReasonClass = 'held' | 'incomplete' | 'permanent';

/**
 * Exhaustive by construction (`Record`, not `Partial<Record>`): a new
 * `SkipReason` that nobody classified is a compile error here rather than an
 * uncategorised row in the UI.
 */
export const SKIP_REASON_CLASS: Readonly<Record<SkipReason, SkipReasonClass>> = {
  held_video: 'held',
  media_missing: 'incomplete',
  unsupported_image_format: 'permanent',
  // Permanent on purpose, and that is why the pixel ceiling is ONE global
  // number: a device-dependent ceiling would make "re-running the import
  // changes nothing" false, since the same archive would import differently
  // on a newer phone.
  image_too_large: 'permanent',
  media_unsupported_reference: 'permanent',
  media_unreadable: 'permanent',
  unsupported_post_type: 'permanent',
  empty_post: 'permanent',
  text_too_long: 'permanent',
  invalid_timestamp: 'permanent',
  missing_timestamp: 'permanent',
  duplicate_in_archive: 'permanent',
  malformed_post: 'permanent',
};

/**
 * Why one JSON FILE (not one post) could not be used.
 *
 * File issues are reported in `ParseSummary.fileIssues`; the posts inside an
 * unusable file produce no items at all, so a member who sees "0 posts" from a
 * file that clearly had some gets a reason.
 */
export type FileIssueReason =
  | 'json_too_large'
  | 'json_too_deep'
  | 'json_unparseable'
  | 'json_entry_skipped'
  | 'json_too_many_media'
  | 'archive_too_large';

export interface FileIssue {
  /** JSON basename. LOCAL UI ONLY (F18). */
  readonly sourceFile: string;
  readonly reason: FileIssueReason;
}

/**
 * One media item that survived the pre-pass.
 *
 * There is deliberately **no content type**: the only label that may ever be
 * persisted or uploaded is the post-extract `contentType` from
 * `extractImageEntry`, which describes bytes that are actually on disk. The
 * pre-pass's peek verdict is a hold/import decision and nothing else.
 */
export interface ParsedMedia {
  /** Opaque archive entry id. Never parsed, split or derived from. */
  readonly entryId: string;
  /** Media creation time, epoch ms UTC, when the export stated one. */
  readonly originalDate: number | null;
}

/**
 * The `kind` BYTE of the v1 frame (`sourceItemId.ts`), carried per item.
 *
 * `1` is the content frame, `2` the Instagram `fbid`. These are the wire
 * numbers, not a second enum: #921 persists them as `id_kind`, and a member
 * whose next export flips scheme is diagnosable from the stored rows alone —
 * without the alternative, which would be reading byte 1 of a plaintext-class
 * `sourceItemId` nobody is allowed to persist.
 *
 * `IdScheme` remains the parser-internal spelling; `ID_KIND_BY_SCHEME` is the
 * only translation.
 */
export type IdKind = 1 | 2;

/**
 * A post that is importable.
 *
 * ## `sourceItemId` is PLAINTEXT-CLASS
 *
 * The v1 framing (see `sourceItemId.ts`) embeds the post's repaired text
 * verbatim, so these bytes ARE the member's content. They must never be
 * logged, never appear in an error message, a breadcrumb, a Sentry frame or a
 * request body, and never be persisted. The only thing derived from them that
 * leaves the parser is the 16-byte `import_key` (#924), which is what #921
 * stores and what the server dedups on.
 */
export interface ParsedPost {
  readonly outcome: 'import';
  readonly source: ImportSource;
  /** JSON basename. LOCAL UI ONLY (F18). */
  readonly sourceFile: string;
  /** Index of the post within its source file, for #928's per-item list. */
  readonly sourceIndex: number;
  /** PLAINTEXT-CLASS — see the class note above. */
  readonly sourceItemId: Uint8Array;
  /** Which scheme minted `sourceItemId`. Never null: the id is never null. */
  readonly idKind: IdKind;
  /** Epoch ms UTC. Always present on an importable post. */
  readonly originalDate: number;
  /** NFC-normalised, newline-normalised, trimmed, link line appended. */
  readonly body: string;
  readonly media: readonly ParsedMedia[];
}

/**
 * A post that will not be imported, and why.
 *
 * `sourceItemId` is present whenever the post could be FRAMED, because #921
 * requires a held item to carry its `import_key` from parse time — the same
 * identity the eventual retry would mint. It is `null` for exactly the refusals
 * that happen before a frame exists:
 *
 *  - `malformed_post` — the text or the media list could not be framed
 *    injectively (an unpaired surrogate, a media attachment with no uri, text
 *    over the raw floor);
 *  - `missing_timestamp` / `invalid_timestamp` — the v1 content frame takes a
 *    timestamp, and a post the server would refuse outright has no identity
 *    worth minting.
 *
 * Everything else — including every media hold, `text_too_long`, `empty_post`
 * and `unsupported_post_type` — carries its id.
 */
export interface ParsedSkip {
  readonly outcome: 'skip';
  readonly source: ImportSource;
  /** JSON basename. LOCAL UI ONLY (F18). */
  readonly sourceFile: string;
  readonly sourceIndex: number;
  /**
   * PLAINTEXT-CLASS, `null` for exactly the three pre-frame refusals listed
   * above: `malformed_post`, `missing_timestamp`, `invalid_timestamp`.
   */
  readonly sourceItemId: Uint8Array | null;
  /** Which scheme minted the id. `null` exactly when `sourceItemId` is. */
  readonly idKind: IdKind | null;
  /** Epoch ms UTC, `null` when the export stated none or stated nonsense. */
  readonly originalDate: number | null;
  readonly reason: SkipReason;
}

export type ParsedItem = ParsedPost | ParsedSkip;

// ---------------------------------------------------------------------------
// The parser → pre-pass seam
// ---------------------------------------------------------------------------
//
// `facebookParser` and `instagramParser` are PURE: text in, decisions out. They
// never touch the archive session, so they cannot know whether a uri resolves,
// whether its bytes are an image, or whether the post must be held. What they
// produce is therefore not a `ParsedPost` but a `RawParsedPost`, which carries
// the post's raw media URIS instead of resolved `ParsedMedia`.
//
// `parseArchive` consumes the seam: for each `RawParsedPost` it runs the media
// pre-pass over `mediaUris`, folds the decisions, and emits either a
// `ParsedPost` (every item an image) or a `ParsedSkip` carrying the fold's hold
// reason — with the SAME `sourceItemId` the parser minted, which is why the id
// is built here and not after the fold.
//
// A `ParsedSkip` coming out of a parser is already final: the content-level
// refusals (`empty_post`, `missing_timestamp`, …) need no archive access.

/**
 * Which identity scheme one post's `sourceItemId` used.
 *
 * `'content'` is the v1 content frame (kind 0x01), `'fbid'` the Instagram
 * platform id (kind 0x02). Counted into `ParseSummary.idScheme` and persisted
 * by #921 as `id_kind`, so a scheme flip between two exports of the same
 * account is detectable after the fact.
 */
export type IdScheme = 'content' | 'fbid';

/**
 * The one translation between the parser's spelling and the persisted byte.
 *
 * `Record`, not a pair of `if`s: a third scheme is then a compile error here
 * instead of a silent `1` on a row #921 can never interpret.
 */
export const ID_KIND_BY_SCHEME: Readonly<Record<IdScheme, IdKind>> = {
  content: 1,
  fbid: 2,
};

/**
 * A post that parsed cleanly and is now waiting on its media decisions.
 *
 * `outcome: 'post'` — NOT `'import'`: this is not yet an importable item, and
 * the distinct tag keeps a `RawParsedPost` from being mistaken for a
 * `ParsedPost` by a structural check somewhere downstream.
 */
export interface RawParsedPost {
  readonly outcome: 'post';
  readonly source: ImportSource;
  /** JSON basename. LOCAL UI ONLY (F18). */
  readonly sourceFile: string;
  readonly sourceIndex: number;
  /** PLAINTEXT-CLASS — see `ParsedPost`. Never null: a post that could not be framed is a skip. */
  readonly sourceItemId: Uint8Array;
  readonly idScheme: IdScheme;
  /** Epoch ms UTC, already bounds-checked against the backend's window. */
  readonly originalDate: number;
  /** Final body: repaired, NFC, trimmed, link line appended, within the cap. */
  readonly body: string;
  /**
   * The post's media uris exactly as the export wrote them, in DISPLAY order,
   * duplicates kept.
   *
   * Raw, because the pre-pass resolves them in batches across posts and the
   * id framing already took its own (sorted, basename) view of this list. An
   * empty list is a text-only post, which is importable.
   */
  readonly mediaUris: readonly string[];
  /**
   * Media creation times, epoch ms UTC, 1:1 and in the same order as
   * `mediaUris`. `null` where the export stated none.
   */
  readonly mediaDates: readonly (number | null)[];
}

/** What one JSON element becomes: a post awaiting media, or a settled skip. */
export type RawParseResult = RawParsedPost | ParsedSkip;

/**
 * What a whole JSON file becomes.
 *
 * A file-level failure produces no items at all — a `FileIssueReason` for
 * `ParseSummary.fileIssues` instead, so "0 posts from a file that had some"
 * always has a reason attached.
 */
export type ParsedFile =
  | { readonly ok: true; readonly items: readonly RawParseResult[] }
  | { readonly ok: false; readonly reason: FileIssueReason };

/**
 * Everything a pure parser needs besides the file's text.
 *
 * `nowUtcDay` is injected rather than read from the clock so the date bound is
 * testable on any machine (the CI runner, a UTC+13 phone and the server must
 * agree about which day "today" is).
 */
export interface ParseFileContext {
  /** JSON basename. LOCAL UI ONLY (F18) — carried onto every item. */
  readonly sourceFile: string;
  /** `YYYY-MM-DD` in UTC: the inclusive upper bound for a post's date. */
  readonly nowUtcDay: string;
  /** Defaults to `BODY_MAX_CHARS` (`text.ts`). */
  readonly bodyMaxChars?: number;
  /**
   * The caller already depth-scanned this file's text and it passed.
   *
   * `parseArchive` sets it: it scans each file in abortable slices
   * (`scanJsonDepthChunked`) as it reads, and the scan is the most expensive
   * stage of the parse, so doing it a second time inside `parseJsonSafely`
   * would double a ten-file run's dominant cost. A parser called directly —
   * every parser unit test — leaves it unset and scans.
   */
  readonly depthScanned?: boolean;
}

/**
 * Which identity scheme each post's id used (#921 persists `id_kind`).
 *
 * Counted over the posts that reached the media pre-pass — the importable ones
 * and the media-held ones. The parser's content-level refusals
 * (`empty_post`, `missing_timestamp`, …) are not counted even when they carry
 * an id: `RawParsedPost` is where `idScheme` lives, and a refusal settled
 * before the fold never became one. The counts are a ratio for detecting a
 * scheme FLIP between two exports, not a census of emitted items.
 */
export interface IdSchemeCounts {
  /** Instagram `fbid` from `posts.json` (kind 0x02). */
  readonly fbid: number;
  /** Content-derived v1 frame (kind 0x01). */
  readonly content: number;
}

/** The preflight answer #926 shows before anything is uploaded. */
export interface ParseSummary {
  /** Posts that would be imported. */
  readonly importable: number;
  /** Media items across those posts — all images, by construction. */
  readonly importableMedia: number;
  /** Exhaustive: every reason gets a count, zero included. */
  readonly skipped: Readonly<Record<SkipReason, number>>;
  /** Epoch ms UTC of the earliest/latest importable post, `null` if none. */
  readonly earliestDate: number | null;
  readonly latestDate: number | null;
  readonly fileIssues: readonly FileIssue[];
  readonly idScheme: IdSchemeCounts;
  /** True when the archive also held the OTHER platform's post files. */
  readonly otherSourceDetected: boolean;
  /**
   * True iff `importableMedia > 0`.
   *
   * Valid ONLY because #926 must upload every imported image through
   * `mediaUploadService`'s `sanitizeStillImage` path, which strips EXIF
   * including GPS. If that hand-off ever changes, this field is a lie and must
   * move to the uploader.
   */
  readonly locationDataRemoved: boolean;
}

/** What `onProgress` reports. Counts only — no paths, no content. */
export interface ParseProgress {
  readonly postsSeen: number;
  readonly mediaPeeked: number;
}

/**
 * `parseArchive` options (PR 2 implements the function).
 *
 * The parser does NO crypto and imports nothing from `src/services/crypto/`:
 * `deriveImportKey` is injected by #924, which owns `K_import` for the whole
 * parse and drops it in a `finally` covering abort.
 */
export interface ParseOptions {
  readonly source: ImportSource;
  /**
   * `hmacSha256(K_import, ascii(source) ‖ 0x00 ‖ sourceItemId)[0..16]` (#924).
   *
   * 16 bytes — the backend's `import_key` CHECK. Awaited once per post, which
   * is also the parse's yield point: #924's HMAC is a synchronous JSI call.
   */
  deriveImportKey(sourceItemId: Uint8Array): Promise<Uint8Array>;
  /**
   * Called once per post as its media fold completes, and AWAITED — the parse
   * is serialised against persistence. A rejection aborts the parse and
   * propagates; no summary is returned. The parser keeps no reference to the
   * item afterwards.
   *
   * `importKey` is `null` exactly when `item.sourceItemId` is `null`.
   *
   * ## The same `importKey` CAN arrive more than once
   *
   * An archive may contain the same post twice (a member selecting overlapping
   * ZIP parts, or Meta repeating a post across files). The first copy is
   * emitted as whatever it settled to — an import or a skip — and EVERY later
   * copy is emitted as a separate `duplicate_in_archive` skip carrying the
   * IDENTICAL `importKey`. Nothing is swallowed: #928 can tell the member how
   * many copies their export held.
   *
   * A consumer keyed on `import_key` must therefore UPSERT or ignore, never
   * plain-`INSERT` into a `UNIQUE` column (#921). The settled item always
   * arrives first, so "keep the first, ignore the rest" is the correct
   * resolution — a later `duplicate_in_archive` row must not overwrite the
   * import it duplicates.
   */
  onItem(item: ParsedItem, importKey: Uint8Array | null): Promise<void>;
  onProgress?: (progress: ParseProgress) => void;
  readonly signal?: AbortSignal;
  /** Defaults to `BODY_MAX_CHARS` (`text.ts`). */
  readonly bodyMaxChars?: number;
  /**
   * `YYYY-MM-DD` in UTC, the upper bound for `original_created_at`. Injected
   * so the boundary is testable on any clock; defaults to today in UTC, which
   * is what the server's `dbUtcToday` compares against.
   */
  readonly nowUtcDay?: string;
}
