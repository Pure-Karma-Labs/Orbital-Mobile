/**
 * The Meta import orchestration (#925): one archive session in, a stream of
 * `ParsedItem`s and one `ParseSummary` out.
 *
 * Everything else in this directory is deliberately narrow — the parsers are
 * pure, the pre-pass only classifies media, `layout.ts` only matches paths.
 * This module is the only one that holds all of it at once, so it is also the
 * only one that can get the ORDER wrong. The order is:
 *
 *  1. `detectSources` over the listing (for `otherSourceDetected`) and
 *     `classifyPostJson` for the read plan and its file issues.
 *  2. Instagram only: read the labelled `posts.json` FIRST and build the fbid
 *     index from it, then drop the parsed graph before any content file is
 *     opened. A 12 MiB display tree and a 12 MiB content file must never be
 *     resident together (plan §2; the Hermes bench in `jsonSafety.ts`'s header
 *     is what bounds this).
 *  3. Per content file, in plan order: read → parse → ONE `resolveFileMedia`
 *     pass over the file's concatenated uris → per post, peek + classify +
 *     fold → emit.
 *
 * ## The import licence is NOT minted here
 *
 * This file never writes the `'import-image'` literal, and a `ParsedPost`'s
 * `media` is only ever `folded.media` — the output of
 * `foldPostMediaDecisions`. Both facts are pinned by security invariant 29.8
 * clause 5, because clauses 3-4 pin the pre-pass's bodies and a `parseArchive`
 * that quietly built `media` from the raw resolutions would satisfy every one
 * of them while importing media nothing ever classified.
 *
 * ## Throw policy (plan §4)
 *
 * `resolveMediaUris` and `peekEntryKind` throws are NEVER caught into a
 * decision; there is no `catch` in this file. An `ArchiveReaderError`
 * propagates out of `parseArchive` with its code intact and #926 dispatches on
 * `ARCHIVE_ERROR_DISPOSITIONS`: `retryable-pause` and `requires-repick` mean
 * the member's import is paused or needs the files re-picked, NOT that their
 * photos are permanently unimportable. Turning one into a `media_unreadable`
 * skip here would be an irreversible, silent data loss.
 *
 * `readEntryJson` is the exception, and only because its skips are VALUES, not
 * throws: a skipped JSON entry is a file issue (`json_entry_skipped`), which
 * is exactly what the member needs to be told about that file.
 *
 * ## What this module keeps in memory
 *
 *  - run-wide: the 32-char hex of each post's 16-byte `import_key` (bounded by
 *    `MAX_POSTS_PER_RUN`), the peek budget and the summary counters;
 *  - per file: the parsed items, one array of `UriResolution`s and the peek
 *    memo.
 *
 * It never retains a `sourceItemId` (plaintext-class, see `types.ts`) past the
 * post it belongs to, and never retains an item after `onItem` resolves.
 */

import { ArchiveReaderError } from './archiveAccess';
import { todayUtcDay } from './dateBounds';
import { parseFacebookFile } from './facebookParser';
import { buildFbidIndex, parseInstagramFlatFile } from './instagramParser';
import { classifyPostJson, detectSources } from './layout';
import {
  MAX_PEEKS_PER_RUN,
  classifyMediaItem,
  createFilePeekScope,
  createPeekBudget,
  foldPostMediaDecisions,
  peekMediaEntries,
  resolveFileMedia,
} from './mediaPrePass';

import { ID_KIND_BY_SCHEME } from './types';

import type { ArchiveCallOptions, ArchiveImportSession } from './archiveAccess';
import type { FbidIndex } from './instagramParser';
import type { HoldReason, PostMediaItem } from './mediaPrePass';
import type {
  FileIssue,
  FileIssueReason,
  IdScheme,
  ParseFileContext,
  ParseOptions,
  ParseSummary,
  ParsedItem,
  ParsedPost,
  ParsedSkip,
  RawParseResult,
  RawParsedPost,
  SkipReason,
} from './types';

/**
 * Items (posts AND skips) read across a whole run before the archive is
 * refused.
 *
 * This is the bound on the dedup `Set`: 50,000 × 32 hex chars is ~3 MB of
 * strings, which the Hermes bench (`jsonSafety.ts` header) measured with the
 * set full. Beyond the cap the remaining files are NOT read and the member is
 * told (`archive_too_large`) rather than left to discover the tail of their
 * history missing.
 */
