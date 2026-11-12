/**
 * Which files in a Meta archive hold posts, and in what order to read them
 * (#925).
 *
 * ## Paths choose FILES. They never choose identities.
 *
 * Everything in this module is path matching, and a path is the one piece of an
 * archive that is both attacker-controlled and unstable across exports. So the
 * rule is absolute: a path may decide WHICH file is read and WHAT LABEL the UI
 * shows for it; `source_item_id` is never derived from a path, from an
 * `entryId`, or from a file's position in this plan. (The media BASENAMES that
 * do enter the id come from the JSON's own `uri` fields, which are content, not
 * from the listing.)
 *
 * ## The four layouts, and why all of them
 *
 * Meta has renamed its export wrapper twice for Facebook and twice for
 * Instagram, and all of the shapes are still in the wild — a member's 2019
 * download and their 2026 download have different roots. A detector that knows
 * only the newest one imports nothing from an older archive, which to the
 * member looks exactly like "you had no posts". Every known root is therefore
 * matched, and an unknown one is a silent miss we would rather hear about as a
 * bug report than paper over with a loose `.*posts.*\.json` match that would
 * happily read `your_posts_from_a_group_you_left.json` or, worse, something
 * under a root the allowlist only tolerates for media.
 *
 * ## Order
 *
 * `(numeric N ascending, path ascending)` — NOT lexicographic on the whole
 * name, which puts `posts_10` before `posts_2` and interleaves a member's
 * history. The numeric part is captured by the regex, so the comparison is on a
 * number; path order only breaks ties between two layouts claiming the same N.
 * Order matters because the FIRST occurrence of a duplicated post wins
 * (`duplicate_in_archive`), so a stable, chronological-ish order makes the kept
 * copy predictable.
 */

import { MAX_JSON_BYTES } from './jsonSafety';
import { basenameOfUri } from './sourceItemId';

import type { ArchiveEntry } from './archiveAccess';
import type { FileIssue, FileIssueReason, ImportSource } from './types';

/**
 * Run-wide ceiling on post JSON files.
 *
 * A real export has a handful; 200 is far beyond any observed archive and
 * bounds the work a crafted ZIP full of `posts_1.json … posts_9999.json` can
 * demand. Over the cap the extra files are NOT read and the member is told
 * (`archive_too_large`) rather than left wondering why the tail of their
 * history is missing.
 *
 * The other run-wide caps (`MAX_POSTS_PER_RUN`, `MAX_MEDIA_URIS_PER_FILE`,
 * `MAX_PEEKS_PER_RUN`) belong to the orchestration and the media pre-pass.
 */
export const MAX_POST_JSON_FILES = 200;

// ---------------------------------------------------------------------------
// Path patterns
// ---------------------------------------------------------------------------
//
// Anchored at both ends, with a bounded `\d{1,4}` rather than `\d+`: the
// capture is fed to `Number`, and an unbounded run of digits is an easy way to
// hand a sort comparator an `Infinity`.

/** `your_facebook_activity/` and `your_activity_across_facebook/` wrappers. */
const FB_ACTIVITY_POSTS =
  /^(?:your_facebook_activity|your_activity_across_facebook)\/posts\/your_posts__check_ins__photos_and_videos_(\d{1,4})\.json$/;

/** The older flat Facebook export. */
const FB_FLAT_POSTS = /^posts\/your_posts_(\d{1,4})\.json$/;

/**
 * The ONE labelled Instagram file. It is not a content file: #925 reads it for
 * `fbid` values only (see `instagramParser.buildFbidIndex`).
 */
const IG_LABELLED_POSTS = /^your_instagram_activity\/media\/posts\.json$/;

/** Instagram per-part content files, under any of the four known prefixes. */
const IG_FLAT_POSTS =
  /^(?:your_instagram_activity\/media\/|your_instagram_activity\/content\/|content\/|media\/)posts_(\d{1,4})\.json$/;

type MatchRole = 'content' | 'labelled';

interface PathMatch {
  readonly source: ImportSource;
  readonly role: MatchRole;
  /** The `_N` suffix. The labelled file has no N and sorts as 0. */
  readonly index: number;
}

