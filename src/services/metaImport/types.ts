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
 * The first five are the media holds (#983's hold obligation): a post whose
 * media cannot be POSITIVELY classified as an image is held whole, never
 * partially imported. The rest are content-level refusals.
 */
export type SkipReason =
  | 'held_video'
  | 'unsupported_image_format'
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
  /** Epoch ms UTC. Always present on an importable post. */
  readonly originalDate: number;
  /** NFC-normalised, newline-normalised, trimmed, link line appended. */
  readonly body: string;
  readonly media: readonly ParsedMedia[];
}

/**
 * A post that will not be imported, and why.
 *
 * `sourceItemId` is present for everything except `malformed_post` (whose text
 * could not be framed in the first place), because #921 requires a held item
 * to carry its `import_key` from parse time — the same identity the eventual
 * retry would mint.
 */
export interface ParsedSkip {
  readonly outcome: 'skip';
  readonly source: ImportSource;
  /** JSON basename. LOCAL UI ONLY (F18). */
  readonly sourceFile: string;
  readonly sourceIndex: number;
  /** PLAINTEXT-CLASS, `null` only for `malformed_post`. */
  readonly sourceItemId: Uint8Array | null;
  /** Epoch ms UTC, `null` when the export stated none or stated nonsense. */
  readonly originalDate: number | null;
  readonly reason: SkipReason;
}

export type ParsedItem = ParsedPost | ParsedSkip;

/** Which identity scheme each post's id used (#921 persists `id_kind`). */
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