export const MAX_POSTS_PER_RUN = 50_000;

/** The backend's `import_key` CHECK, asserted on every `deriveImportKey`. */
const IMPORT_KEY_BYTES = 16;

/**
 * Orchestrate one source's parse over one archive session.
 *
 * `onItem` is awaited per item as that item settles, which is what serialises
 * the parse against #921's inserts and gives #924's synchronous JSI HMAC a
 * yield point. A rejection from `onItem` (or from `deriveImportKey`) aborts
 * the parse and propagates: no summary is returned, because a summary that
 * described items the caller never stored would be a preflight promise about
 * an import that cannot happen.
 */
export async function parseArchive(
  session: ArchiveImportSession,
  options: ParseOptions,
): Promise<ParseSummary> {
  const source = options.source;
  const signal = options.signal;
  const nowUtcDay = options.nowUtcDay ?? todayUtcDay();
  const call: ArchiveCallOptions = signal === undefined ? {} : { signal };

  const detected = detectSources(session.entries);
  const tally = createTally(source === 'facebook' ? detected.instagram : detected.facebook);

  const plan = classifyPostJson(session.entries, source);
  for (const issue of plan.fileIssues) tally.addIssue(issue.sourceFile, issue.reason);

  // Step 2: the fbid index, built before any content file and dropped here.
  // `buildFbidIndex` keeps only basename → fbid strings; the 12 MiB graph it
  // walked is unreachable the moment it returns.
  let fbidIndex: FbidIndex | null = null;
  if (source === 'instagram' && plan.labelled !== null) {
    throwIfAborted(signal);
    const labelled = plan.labelled;
    const read = await session.readEntryJson(labelled.entryId, call);
    if (!read.ok) {
      // The one file whose absence changes identities, so it is never silent.
      tally.addIssue(labelled.sourceFile, 'json_entry_skipped');
    } else {
      const built = buildFbidIndex(read.text);
      if (built.ok) fbidIndex = built.index;
      else tally.addIssue(labelled.sourceFile, built.reason);
    }
  }

  const budget = createPeekBudget(MAX_PEEKS_PER_RUN);
  /** hex(import_key) of every item already emitted. The run-wide dedup set. */
  const seenKeys = new Set<string>();
  let postsSeen = 0;

  const reportProgress = (): void => {
    options.onProgress?.({ postsSeen, mediaPeeked: MAX_PEEKS_PER_RUN - budget.remaining });
  };

  /** Count it, hand it over, forget it. The only place `onItem` is called. */
  const emit = async (item: ParsedItem, importKey: Uint8Array | null): Promise<void> => {
    tally.count(item);
    await options.onItem(item, importKey);
    reportProgress();
  };

  /** Set when the run-wide post cap bites mid-file: no further file is read. */
  let stopped = false;

  for (const file of plan.files) {
    throwIfAborted(signal);
    if (postsSeen >= MAX_POSTS_PER_RUN) {
      tally.addIssue(file.sourceFile, 'archive_too_large');
      break;
    }

    const read = await session.readEntryJson(file.entryId, call);
    if (!read.ok) {
      tally.addIssue(file.sourceFile, 'json_entry_skipped');
      continue;
    }

    const ctx: ParseFileContext = {
      sourceFile: file.sourceFile,
      nowUtcDay,
      ...(options.bodyMaxChars === undefined ? {} : { bodyMaxChars: options.bodyMaxChars }),
    };
    const parsed =
      source === 'facebook'
        ? parseFacebookFile(read.text, ctx)
        : parseInstagramFlatFile(read.text, ctx, fbidIndex);
    if (!parsed.ok) {
      tally.addIssue(file.sourceFile, parsed.reason);
      continue;
    }

    // ONE resolve pass per file (F7: `resolveMediaUris` is synchronous and
    // batch-only), over every post's uris concatenated in item order. The
    // offset bookkeeping below is what maps a slice of that array back to the
    // post that named it — `resolveFileMedia` asserts the 1:1 alignment the
    // slicing depends on.
    const fileUris: string[] = [];
    for (const item of parsed.items) {
      if (item.outcome === 'post') fileUris.push(...item.mediaUris);
    }
    const resolved = await resolveFileMedia(session, fileUris, call);
    if (!resolved.ok) tally.addIssue(file.sourceFile, resolved.issue);
    const scope = createFilePeekScope(budget);

    let at = 0;
    for (const item of parsed.items) {
      throwIfAborted(signal);
      if (postsSeen >= MAX_POSTS_PER_RUN) {
        tally.addIssue(file.sourceFile, 'archive_too_large');
        stopped = true;
        break;
      }
      postsSeen += 1;

      // Advanced for EVERY post, including one dropped as a duplicate: the
      // offsets index the file's uri array, not the emitted items.
      const start = at;
      const span = item.outcome === 'post' ? item.mediaUris.length : 0;
      at += span;

      const importKey =
        item.sourceItemId === null ? null : await deriveImportKey(options, item.sourceItemId);

      if (importKey !== null) {
        const hex = toHex(importKey);
        if (seenKeys.has(hex)) {
          // The SAME post again — the server dedups on this exact value, so
          // emitting it twice would make #921 insert a row it cannot keep.
          // Its media is never peeked: the first occurrence already reported
          // whatever its outcome was.
          await emit(duplicateSkip(item), importKey);
          continue;
        }
        seenKeys.add(hex);
      }

      if (item.outcome === 'skip') {
        await emit(item, importKey);
        continue;
      }
      tally.countScheme(item.idScheme);

      if (!resolved.ok && span > 0) {
        // The file named more uris than the pre-pass will resolve, so NOTHING
        // in it was classified. A post whose media was never looked at has no
        // licence to import any of it (plan §4).
        //
        // A post that named NO media is untouched by that: it has nothing to
        // classify, and the fold's own rule is that an empty media list
        // imports. Holding a text-only post because a DIFFERENT post in the
        // same file had too many photos would be a permanent-class skip for a
        // post nothing was ever wrong with.
        await emit(holdSkip(item, 'media_unreadable'), importKey);
        continue;
      }

      const slice = resolved.ok ? resolved.resolutions.slice(start, start + span) : [];
      const entryIds = slice.flatMap((resolution) => (resolution.ok ? [resolution.entryId] : []));
      const peeks = await peekMediaEntries(session, entryIds, scope, call);
      const decisions: PostMediaItem[] = slice.map((resolution, index) => ({
        result: classifyMediaItem(
          resolution,
          resolution.ok ? (peeks.get(resolution.entryId) ?? null) : null,
        ),
        originalDate: item.mediaDates[index] ?? null,
      }));

      const folded = foldPostMediaDecisions(decisions);
      if (folded.outcome === 'hold') {
        await emit(holdSkip(item, folded.reason), importKey);
        continue;
      }

      const post: ParsedPost = {
        outcome: 'import',
        source: item.source,
        sourceFile: item.sourceFile,
        sourceIndex: item.sourceIndex,
        sourceItemId: item.sourceItemId,
        idKind: ID_KIND_BY_SCHEME[item.idScheme],
        originalDate: item.originalDate,
        body: item.body,
        media: folded.media,
      };
      await emit(post, importKey);
    }

    if (stopped) break;
  }

  reportProgress();
  return tally.summarize();
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * The held form of a post whose media the fold refused.
 *
 * Same identity, same date, same file position as the post would have had:
 * #921 persists this row's `import_key` so that a later re-run — after the
 * member selects the missing ZIP part, say — recognises it as the same item
 * rather than importing a second copy.
 */
function holdSkip(post: RawParsedPost, reason: HoldReason): ParsedSkip {
  return {
    outcome: 'skip',
    source: post.source,
    sourceFile: post.sourceFile,
    sourceIndex: post.sourceIndex,
    sourceItemId: post.sourceItemId,
    idKind: ID_KIND_BY_SCHEME[post.idScheme],
    originalDate: post.originalDate,
    reason,
  };
}

/**
 * The second (or third…) occurrence of one identity within one archive.
 *
 * It keeps the identity of the copy it duplicates, `idKind` included — a
 * duplicate of an fbid-identified post is an fbid row, and #921's `id_kind`
 * must not read `content` for it just because this row was built here.
 */
function duplicateSkip(item: RawParseResult): ParsedSkip {
  return {
    outcome: 'skip',
    source: item.source,
    sourceFile: item.sourceFile,
    sourceIndex: item.sourceIndex,
    sourceItemId: item.sourceItemId,
    idKind: item.outcome === 'post' ? ID_KIND_BY_SCHEME[item.idScheme] : item.idKind,
    originalDate: item.originalDate,
    reason: 'duplicate_in_archive',
  };
}

// ---------------------------------------------------------------------------
// The import key
// ---------------------------------------------------------------------------

/**
 * Ask #924 for one item's `import_key`, and check its width.
 *
 * 16 bytes is the backend's `import_key` CHECK. A shorter or longer value
 * would be caught by the server mid-run, after the member watched a progress
 * bar, and a TRUNCATED one would silently collide two posts in the dedup set
 * — so the check is here, at the only place the value enters the run.
 *
 * `ARCHIVE_INTERNAL` because this is a caller/wiring bug rather than anything
 * about the archive, and because that code's disposition is `terminal-for-run`
 * (#926 stops; it never retries into the same bug). The error interpolates
 * nothing: `sourceItemId` is plaintext-class.
 */
async function deriveImportKey(
  options: ParseOptions,
  sourceItemId: Uint8Array,
): Promise<Uint8Array> {
  const key = await options.deriveImportKey(sourceItemId);
  if (key.length !== IMPORT_KEY_BYTES) throw new ArchiveReaderError('ARCHIVE_INTERNAL');
  return key;
}

/**
 * The dedup set's key: lowercase hex of the 16-byte `import_key`.
 *
 * Hex rather than the bytes themselves because `Set` compares `Uint8Array`s by
 * reference, and rather than latin1 because a hex string is ASCII — Hermes
 * keeps it compact and no byte value can be mangled by a string operation on
 * the way in.
 */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

// ---------------------------------------------------------------------------
// Summary accumulation
// ---------------------------------------------------------------------------

interface Tally {
  addIssue(sourceFile: string, reason: FileIssueReason): void;
  count(item: ParsedItem): void;
  countScheme(scheme: IdScheme): void;
  summarize(): ParseSummary;
}

/** Zero for every reason: `ParseSummary.skipped` is exhaustive, not partial. */
function zeroedSkipCounts(): Record<SkipReason, number> {
  return {
    held_video: 0,
    unsupported_image_format: 0,
    media_missing: 0,
    media_unsupported_reference: 0,
    media_unreadable: 0,
    unsupported_post_type: 0,
    empty_post: 0,
    text_too_long: 0,
    invalid_timestamp: 0,
    missing_timestamp: 0,
    duplicate_in_archive: 0,
    malformed_post: 0,
  };
}

/**
 * The summary, accumulated as items are emitted.
 *
 * File issues are deduplicated by (basename, reason) — the same file repeated
 * across five ZIP parts is one problem, not five rows — matching what
 * `classifyPostJson` already does for the issues it raises itself.
 */
function createTally(otherSourceDetected: boolean): Tally {
  const skipped = zeroedSkipCounts();
  const fileIssues: FileIssue[] = [];
  const seenIssues = new Set<string>();
  let importable = 0;
  let importableMedia = 0;
  let earliestDate: number | null = null;
  let latestDate: number | null = null;
  let fbid = 0;
  let content = 0;

  return {
    addIssue(sourceFile, reason) {
      const key = `${reason}\u0000${sourceFile}`;
      if (seenIssues.has(key)) return;
      seenIssues.add(key);
      fileIssues.push({ sourceFile, reason });
    },
    count(item) {
      if (item.outcome === 'skip') {
        skipped[item.reason] += 1;
        return;
      }
      importable += 1;
      importableMedia += item.media.length;
      // The range describes what WOULD be imported: a held post's date is in
      // #928's per-item list, not in the "your history spans…" headline.
      if (earliestDate === null || item.originalDate < earliestDate) {
        earliestDate = item.originalDate;
      }
      if (latestDate === null || item.originalDate > latestDate) latestDate = item.originalDate;
    },
    countScheme(scheme) {
      if (scheme === 'fbid') fbid += 1;
      else content += 1;
    },
    summarize() {
      return {
        importable,
        importableMedia,
        skipped,
        earliestDate,
        latestDate,
        fileIssues,
        idScheme: { fbid, content },
        otherSourceDetected,
        // True iff there is imported media at all — valid ONLY because #926
        // uploads every imported image through `mediaUploadService`'s
        // `sanitizeStillImage` path (see `types.ts`).
        locationDataRemoved: importableMedia > 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

/**
 * Checked between files and between posts.
 *
 * Those are the only two places the parse is between two units of work that
 * can be abandoned cleanly; the pre-pass checks its own chunk boundaries. The
 * code is the archive reader's cancellation code, so #926 can tell a member's
 * cancel apart from a failure with `isArchiveCancellation`.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ArchiveReaderError('ECANCELLED');
}