/** Which post file, if any, a listed path is. `null` for everything else. */
export function matchPostJsonPath(path: string): PathMatch | null {
  const activity = FB_ACTIVITY_POSTS.exec(path);
  if (activity !== null) return { source: 'facebook', role: 'content', index: Number(activity[1]) };

  const flat = FB_FLAT_POSTS.exec(path);
  if (flat !== null) return { source: 'facebook', role: 'content', index: Number(flat[1]) };

  if (IG_LABELLED_POSTS.test(path)) return { source: 'instagram', role: 'labelled', index: 0 };

  const igFlat = IG_FLAT_POSTS.exec(path);
  if (igFlat !== null) return { source: 'instagram', role: 'content', index: Number(igFlat[1]) };

  return null;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DetectedSources {
  readonly facebook: boolean;
  readonly instagram: boolean;
}

/**
 * Which platforms' post files this archive contains.
 *
 * Deliberately blind to `skip` and to `kind`: a `posts.json` that Rust refused
 * for being over the cap is still proof that this is an Instagram export, and
 * #926 uses that to say "this archive also contains Instagram posts" rather
 * than letting a member pick the wrong source and see zero results. Nothing
 * here is read, so a skipped entry costs nothing to count.
 */
export function detectSources(entries: readonly ArchiveEntry[]): DetectedSources {
  let facebook = false;
  let instagram = false;
  for (const entry of entries) {
    const match = matchPostJsonPath(entry.path);
    if (match === null) continue;
    if (match.source === 'facebook') facebook = true;
    else instagram = true;
  }
  return { facebook, instagram };
}

// ---------------------------------------------------------------------------
// The file plan
// ---------------------------------------------------------------------------

export interface PostJsonFile {
  /** OPAQUE archive handle. Never parsed, never part of an identity. */
  readonly entryId: string;
  /** JSON basename. LOCAL UI ONLY (F18) — this is what #928 shows. */
  readonly sourceFile: string;
  /** The `_N` suffix, for ordering and for tests. */
  readonly index: number;
}

export interface PostJsonPlan {
  /** Content files, in read order. */
  readonly files: readonly PostJsonFile[];
  /**
   * Instagram's labelled `posts.json`, when it exists AND is readable.
   *
   * `null` means the fbid join is unavailable and every Instagram post falls
   * back to a content-derived id — a real behaviour change (see the identity
   * contract in `sourceItemId.ts`), which is why an unreadable one always
   * produces a file issue rather than disappearing.
   */
  readonly labelled: PostJsonFile | null;
  readonly fileIssues: readonly FileIssue[];
}

/**
 * Plan the read for one source.
 *
 * Per matched entry, in this order — `json_too_large` FIRST, because an
 * over-cap entry is also a skipped entry and the size is the useful thing to
 * tell the member:
 *
 *  1. listed as `json` with `ENTRY_OVER_CAP`, or a `declaredSize` over
 *     `MAX_JSON_BYTES` ⇒ `json_too_large`. (Both, because the Rust precheck
 *     and this one can disagree if the caps ever drift, and the stricter side
 *     should win.)
 *  2. `ENTRY_DUPLICATE` with a readable same-path twin ⇒ SILENT. This is the
 *     ordinary multi-part case: Meta repeats a file in every part, Rust lists
 *     the first and marks the rest. Telling a member their archive has a
 *     problem because it is a multi-part archive would be noise.
 *  3. any other skip ⇒ `json_entry_skipped`.
 *  4. otherwise the file is read.
 *
 * Issues are deduplicated by (basename, reason): the same file repeated across
 * five parts is one problem, not five rows.
 */
export function classifyPostJson(
  entries: readonly ArchiveEntry[],
  source: ImportSource,
): PostJsonPlan {
  const issues: FileIssue[] = [];
  const seenIssues = new Set<string>();
  const addIssue = (sourceFile: string, reason: FileIssueReason): void => {
    const key = `${reason}\u0000${sourceFile}`;
    if (seenIssues.has(key)) return;
    seenIssues.add(key);
    issues.push({ sourceFile, reason });
  };

  interface Candidate {
    readonly entry: ArchiveEntry;
    readonly match: PathMatch;
  }

  const candidates: Candidate[] = [];
  /** Paths that have at least one entry we could actually read. */
  const readablePaths = new Set<string>();
  for (const entry of entries) {
    const match = matchPostJsonPath(entry.path);
    if (match === null || match.source !== source) continue;
    candidates.push({ entry, match });
    if (entry.skip === null) readablePaths.add(entry.path);
  }

  // (numeric N asc, path asc). The labelled file's index is 0, so it sorts
  // first; it is pulled out of the list below and never read as content.
  candidates.sort((a, b) => {
    if (a.match.index !== b.match.index) return a.match.index - b.match.index;
    return a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0;
  });

  const files: PostJsonFile[] = [];
  let labelled: PostJsonFile | null = null;

  for (const { entry, match } of candidates) {
    const sourceFile = basenameOfUri(entry.path);

    const overCap =
      (entry.kind === 'json' && entry.skip === 'ENTRY_OVER_CAP') ||
      entry.declaredSize > MAX_JSON_BYTES;
    if (overCap) {
      addIssue(sourceFile, 'json_too_large');
      continue;
    }

    if (entry.skip === 'ENTRY_DUPLICATE' && readablePaths.has(entry.path)) continue;

    if (entry.skip !== null) {
      addIssue(sourceFile, 'json_entry_skipped');
      continue;
    }

    // A non-`json` kind here would mean the listing disagrees with the
    // extension about a file whose path we matched exactly; nothing may be
    // read on that basis.
    if (entry.kind !== 'json') {
      addIssue(sourceFile, 'json_entry_skipped');
      continue;
    }

    const file: PostJsonFile = { entryId: entry.entryId, sourceFile, index: match.index };
    if (match.role === 'labelled') {
      // Two readable labelled files cannot happen (one path, and a repeat is
      // ENTRY_DUPLICATE); if it ever did, the first in order wins.
      labelled ??= file;
    } else {
      files.push(file);
    }
  }

  if (files.length > MAX_POST_JSON_FILES) {
    const dropped = files.splice(MAX_POST_JSON_FILES);
    addIssue(dropped[0].sourceFile, 'archive_too_large');
  }

  return { files, labelled, fileIssues: issues };
}
