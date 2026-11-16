/**
 * Every user-facing string in the Meta import flow (#928 §4), plus the pure
 * derivations the screens switch on.
 *
 * ## Why one module
 *
 * 1. **Exhaustiveness.** The copy tables are `Record<Union, …>`, never
 *    `Partial`, so a new `SkipReason`, `PauseCause` or `ImportTerminalCode`
 *    is a COMPILE error here rather than a blank line on a member's screen.
 * 2. **Auditability.** The brand rules (#928: never a lowercase or abbreviated
 *    platform name, never "Meta login", never the word "resume", never "try
 *    another device") are enforced by a test that walks this module's exports.
 *    A string inlined in a screen would escape that walk.
 * 3. **Purity.** No React, no `importRunner` at runtime, no device state — its
 *    test requires it with NO jest mocks. Every runner symbol below is a
 *    type-only import; the single value import is `SKIP_REASON_CLASS` from the
 *    parser's `types.ts`, a dependency-free contract module (its header: "Nothing
 *    in this file imports anything"). Classifying skips here a second time
 *    instead would let the two classifications drift apart silently.
 *
 * Nothing here logs. `src/screens/import/` is held to a zero-log bar
 * (check-security-invariants rule 35): these strings sit next to basenames and
 * dates out of the member's own export (F18, local-UI class).
 */

import { SKIP_REASON_CLASS } from '../../services/metaImport/types';
import { formatDateWithYear, formatDateWithYearA11y } from '../../utils/formatPostTimestamp';
import { formatMB } from '../../utils/formatBytes';

import type {
  ImportPhase,
  ImportPreflight,
  ImportSummary,
  PauseCause,
} from '../../services/metaImport/importRunner';
// `ImportTerminalCode` is the ONE type the runner uses but does not re-export;
// it is the error taxonomy's own, and `ImportSummary.errorCode` is typed by it.
import type { ImportTerminalCode } from '../../services/metaImport/importErrors';
import type {
  FileIssue,
  FileIssueReason,
  ImportSource,
  SkipReason,
} from '../../services/metaImport/types';
import type {
  ImportFailedItemCode,
  PickFailureReason,
  UnmigratedCounts,
  UnmigratedImportItem,
} from '../../services/metaImport/importRunner';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * "1 post" / "2 posts". The ONE place a count meets a noun.
 *
 * @param pluralForm Supply it for anything `+s` gets wrong ("1 photo is",
 *   "2 photos are" → pass the whole phrase).
 */
export function plural(count: number, singular: string, pluralForm?: string): string {
  const word = count === 1 ? singular : (pluralForm ?? `${singular}s`);
  return `${count} ${word}`;
}

/** "was" / "were" — the verb half of {@link plural}. */
function wasWere(count: number): string {
  return count === 1 ? 'was' : 'were';
}

/** "4:05" — a whole-minute countdown, floored, never negative. */
export function formatCountdown(msRemaining: number): string {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return '0:00';
  const totalSeconds = Math.ceil(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** The platform's own name, always spelled in full and capitalised (brand). */
export const SOURCE_LABEL: Readonly<Record<ImportSource, string>> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
};

/** The OTHER platform — "This export also has {other} posts." */
const OTHER_SOURCE: Readonly<Record<ImportSource, ImportSource>> = {
  facebook: 'instagram',
  instagram: 'facebook',
};

/** Shown wherever a post's photos are mentioned, because it surprises people. */
export const PHOTOS_REDOWNLOAD_NOTE =
  "Imported photos aren't kept on this phone. They download again the first time you view them.";

// ---------------------------------------------------------------------------
// §3.1 — the one derivation every import screen switches on
// ---------------------------------------------------------------------------

export type ImportViewKind =
  /** Launch hydration hasn't settled. */
  | 'checking'
  /** Nothing to show. */
  | 'none'
  /** A job exists but its preflight couldn't be rebuilt (§2 gap 2b). */
  | 'blocked'
  | 'parsing'
  /** Parsed, but the export holds nothing importable. */
  | 'nothing'
  /** Parsed, but over the orbit's allowance. */
  | 'refused'
  /** Parsed and runnable. */
  | 'preflight'
  | 'running'
  /** Paused, auto-retry spent — only a tap moves it now. */
  | 'stalled'
  /** Paused: the archive files must be picked again. */
  | 'repick'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface ImportView {
  readonly kind: ImportViewKind;
  /** The cause behind `paused`/`repick`/`stalled`; `null` everywhere else. */
  readonly cause: PauseCause | null;
}

/**
 * The fields {@link deriveImportView} reads.
 *
 * A structural SUBSET of the published state, so the live state satisfies it
 * and a test can build a six-field literal instead of a whole run.
 */
export interface ImportViewInput {
  readonly phase: ImportPhase;
  readonly jobId: string | null;
  readonly preflight: ImportPreflight | null;
  readonly pauseCauses: readonly PauseCause[];
  readonly autoRetryExhausted: boolean;
  readonly summary: ImportSummary | null;
}

function asView(kind: ImportViewKind, cause: PauseCause | null = null): ImportView {
  return { kind, cause };
}

/**
 * Pure state → view (§3.1). Every row of that table has a test.
 *
 * Two defensive rows have no state that can reach them today and are mapped
 * rather than thrown on: `ready` with no preflight (`none`), and `paused` with
 * an empty cause set (`running` — the run is live, the set is simply not
 * populated yet).
 */
export function deriveImportView(state: ImportViewInput): ImportView {
  switch (state.phase) {
    case 'hydrating':
      return asView('checking');

    case 'idle':
      // A jobId with no phase to run it: the preflight rebuild failed, and the
      // member needs Retry / Start over rather than silence (§2 gap 2b).
      return asView(state.jobId === null ? 'none' : 'blocked');

    case 'parsing':
      return asView('parsing');

    case 'ready': {
      const preflight = state.preflight;
      if (preflight === null) return asView('none');
      // `nothingToImport` wins over an allowance refusal: an export with
      // nothing in it is not an allowance fact, and its copy says something
      // else entirely.
      if (preflight.nothingToImport) return asView('nothing');
      if (preflight.overAllowance !== null) return asView('refused');
      return asView('preflight');
    }

    case 'running':
      return asView('running');

    case 'paused': {
      const cause = state.pauseCauses[0];
      if (cause === undefined) return asView('running');
      if (state.autoRetryExhausted) return asView('stalled', cause);
      if (cause === 'needs_repick') return asView('repick', cause);
      return asView('paused', cause);
    }

    case 'done': {
      const summary = state.summary;
      if (summary === null) return asView('none');
      if (summary.cancelled) return asView('cancelled');
      return asView(summary.errorCode === null ? 'completed' : 'failed');
    }
  }
}

// ---------------------------------------------------------------------------
// §4.1 — entry point and how-to
// ---------------------------------------------------------------------------

export const IMPORT_SECTION_HEADER = 'Import posts';

/** "Import from Facebook" — the Settings start rows. */
export function describeStartRow(source: ImportSource): string {
  return `Import from ${SOURCE_LABEL[source]}`;
}

/** The orbit caption. Rendered through `EmojiText`, never inside a row label. */
export function describeIntoCaption(orbitName: string | null): string {
  return `Into: ${orbitName ?? 'this orbit'}`;
}

/** The Settings status row when the live job belongs to a different orbit. */
export const OTHER_ORBIT_STATUS_LABEL = 'Import in another orbit…';

/** The caption under that row. The name goes through `EmojiText` only. */
export function describeOtherOrbitCaption(orbitName: string | null): string {
  return `In: ${orbitName ?? "an orbit you've left"}`;
}

export function describeHowToIntro(source: ImportSource, orbitName: string | null): string {
  const src = SOURCE_LABEL[source];
  const orbit = orbitName ?? 'this orbit';
  return (
    `Bring your own ${src} posts into ${orbit}. You don't sign in to Meta here: ` +
    `you download a copy of your information from ${src}, then pick the files. ` +
    'Orbital reads them on this phone, encrypts each post and posts it to the ' +
    'orbit at its original date.'
  );
}

export function describeAllowance(remainingPosts: number): string {
  return `You can import ${remainingPosts} more posts into this orbit.`;
}

/** The seven export steps, in order (§4.1). */
export function describeHowToSteps(source: ImportSource): readonly string[] {
  const src = SOURCE_LABEL[source];
  return [
    `In ${src}, open Accounts Center → Your information and permissions → ` +
      'Download your information, and start a download to your device.',
    'Under Customize information, select Posts only. Leaving other categories ' +
      'out keeps the export small.',
    'Choose a Date range.',
    "Set Format → JSON. HTML exports can't be imported.",
    'Set Media quality. Higher quality means bigger files. Medium is usually enough.',
    'Create files. Meta lets you know when the export is ready. The download ' +
      'expires after 4 days.',
    'Download every file. Big exports are split into several ZIP parts. Select ' +
      'every part when you pick files here.',
  ];
}

export const HOW_TO_NOTES: readonly string[] = [
  "Videos aren't imported yet. Posts with videos are held so a future update " +
    'can import them. Keep your export file.',
  'Keep Orbital open while it reads and imports your posts.',
  PHOTOS_REDOWNLOAD_NOTE,
];

/**
 * Where "Open Accounts Center" goes. `Linking.openURL` only — never a WebView.
 *
 * Verified 2026-11-16: both resolve (302 to the platform's login with `next=`
 * preserved, so the member lands on Download your information after signing
 * in). A bogus sibling path answers 404, which is the control that makes the
 * 302 meaningful.
 */
export const ACCOUNTS_CENTER_URL: Readonly<Record<ImportSource, string>> = {
  facebook: 'https://accountscenter.facebook.com/info_and_permissions/dyi',
  instagram: 'https://accountscenter.instagram.com/info_and_permissions/dyi',
};

export const ACCOUNTS_CENTER_LINK_LABEL = 'Open Accounts Center';

export const CHOOSE_FILES_LABEL = 'Choose export files';

// ---------------------------------------------------------------------------
// §4.2 — parse, preflight, refusals
// ---------------------------------------------------------------------------

export const PARSING_TITLE = 'Reading your export…';

export function describeParseProgress(postsSeen: number, mediaPeeked: number): readonly string[] {
  return [`${plural(postsSeen, 'post')} found so far`, `Checked ${plural(mediaPeeked, 'photo')}`];
}

export const PARSE_CANCEL_LABEL = 'Cancel';

/** What a failed pick tells the member (§4.2). */
export const PICK_FAILURE_COPY: Readonly<Record<PickFailureReason, string>> = {
  archive:
    "Orbital couldn't read those files. Make sure you picked the ZIP files from " +
    'Meta, including every part, and that Format was JSON.',
  key_pending: "This orbit's encryption key hasn't reached this phone yet. Try again in a minute.",
  network:
    "Couldn't reach the server to check your import allowance. Nothing was " +
    'imported. Try again.',
  other: 'Something went wrong while reading your export. Nothing was imported. Try again.',
};

/** Preflight and summary alike. Parse-time and extract-time holds together. */
export function describeHeldVideoLine(heldVideo: number): string {
  return (
    `${plural(heldVideo, 'video post')} will be importable in a future update. ` +
    'Keep your export file.'
  );
}

/**
 * The preflight body (§4.2), in order.
 *
 * A preflight REBUILT at launch has `summary === null`: no date range, no file
 * issues, no location line and no other-source line, because none of that is
 * persisted and inventing it would hand the member made-up facts.
 */
export function describePreflightLines(
  preflight: ImportPreflight,
  source: ImportSource,
  now: number = Date.now(),
): readonly string[] {
  const lines: string[] = [];
  const summary = preflight.summary;

  const media = summary?.importableMedia ?? 0;
  lines.push(
    media > 0
      ? `${plural(preflight.importable, 'post')} ready to import with ${plural(media, 'photo')}`
      : `${plural(preflight.importable, 'post')} ready to import`,
  );

  if (summary !== null && summary.earliestDate !== null && summary.latestDate !== null) {
    lines.push(
      `From ${formatDateWithYear(summary.earliestDate, 'utc')} to ` +
        `${formatDateWithYear(summary.latestDate, 'utc')}`,
    );
  }

  if (summary?.locationDataRemoved === true) {
    lines.push("Location data is removed from photos before they're uploaded.");
  }

  if (summary?.otherSourceDetected === true) {
    const other = SOURCE_LABEL[OTHER_SOURCE[source]];
    lines.push(`This export also has ${other} posts. To import them, choose Import from ${other}.`);
  }

  lines.push(
    `This import is about ${formatMB(preflight.estimatedBytes)}. You can import ` +
      `${preflight.remainingPosts} more posts and ${formatMB(preflight.remainingBytes)} ` +
      'into this orbit.',
  );

  if (preflight.heldVideo > 0) {
    lines.push(describeHeldVideoLine(preflight.heldVideo));
    const roomLeft = preflight.remainingPosts - preflight.importable;
    if (roomLeft < preflight.heldVideo) {
      lines.push(describeAllowanceWarning(roomLeft, preflight.heldVideo));
    }
  }

  const retention = describeRetentionLine(preflight.contentRetentionDays, now);
  if (retention !== null) lines.push(retention);

  lines.push(PHOTOS_REDOWNLOAD_NOTE);
  return lines;
}

/**
 * Post counts only — there is no byte estimate for a held video, so promising
 * one would be a number we cannot stand behind.
 */
export function describeAllowanceWarning(roomLeft: number, heldVideo: number): string {
  return (
    `After this import you'll have room for ${roomLeft} more posts in this orbit, ` +
    `but your ${heldVideo} video posts will need ${heldVideo}. To leave room for ` +
    'them, export a smaller date range now.'
  );
}

/**
 * Retention counts from the IMPORT date, not the original one: the backend
 * sweep keys on `threads.created_at`, and the original date lives separately.
 * Local time, worded "on or after", because the sweep is hourly.
 */
export function describeRetentionLine(
  contentRetentionDays: number | null,
  now: number = Date.now(),
): string | null {
  if (contentRetentionDays === null) return null;
  const deleteAt = now + contentRetentionDays * 24 * 60 * 60 * 1000;
  return (
    `This orbit deletes posts ${contentRetentionDays} days after they're added. ` +
    'Imported posts count from the day you import them, not their original date, ' +
    `so these will be deleted on or after ${formatDateWithYear(deleteAt)}.`
  );
}

export function describeSkipSummaryLine(skipped: number): string {
  return `${plural(skipped, 'post')} won't be imported`;
}

export function describeFileIssueSummaryLine(fileIssues: number): string {
  return `${plural(fileIssues, 'file')} in the export couldn't be read`;
}

export const SEE_UNMIGRATED_LABEL = "See what won't be imported";

/** The same list, AFTER the run: the tense is the only difference. */
export const SEE_UNMIGRATED_PAST_LABEL = "See what wasn't imported";

/** Screen titles. Short, because a native header truncates. */
export const IMPORT_SCREEN_TITLE = 'Import';
export const UNMIGRATED_SCREEN_TITLE = 'Not imported';

/**
 * The list screen with nothing in it.
 *
 * Reachable: the summary's counts come from the run, the list from a bounded
 * query, and a job whose rows were cleared out from under it would otherwise
 * show a blank screen with no explanation.
 */
export const UNMIGRATED_EMPTY_COPY = 'There is nothing to list for this import.';

export function describeImportButton(importable: number): string {
  return `Import ${plural(importable, 'post')}`;
}

export const DONT_IMPORT_LABEL = "Don't import";

/** §4.2 refusals. `overAllowance` decides which. */
export function describeRefusal(preflight: ImportPreflight): string {
  if (preflight.overAllowance === 'bytes') {
    return (
      `This archive's photos come to about ${formatMB(preflight.estimatedBytes)} but ` +
      `you can import ${formatMB(preflight.remainingBytes)} more into this orbit. ` +
      'Export a smaller date range or a lower media quality from Meta and try again.'
    );
  }
  return (
    `This archive has ${preflight.importable} posts but you can import ` +
    `${preflight.remainingPosts} more into this orbit. Export a smaller date range ` +
    'from Meta and try again.'
  );
}

export const NOTHING_TO_IMPORT_COPY = "There's nothing in this export that Orbital can import.";

export const DIFFERENT_ARCHIVE_TITLE = 'Different files';

export const DIFFERENT_ARCHIVE_COPY =
  "These files don't match the export this import started with, so the import " +
  'was reset. Nothing was imported yet. Choose your export files again to start over.';

export const DIFFERENT_ARCHIVE_CHOOSE_LABEL = 'Choose files';
export const DIFFERENT_ARCHIVE_DISMISS_LABEL = 'Not now';

export const BLOCKED_COPY =
  "Orbital couldn't check your import allowance, so this import is waiting.";

export const BLOCKED_RETRY_LABEL = 'Retry';
export const START_OVER_LABEL = 'Start over';
export const NO_IMPORT_COPY = 'No import in progress.';
export const DONE_LABEL = 'Done';
export const CHECKING_COPY = 'Checking for an import…';

export const STOP_IMPORT_LABEL = 'Stop import';
export const STOP_IMPORT_CONFIRM_TITLE = 'Stop this import?';
export const STOP_IMPORT_CONFIRM_BODY =
  'Posts already imported stay in the orbit. To import the rest, pick the archive again.';

/** The running view's sub-line (§2 gap 3). */
export function describeMediaProgress(mediaDone: number): string {
  return `${plural(mediaDone, 'photo')} uploaded`;
}

export function describeRunProgress(done: number, total: number): string {
  return `Imported ${done} of ${total} posts`;
}

// ---------------------------------------------------------------------------
// §4.3 — pause causes and the stalled state
// ---------------------------------------------------------------------------

export interface PauseCopy {
  /** The sentence on the status screen. */
  readonly title: string;
  /** The one-line strip/Settings-row form. Count-free by construction. */
  readonly strip: string;
  /** The action button, `null` when waiting is the only thing to do. */
  readonly action: string | null;
  /**
   * A countdown is shown for this cause when `resumeAtMs` is in the future.
   * Only the two scheduled waits qualify; the rest clear on an event.
   */
  readonly countdown: boolean;
}

export const PAUSE_COPY: Readonly<Record<PauseCause, PauseCopy>> = {
  needs_repick: {
    title:
      'Orbital lost access to your export files. Pick the same ZIP files again, ' +
      'every part, to continue.',
    strip: 'Import paused: pick your files again',
    action: 'Pick files again',
    countdown: false,
  },
  key_pending: {
    title:
      "Waiting for this orbit's encryption key to reach this phone. This usually " +
      'takes under a minute.',
    strip: 'Import waiting for encryption key',
    action: 'Retry now',
    countdown: false,
  },
  archive_retry: {
    title: 'Having trouble reading your export files. Retrying automatically.',
    strip: 'Import retrying',
    action: 'Retry now',
    countdown: false,
  },
  rate_limited: {
    title: 'The server asked Orbital to slow down.',
    strip: 'Import resuming shortly',
    action: null,
    countdown: true,
  },
  allowance_wait: {
    title: 'Waiting for recent uploads to be counted against your allowance.',
    strip: 'Import resuming shortly',
    action: null,
    countdown: true,
  },
  network: {
    title: 'Waiting for a connection. The import continues automatically.',
    strip: 'Import waiting for connection',
    action: 'Retry now',
    countdown: false,
  },
  background: {
    title: 'Paused while Orbital was in the background. Keep Orbital open to finish.',
    strip: 'Import paused',
    action: null,
    countdown: false,
  },
};

/**
 * The paused sentence, with the countdown tail the two scheduled waits carry.
 *
 * `msRemaining === null` (or past) keeps the vaguer "Resuming shortly.": a
 * countdown that has run out and a pause with no deadline read the same to a
 * member, and neither should claim a time we don't have.
 */
export function describePauseTitle(cause: PauseCause, msRemaining: number | null): string {
  const copy = PAUSE_COPY[cause];
  if (!copy.countdown) return copy.title;
  if (msRemaining === null || msRemaining <= 0) return `${copy.title} Resuming shortly.`;
  return `${copy.title} Resuming in ${formatCountdown(msRemaining)}.`;
}

/** The pre-run retry budget is spent: nothing moves until the member taps. */
export const STALLED_COPY: Readonly<Record<'key_pending' | 'other', string>> = {
  key_pending: "This orbit's encryption key still hasn't reached this phone.",
  other: "Couldn't reach the server, so the import is paused.",
};

export const STALLED_STRIP = 'Import paused, tap to retry';
export const STALLED_ACTION_LABEL = 'Retry';

export function describeStalled(cause: PauseCause | null): string {
  return cause === 'key_pending' ? STALLED_COPY.key_pending : STALLED_COPY.other;
}

// ---------------------------------------------------------------------------
// §3.1 strip / Settings status line
// ---------------------------------------------------------------------------

/**
 * The one-line form of a view: the status strip, and the Settings status row.
 *
 * COUNT-FREE on purpose. The Settings section reads this, and a label carrying
 * "12 of 300" would put that screen on the runner's 250 ms emission stream.
 * `null` means the view has no line at all, which is also what hides the strip.
 */
const STRIP_LINE: Readonly<Record<ImportViewKind, string | null>> = {
  checking: null,
  none: null,
  blocked: 'Import waiting to continue',
  parsing: 'Reading your export…',
  nothing: null,
  refused: null,
  preflight: 'Import ready to review',
  running: 'Importing…',
  stalled: STALLED_STRIP,
  repick: PAUSE_COPY.needs_repick.strip,
  // Overridden per cause below; the table entry is the no-cause fallback.
  paused: 'Import paused',
  completed: 'Import finished',
  cancelled: 'Import stopped',
  failed: 'Import stopped early',
};

export function describeStripLine(view: ImportView): string | null {
  if (view.kind === 'paused' && view.cause !== null) return PAUSE_COPY[view.cause].strip;
  return STRIP_LINE[view.kind];
}

// ---------------------------------------------------------------------------
// §3.5 — what the announcer says on a KIND transition
// ---------------------------------------------------------------------------

/**
 * The accessibility announcement for a transition INTO `view`, or `null` when
 * the transition is not worth interrupting a screen reader for.
 *
 * Announced on the kind CHANGE only — never per tick. The countdown and the
 * per-post counters are deliberately silent: a live region on either would
 * talk over everything else the member is doing.
 *
 * "Import continued", not "resumed": §4.4's rule against that word is
 * unqualified, and the brand audit holds this whole module to it.
 */
export function describeImportAnnouncement(
  view: ImportView,
  previousKind: ImportViewKind | null,
  total: number,
  summary: ImportSummary | null,
): string | null {
  switch (view.kind) {
    case 'parsing':
      return 'Reading your export';
    case 'preflight':
      return 'Import ready to review';
    case 'running':
      if (previousKind === 'paused' || previousKind === 'stalled' || previousKind === 'repick') {
        return 'Import continued';
      }
      return `Importing ${plural(total, 'post')}`;
    case 'paused':
    case 'repick':
    case 'stalled': {
      const line = describeStripLine(view);
      return line === null ? 'Import paused' : `Import paused. ${line}`;
    }
    case 'completed':
    case 'cancelled':
    case 'failed':
      return summary === null ? null : describeSummaryHeadline(summary);
    case 'checking':
    case 'none':
    case 'blocked':
    case 'nothing':
    case 'refused':
      return null;
  }
}

// ---------------------------------------------------------------------------
// §4.4 — summary and terminal codes
// ---------------------------------------------------------------------------

export type SummaryKind = 'completed' | 'cancelled' | 'failed';

export const SUMMARY_HEADLINE: Readonly<Record<SummaryKind, string>> = {
  completed: 'Import finished',
  cancelled: 'Import stopped',
  failed: 'Import stopped early',
};

/**
 * What the member does next about a terminal code.
 *
 * The word "resume" never appears: a `failed` job is NOT resumable —
 * `finishImportJob` NULLs every unsent body — so recovery is a fresh pick in
 * which the already-created posts come back as duplicates.
 */
export type NextAction = 'repick' | 'free_space' | 'later' | 'none';

export const NEXT_TRAILER: Readonly<Record<NextAction, string | null>> = {
  repick:
    'Posts already imported are kept. Pick the archive again to finish. Anything ' +
    'already imported is skipped.',
  free_space: 'Free up space in this orbit, then pick the archive again to finish.',
  later: 'Try again later.',
  none: null,
};

export interface TerminalCopy {
  readonly detail: string;
  readonly next: NextAction;
}

export const TERMINAL_COPY: Readonly<Record<ImportTerminalCode, TerminalCopy>> = {
  ALLOWANCE: {
    detail: "You've reached your import allowance for this orbit.",
    next: 'none',
  },
  ARCHIVE: {
    detail: "Orbital couldn't keep reading your export files.",
    next: 'repick',
  },
  AUTH: { detail: 'You were signed out, so the import stopped.', next: 'repick' },
  CLIENT_BUG: {
    detail: 'Something went wrong on this phone and the import stopped.',
    next: 'repick',
  },
  CRYPTO: { detail: "This orbit's encryption key couldn't be used.", next: 'repick' },
  FORBIDDEN: { detail: 'You can no longer post in this orbit.', next: 'none' },
  IMPORTS_UNAVAILABLE: { detail: "Importing isn't available right now.", next: 'later' },
  KEY_PENDING: {
    detail: "This orbit's encryption key didn't reach this phone in time.",
    next: 'repick',
  },
  NETWORK: { detail: "Orbital couldn't reach the server for too long.", next: 'repick' },
  ORBIT_FULL: { detail: "This orbit's storage is full.", next: 'free_space' },
  REFUSED: { detail: "The server didn't accept part of this import.", next: 'repick' },
  SESSION_CLOSED: {
    detail: 'The server closed this import before it finished.',
    next: 'repick',
  },
};

export const CANCELLED_COPY =
  'You stopped the import. Posts already imported stay in the orbit. To import ' +
  'the rest, pick the archive again. Posts already imported are skipped automatically.';

/** The summary headline for a settled run. */
export function describeSummaryHeadline(summary: ImportSummary): string {
  if (summary.cancelled) return SUMMARY_HEADLINE.cancelled;
  return SUMMARY_HEADLINE[summary.errorCode === null ? 'completed' : 'failed'];
}

/**
 * Posts that were skipped for a reason the member hasn't already been told
 * about on another line.
 *
 * `held_video` has its own line and `summary.heldVideo` already folds the
 * parse-time holds in; `duplicate_in_archive` has its own line too. Counting
 * either here would tell the member about the same post twice.
 */
export function skippedOther(summary: ImportSummary): number {
  let total = 0;
  for (const reason of Object.keys(summary.skippedByReason) as SkipReason[]) {
    if (reason === 'held_video' || reason === 'duplicate_in_archive') continue;
    total += summary.skippedByReason[reason];
  }
  return total;
}

/**
 * The summary body (§4.4), in order. Zero-valued lines are left out.
 *
 * `preflight` is what carries the orbit's retention policy — the summary
 * itself has no allowance or policy fields — so the "these will be deleted on
 * or after …" line can only be shown here when the run's own preflight is
 * still in hand.
 */
export function describeSummaryLines(
  summary: ImportSummary,
  preflight: ImportPreflight | null,
  now: number = Date.now(),
): readonly string[] {
  const lines: string[] = [];

  if (summary.created > 0) lines.push(`${plural(summary.created, 'post')} imported`);
  if (summary.duplicate > 0) {
    lines.push(`${summary.duplicate} ${wasWere(summary.duplicate)} already in this orbit`);
  }
  if (summary.heldVideo > 0) lines.push(describeHeldVideoLine(summary.heldVideo));
  if (summary.failed > 0) {
    lines.push(`${summary.failed} couldn't be imported`);
  }
  if (summary.notSubmitted > 0) {
    lines.push(`${summary.notSubmitted} weren't sent before the import stopped`);
  }
  const other = skippedOther(summary);
  if (other > 0) lines.push(`${other} weren't imported`);

  const inArchive = summary.skippedByReason.duplicate_in_archive;
  if (inArchive > 0) {
    lines.push(
      `${plural(inArchive, 'post')} appeared more than once in your export and ` +
        'were imported once',
    );
  }

  if (summary.cancelled) lines.push(CANCELLED_COPY);

  if (summary.errorCode !== null) {
    const terminal = TERMINAL_COPY[summary.errorCode];
    lines.push(terminal.detail);
    const trailer = NEXT_TRAILER[terminal.next];
    if (trailer !== null) lines.push(trailer);
  }

  if (summary.created > 0) {
    const retention = describeRetentionLine(preflight?.contentRetentionDays ?? null, now);
    if (retention !== null) lines.push(retention);
    lines.push(PHOTOS_REDOWNLOAD_NOTE);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// §4.5 — the "what didn't migrate" list
// ---------------------------------------------------------------------------

export const SKIP_REASON_COPY: Readonly<Record<SkipReason, string>> = {
  held_video: 'Contains a video, will import in a future update',
  unsupported_image_format: "Photo is in a format Orbital can't import",
  image_too_large: 'Photo is too large to import',
  media_missing: 'A photo is missing from the files you picked',
  media_unsupported_reference: "Refers to media that isn't in the export",
  media_unreadable: "A photo in the export couldn't be read",
  unsupported_post_type: "Life events and events aren't imported",
  empty_post: 'Post has no text or photos',
  text_too_long: 'Text is longer than Orbital allows',
  invalid_timestamp: 'Post date is outside the dates Orbital accepts',
  missing_timestamp: 'Post has no date',
  duplicate_in_archive: 'Appears more than once in your export',
  malformed_post: 'Post data in the export is damaged or unrecognised',
};

export const FILE_ISSUE_COPY: Readonly<Record<FileIssueReason, string>> = {
  json_too_large: 'File is too large to read',
  json_too_deep: "File is structured in a way Orbital can't read safely",
  json_unparseable: "File is damaged or isn't JSON. Check that Format was JSON",
  json_entry_skipped: "File couldn't be opened from the ZIP",
  json_too_many_media:
    'File lists more photos than Orbital can check at once, so its photo posts ' +
    "weren't imported. Export a smaller date range.",
  archive_too_large:
    'Export has more posts than Orbital can read at once. Export a smaller date range.',
};

export const FAILED_ITEM_COPY: Readonly<Record<ImportFailedItemCode, string>> = {
  IMPORT_ITEM_INVALID: "The server didn't accept this post",
  IMPORT_ITEM_TOO_LARGE: 'Post is too large to send',
  IMPORT_MEDIA_UNSUPPORTED: "A photo's format isn't supported",
  IMPORT_MEDIA_TOO_LARGE: 'A photo is too large to import',
  IMPORT_MEDIA_UNAVAILABLE: "A photo couldn't be read from your export",
  QUOTA: "The orbit ran out of storage for this post's photos",
  IMPORT_DATE_INVALID: "The server didn't accept this post's date",
  IMPORT_MEDIA_NOT_OWNED: "A photo upload couldn't be matched to this post",
  IMPORT_RESULT_UNKNOWN: "This post couldn't be imported",
};

/** The groups the list is cut into, in display order. */
export type UnmigratedGroupKey = 'held' | 'incomplete' | 'failed' | 'not_sent' | 'permanent';

export interface UnmigratedGroupCopy {
  readonly header: string;
  /** The group's shared explanation; `null` when each row carries its own. */
  readonly subline: string | null;
}

export const UNMIGRATED_GROUP_COPY: Readonly<Record<UnmigratedGroupKey, UnmigratedGroupCopy>> = {
  held: {
    header: 'Held for a future update',
    subline:
      "Orbital doesn't import videos yet. Keep your export file so these can be " +
      'imported later.',
  },
  incomplete: {
    header: 'Missing from the files you picked',
    subline: 'Pick the archive again and select every ZIP part to import these.',
  },
  failed: { header: "Couldn't be imported", subline: null },
  not_sent: {
    header: 'Not sent before the import stopped',
    subline: 'Pick the archive again to finish. Posts already imported are skipped.',
  },
  permanent: {
    header: "Can't be imported",
    subline: "Importing again won't change these.",
  },
};

export const FILE_ISSUE_GROUP_HEADER = "Files Orbital couldn't read";

/** A row whose post was never sent carries no code of its own. */
export const NOT_SENT_ROW_COPY = 'Not sent before the import stopped';

const GROUP_ORDER: readonly UnmigratedGroupKey[] = [
  'held',
  'incomplete',
  'failed',
  'not_sent',
  'permanent',
];

function groupKeyFor(item: UnmigratedImportItem): UnmigratedGroupKey {
  switch (item.kind) {
    case 'skipped':
      return SKIP_REASON_CLASS[item.reason];
    case 'failed':
      return 'failed';
    case 'not_sent':
      return 'not_sent';
  }
}

export interface UnmigratedGroup {
  readonly key: UnmigratedGroupKey;
  readonly header: string;
  readonly subline: string | null;
  readonly items: readonly UnmigratedImportItem[];
}

/**
 * Cut the list into §4.5's groups, keeping each group's rows in the order they
 * arrived (ordinal). Empty groups are dropped.
 */
export function groupUnmigrated(
  items: readonly UnmigratedImportItem[],
): readonly UnmigratedGroup[] {
  const buckets = new Map<UnmigratedGroupKey, UnmigratedImportItem[]>();
  for (const item of items) {
    const key = groupKeyFor(item);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [item]);
    else bucket.push(item);
  }

  const groups: UnmigratedGroup[] = [];
  for (const key of GROUP_ORDER) {
    const bucket = buckets.get(key);
    if (bucket === undefined || bucket.length === 0) continue;
    groups.push({
      key,
      header: UNMIGRATED_GROUP_COPY[key].header,
      subline: UNMIGRATED_GROUP_COPY[key].subline,
      items: bucket,
    });
  }
  return groups;
}

/** Why this one row didn't migrate. */
export function describeUnmigratedReason(item: UnmigratedImportItem): string {
  switch (item.kind) {
    case 'skipped':
      return SKIP_REASON_COPY[item.reason];
    case 'failed':
      return FAILED_ITEM_COPY[item.code];
    case 'not_sent':
      return NOT_SENT_ROW_COPY;
  }
}

/**
 * "Mar 4, 2019 · your_posts_1.json" — the row's identity line.
 *
 * The ORIGINAL post date, so it matches the imported threads: the server
 * stores that date as a UTC calendar day.
 */
export function describeUnmigratedRow(item: UnmigratedImportItem): string {
  const date = item.originalDate === null ? '' : formatDateWithYear(item.originalDate, 'utc');
  return `${date === '' ? 'No date' : date} · ${item.sourceFile ?? 'Unknown file'}`;
}

/**
 * The screen-reader form of {@link describeUnmigratedRow}: the month is
 * spelled out and the two halves are read as a sentence, because "Mar 4, 2019
 * · your_posts_1.json" is an abbreviation followed by a punctuation mark
 * VoiceOver has no good reading for.
 */
export function describeUnmigratedRowA11y(item: UnmigratedImportItem): string {
  const date = item.originalDate === null ? '' : formatDateWithYearA11y(item.originalDate, 'utc');
  const file = item.sourceFile ?? 'an unknown file';
  return `${date === '' ? 'No date' : date}, from ${file}. ${describeUnmigratedReason(item)}`;
}

export function describeFileIssueRow(issue: FileIssue): string {
  return `${issue.sourceFile} · ${FILE_ISSUE_COPY[issue.reason]}`;
}

/**
 * The footer under a capped list, in the list AND in the shared text.
 *
 * It exists because the read is bounded at {@link SHARE_ROW_CAP}: an export
 * can hold fifty thousand unmigrated rows, and materialising them on the JS
 * thread to say so would freeze the screen that is explaining itself.
 */
export function describeMoreFooter(truncated: number): string {
  return `…and ${truncated} more not listed`;
}

export const SHARE_LIST_LABEL = 'Share list';

/**
 * The same ceiling the repository read is capped at (§6): the JS thread never
 * materialises more rows than the screen displays, and the text stays well
 * under Android's binder limit.
 */
export const SHARE_ROW_CAP = 1000;

function totalUnmigrated(counts: UnmigratedCounts): number {
  let total = counts.notSent;
  for (const value of Object.values(counts.skipped)) total += value ?? 0;
  for (const value of Object.values(counts.failed)) total += value ?? 0;
  return total;
}

/**
 * The shareable plain-text list.
 *
 * Dates, basenames and reason text only — never a body, an orbit name, an id
 * or a key. It leaves the device solely through the OS share sheet, on an
 * explicit tap.
 */
export function buildUnmigratedShareText(
  items: readonly UnmigratedImportItem[],
  counts: UnmigratedCounts,
  fileIssues: readonly FileIssue[],
  source: ImportSource,
): string {
  const shown = items.slice(0, SHARE_ROW_CAP);
  const lines: string[] = [`Posts not imported from your ${SOURCE_LABEL[source]} export`, ''];

  for (const item of shown) {
    lines.push(`${describeUnmigratedRow(item)} · ${describeUnmigratedReason(item)}`);
  }

  const remaining = totalUnmigrated(counts) - shown.length;
  if (remaining > 0) lines.push(describeMoreFooter(remaining));

  if (fileIssues.length > 0) {
    lines.push('', FILE_ISSUE_GROUP_HEADER);
    for (const issue of fileIssues) lines.push(describeFileIssueRow(issue));
  }

  return lines.join('\n');
}
