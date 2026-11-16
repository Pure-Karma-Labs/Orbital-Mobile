// ---------------------------------------------------------------------------
// THIS SUITE DECLARES NO `jest.mock` CALLS — DELIBERATELY.
//
// `importCopy.ts` claims purity in its own header: no React, no `importRunner`
// at runtime, no device state. That claim is only worth something if something
// checks it, and the check is the ABSENCE of mocks here. Every runner symbol
// the module needs is a type-only import; its one runtime value import is
// `SKIP_REASON_CLASS` from the parser's dependency-free `types.ts`. If anyone
// adds a runtime import of the runner, the store, a screen or a native module
// to `importCopy.ts`, this file stops loading at all (the runner reaches
// MMKV → NitroModules, which throws under Jest) rather than quietly needing a
// mock — see "purity" below, which requires the module with no mocks in scope.
//
// For the same reason the TYPE imports below are all `import type`: an erased
// import cannot drag a native module in, and `importRunner.ts` in particular
// reaches native modules at runtime.
// ---------------------------------------------------------------------------

import { SKIP_REASON_CLASS } from '../../../services/metaImport/types';
import * as copy from '../importCopy';
import {
  ACCOUNTS_CENTER_URL,
  CANCELLED_COPY,
  FAILED_ITEM_COPY,
  FILE_ISSUE_COPY,
  FILE_ISSUE_GROUP_HEADER,
  NEXT_TRAILER,
  PAUSE_COPY,
  PHOTOS_REDOWNLOAD_NOTE,
  PICK_FAILURE_COPY,
  SHARE_ROW_CAP,
  SKIP_REASON_COPY,
  SOURCE_LABEL,
  SUMMARY_HEADLINE,
  TERMINAL_COPY,
  UNMIGRATED_GROUP_COPY,
  buildUnmigratedShareText,
  deriveImportView,
  describeMoreFooter,
  describeSummaryLines,
  formatCountdown,
  plural,
  skippedOther,
  totalUnmigrated,
} from '../importCopy';

import type { ImportAllowance, ImportLimits } from '../../../types/api';
import type { ImportTerminalCode } from '../../../services/metaImport/importErrors';
import type { ImportPreflight, ImportSummary } from '../../../services/metaImport/importRunner';
import type { PauseCause } from '../../../services/metaImport/importErrors';
import type {
  FileIssue,
  FileIssueReason,
  ImportSource,
  ParseSummary,
  SkipReason,
} from '../../../services/metaImport/types';
import type {
  ImportFailedItemCode,
  PickFailureReason,
  UnmigratedCounts,
  UnmigratedImportItem,
} from '../../../services/metaImport/importRunner';
import type {
  ImportView,
  ImportViewInput,
  ImportViewKind,
  NextAction,
  SummaryKind,
  UnmigratedGroupKey,
} from '../importCopy';

// ---------------------------------------------------------------------------
// Union key sets
//
// `SkipReason` has a runtime registry that is safe to import (`types.ts`
// imports nothing), so it is read from the source of truth.
//
// FALLBACK, as allowed by the brief: `IMPORT_TERMINAL_CODES` /
// `IMPORT_ITEM_FAILURE_CODES` (`importErrors.ts`) and `IMPORT_ITEM_CODES`
// (`importBatch.ts`) are NOT imported at runtime. Both modules reach
// `services/crypto/importCrypto` → `stores/useAppStore` → `react-native-mmkv`
// → `NitroModules`, and `TurboModuleRegistry.getEnforcing('NitroModules')`
// throws under Jest, so the import alone fails the suite — and mocking it away
// is exactly what this file may not do (see the header).
//
// The lists are therefore spelled out HERE, but they are not a hand-maintained
// guess: `unionKeys<T>` takes a `Record<T, true>` object literal, so a member
// added to (or removed from) the union in `importErrors.ts` / `importBatch.ts`
// is a COMPILE error in this file. That is the same exhaustiveness guarantee
// the frozen registries give, enforced by `tsc --noEmit` instead of at runtime.
// ---------------------------------------------------------------------------

/** Exhaustive by construction: a missing OR extra member fails to typecheck. */
function unionKeys<T extends string>(present: Readonly<Record<T, true>>): readonly T[] {
  return Object.keys(present) as T[];
}

const SKIP_REASONS = Object.keys(SKIP_REASON_CLASS) as readonly SkipReason[];

const PAUSE_CAUSES = unionKeys<PauseCause>({
  needs_repick: true,
  key_pending: true,
  archive_retry: true,
  rate_limited: true,
  allowance_wait: true,
  network: true,
  background: true,
});

const TERMINAL_CODES = unionKeys<ImportTerminalCode>({
  ALLOWANCE: true,
  ARCHIVE: true,
  AUTH: true,
  CLIENT_BUG: true,
  CRYPTO: true,
  FORBIDDEN: true,
  IMPORTS_UNAVAILABLE: true,
  KEY_PENDING: true,
  NETWORK: true,
  ORBIT_FULL: true,
  REFUSED: true,
  SESSION_CLOSED: true,
});

const FAILED_ITEM_CODES = unionKeys<ImportFailedItemCode>({
  IMPORT_ITEM_INVALID: true,
  IMPORT_ITEM_TOO_LARGE: true,
  IMPORT_MEDIA_UNSUPPORTED: true,
  IMPORT_MEDIA_UNAVAILABLE: true,
  QUOTA: true,
  IMPORT_DATE_INVALID: true,
  IMPORT_MEDIA_NOT_OWNED: true,
  IMPORT_MEDIA_TOO_LARGE: true,
  IMPORT_RESULT_UNKNOWN: true,
});

const FILE_ISSUE_REASONS = unionKeys<FileIssueReason>({
  json_too_large: true,
  json_too_deep: true,
  json_unparseable: true,
  json_entry_skipped: true,
  json_too_many_media: true,
  archive_too_large: true,
});

const VIEW_KINDS = unionKeys<ImportViewKind>({
  checking: true,
  none: true,
  blocked: true,
  parsing: true,
  nothing: true,
  refused: true,
  preflight: true,
  running: true,
  stalled: true,
  repick: true,
  paused: true,
  completed: true,
  cancelled: true,
  failed: true,
});

const NEXT_ACTIONS = unionKeys<NextAction>({
  repick: true,
  free_space: true,
  later: true,
  none: true,
});

const SUMMARY_KINDS = unionKeys<SummaryKind>({
  completed: true,
  cancelled: true,
  failed: true,
});

const GROUP_KEYS = unionKeys<UnmigratedGroupKey>({
  held: true,
  incomplete: true,
  failed: true,
  not_sent: true,
  permanent: true,
});

const PICK_FAILURE_REASONS = unionKeys<PickFailureReason>({
  archive: true,
  key_pending: true,
  network: true,
  other: true,
});

const SOURCES: readonly ImportSource[] = ['facebook', 'instagram'];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 2026-06-15T12:00:00Z — a pinned "now" so no assertion reads the real clock. */
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
/** 2019-03-04T12:00:00Z — the original date of an imported post. */
const MAR_4_2019 = Date.UTC(2019, 2, 4, 12, 0, 0);

const ALLOWANCE: ImportAllowance = {
  postsUsed: 10,
  bytesUsed: 1024 * 1024,
  postsLimit: 1000,
  bytesLimit: 2 * 1024 * 1024 * 1024,
};

const LIMITS: ImportLimits = {
  batchMax: 50,
  mediaPerItemMax: 20,
  metaMaxBytes: 65536,
  ivMax: 16,
  titleMax: 200,
  bodyMax: 10000,
  minDate: '2004-01-01',
  mediaContentClasses: ['image'],
};

function makeSkips(over: Partial<Record<SkipReason, number>> = {}): Record<SkipReason, number> {
  const zeros = {} as Record<SkipReason, number>;
  for (const reason of SKIP_REASONS) zeros[reason] = 0;
  return { ...zeros, ...over };
}

function makeParseSummary(over: Partial<ParseSummary> = {}): ParseSummary {
  return {
    importable: 12,
    importableMedia: 30,
    skipped: makeSkips(),
    earliestDate: MAR_4_2019,
    latestDate: Date.UTC(2021, 10, 9, 12, 0, 0),
    fileIssues: [],
    idScheme: { fbid: 12, content: 0 },
    otherSourceDetected: false,
    locationDataRemoved: true,
    ...over,
  };
}

function makePreflight(over: Partial<ImportPreflight> = {}): ImportPreflight {
  return {
    summary: null,
    allowance: ALLOWANCE,
    limits: LIMITS,
    contentRetentionDays: null,
    importable: 12,
    remainingPosts: 990,
    estimatedBytes: 42 * 1024 * 1024,
    remainingBytes: 1024 * 1024 * 1024,
    overAllowance: null,
    nothingToImport: false,
    heldVideo: 0,
    skippedByReason: makeSkips(),
    ...over,
  };
}

function makeSummary(over: Partial<ImportSummary> = {}): ImportSummary {
  return {
    created: 12,
    duplicate: 0,
    failed: 0,
    heldVideo: 0,
    skippedByReason: makeSkips(),
    notSubmitted: 0,
    errorCode: null,
    cancelled: false,
    ...over,
  };
}

function makeInput(over: Partial<ImportViewInput> = {}): ImportViewInput {
  return {
    phase: 'idle',
    jobId: null,
    preflight: null,
    pauseCauses: [],
    autoRetryExhausted: false,
    summary: null,
    ...over,
  };
}

function skippedRow(reason: SkipReason, index: number): UnmigratedImportItem {
  return {
    kind: 'skipped',
    reason,
    id: `id-secret-${index}`,
    originalDate: MAR_4_2019,
    sourceFile: `your_posts_${index % 3}.json`,
    sourceIndex: index,
  };
}

const FILE_ISSUES: readonly FileIssue[] = [
  { sourceFile: 'your_posts_9.json', reason: 'json_too_large' },
  { sourceFile: 'your_posts_8.json', reason: 'json_unparseable' },
];

const SAMPLE_ITEMS: readonly UnmigratedImportItem[] = [
  skippedRow('held_video', 0),
  skippedRow('media_missing', 1),
  skippedRow('empty_post', 2),
  {
    kind: 'failed',
    code: 'QUOTA',
    id: 'id-secret-3',
    originalDate: null,
    sourceFile: null,
    sourceIndex: null,
  },
  {
    kind: 'not_sent',
    id: 'id-secret-4',
    originalDate: MAR_4_2019,
    sourceFile: 'your_posts_1.json',
    sourceIndex: 4,
  },
];

const SAMPLE_COUNTS: UnmigratedCounts = {
  skipped: { held_video: 1, media_missing: 1, empty_post: 1 },
  failed: { QUOTA: 1 },
  notSent: 1,
};

function view(kind: ImportViewKind, cause: PauseCause | null = null): ImportView {
  return { kind, cause };
}

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe('purity', () => {
  it('loads with no jest mocks in scope — no React, no runner, no native module', () => {
    jest.resetModules();
    // A fresh require, in a suite that registers no mock at all. If the module
    // ever gained a runtime dependency on the runner, the store or a screen,
    // this throws `TurboModuleRegistry.getEnforcing('NitroModules')`.
    const fresh = require('../importCopy') as typeof copy;
    expect(typeof fresh.deriveImportView).toBe('function');
    expect(fresh.SOURCE_LABEL.facebook).toBe('Facebook');
  });
});

// ---------------------------------------------------------------------------
// §3.1 — deriveImportView, one assertion per row of the plan's table
// ---------------------------------------------------------------------------

describe('deriveImportView (§3.1, every row)', () => {
  it('hydrating → checking', () => {
    expect(deriveImportView(makeInput({ phase: 'hydrating' }))).toEqual(view('checking'));
  });

  it('idle with no jobId → none', () => {
    expect(deriveImportView(makeInput({ phase: 'idle', jobId: null }))).toEqual(view('none'));
  });

  it('idle with a jobId → blocked (gap 2b: the preflight rebuild failed)', () => {
    expect(deriveImportView(makeInput({ phase: 'idle', jobId: 'job-1' }))).toEqual(view('blocked'));
  });

  it('parsing → parsing', () => {
    expect(deriveImportView(makeInput({ phase: 'parsing' }))).toEqual(view('parsing'));
  });

  it('ready with no preflight → none (defensive)', () => {
    expect(deriveImportView(makeInput({ phase: 'ready', preflight: null }))).toEqual(view('none'));
  });

  it('ready + nothingToImport → nothing', () => {
    const preflight = makePreflight({ nothingToImport: true, importable: 0 });
    expect(deriveImportView(makeInput({ phase: 'ready', preflight }))).toEqual(view('nothing'));
  });

  it('ready + overAllowance → refused', () => {
    const posts = makePreflight({ overAllowance: 'posts' });
    const bytes = makePreflight({ overAllowance: 'bytes' });
    expect(deriveImportView(makeInput({ phase: 'ready', preflight: posts }))).toEqual(
      view('refused'),
    );
    expect(deriveImportView(makeInput({ phase: 'ready', preflight: bytes }))).toEqual(
      view('refused'),
    );
  });

  it('ready and runnable → preflight', () => {
    const preflight = makePreflight();
    expect(deriveImportView(makeInput({ phase: 'ready', preflight }))).toEqual(view('preflight'));
  });

  it('running → running', () => {
    expect(deriveImportView(makeInput({ phase: 'running' }))).toEqual(view('running'));
  });

  it('paused + autoRetryExhausted → stalled, carrying the cause', () => {
    const result = deriveImportView(
      makeInput({ phase: 'paused', pauseCauses: ['key_pending'], autoRetryExhausted: true }),
    );
    expect(result).toEqual(view('stalled', 'key_pending'));
    expect(result.cause).toBe('key_pending');
  });

  it('paused with causes[0] === needs_repick → repick', () => {
    expect(deriveImportView(makeInput({ phase: 'paused', pauseCauses: ['needs_repick'] }))).toEqual(
      view('repick', 'needs_repick'),
    );
  });

  it('paused with any other cause → paused, carrying that cause', () => {
    for (const cause of PAUSE_CAUSES) {
      if (cause === 'needs_repick') continue;
      expect(deriveImportView(makeInput({ phase: 'paused', pauseCauses: [cause] }))).toEqual(
        view('paused', cause),
      );
    }
  });

  it('paused with an EMPTY cause set → running (defensive)', () => {
    expect(deriveImportView(makeInput({ phase: 'paused', pauseCauses: [] }))).toEqual(
      view('running'),
    );
  });

  it('done + cancelled → cancelled', () => {
    const summary = makeSummary({ cancelled: true });
    expect(deriveImportView(makeInput({ phase: 'done', summary }))).toEqual(view('cancelled'));
  });

  it('done with errorCode null → completed', () => {
    const summary = makeSummary({ errorCode: null });
    expect(deriveImportView(makeInput({ phase: 'done', summary }))).toEqual(view('completed'));
  });

  it('done with an errorCode → failed', () => {
    const summary = makeSummary({ errorCode: 'NETWORK' });
    expect(deriveImportView(makeInput({ phase: 'done', summary }))).toEqual(view('failed'));
  });

  it('done with no summary → none', () => {
    expect(deriveImportView(makeInput({ phase: 'done', summary: null }))).toEqual(view('none'));
  });

  describe('precedence', () => {
    it('nothingToImport beats overAllowance', () => {
      const preflight = makePreflight({
        nothingToImport: true,
        overAllowance: 'posts',
        importable: 0,
      });
      expect(deriveImportView(makeInput({ phase: 'ready', preflight }))).toEqual(view('nothing'));
    });

    it('autoRetryExhausted beats needs_repick', () => {
      expect(
        deriveImportView(
          makeInput({
            phase: 'paused',
            pauseCauses: ['needs_repick'],
            autoRetryExhausted: true,
          }),
        ),
      ).toEqual(view('stalled', 'needs_repick'));
    });
  });

  it('never carries a cause outside paused/repick/stalled', () => {
    const withoutCause: readonly ImportView[] = [
      deriveImportView(makeInput({ phase: 'hydrating' })),
      deriveImportView(makeInput({ phase: 'idle', jobId: 'job-1' })),
      deriveImportView(makeInput({ phase: 'parsing' })),
      deriveImportView(makeInput({ phase: 'running' })),
      deriveImportView(makeInput({ phase: 'done', summary: makeSummary() })),
    ];
    for (const result of withoutCause) expect(result.cause).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Record completeness: every key of every copy table maps to real copy
// ---------------------------------------------------------------------------

/** Asserts a non-blank string, naming the key in the failure message. */
function expectNonEmpty(value: unknown, label: string): void {
  const ok = typeof value === 'string' && value.trim().length > 0;
  expect(`${label} = ${ok ? 'non-empty string' : JSON.stringify(value)}`).toBe(
    `${label} = non-empty string`,
  );
}

describe('copy tables are complete and non-empty', () => {
  it('SKIP_REASON_COPY covers every SkipReason', () => {
    expect(Object.keys(SKIP_REASON_COPY).sort()).toEqual([...SKIP_REASONS].sort());
    for (const reason of SKIP_REASONS) {
      expectNonEmpty(SKIP_REASON_COPY[reason], `SKIP_REASON_COPY.${reason}`);
    }
  });

  it('FILE_ISSUE_COPY covers every FileIssueReason', () => {
    expect(Object.keys(FILE_ISSUE_COPY).sort()).toEqual([...FILE_ISSUE_REASONS].sort());
    for (const reason of FILE_ISSUE_REASONS) {
      expectNonEmpty(FILE_ISSUE_COPY[reason], `FILE_ISSUE_COPY.${reason}`);
    }
  });

  it('FAILED_ITEM_COPY covers every ImportFailedItemCode', () => {
    expect(Object.keys(FAILED_ITEM_COPY).sort()).toEqual([...FAILED_ITEM_CODES].sort());
    for (const code of FAILED_ITEM_CODES) {
      expectNonEmpty(FAILED_ITEM_COPY[code], `FAILED_ITEM_COPY.${code}`);
    }
  });

  it('PAUSE_COPY covers every PauseCause with a title and a strip', () => {
    expect(Object.keys(PAUSE_COPY).sort()).toEqual([...PAUSE_CAUSES].sort());
    for (const cause of PAUSE_CAUSES) {
      expectNonEmpty(PAUSE_COPY[cause].title, `PAUSE_COPY.${cause}.title`);
      expectNonEmpty(PAUSE_COPY[cause].strip, `PAUSE_COPY.${cause}.strip`);
      const action = PAUSE_COPY[cause].action;
      if (action !== null) expectNonEmpty(action, `PAUSE_COPY.${cause}.action`);
      expect(typeof PAUSE_COPY[cause].countdown).toBe('boolean');
    }
  });

  it('TERMINAL_COPY covers every ImportTerminalCode with a detail and a known next', () => {
    expect(Object.keys(TERMINAL_COPY).sort()).toEqual([...TERMINAL_CODES].sort());
    for (const code of TERMINAL_CODES) {
      expectNonEmpty(TERMINAL_COPY[code].detail, `TERMINAL_COPY.${code}.detail`);
      expect(NEXT_ACTIONS).toContain(TERMINAL_COPY[code].next);
    }
  });

  it('NEXT_TRAILER has copy for every action but "none"', () => {
    expect(Object.keys(NEXT_TRAILER).sort()).toEqual([...NEXT_ACTIONS].sort());
    for (const action of NEXT_ACTIONS) {
      if (action === 'none') {
        expect(NEXT_TRAILER.none).toBeNull();
        continue;
      }
      expectNonEmpty(NEXT_TRAILER[action], `NEXT_TRAILER.${action}`);
    }
  });

  it('SUMMARY_HEADLINE covers every SummaryKind', () => {
    expect(Object.keys(SUMMARY_HEADLINE).sort()).toEqual([...SUMMARY_KINDS].sort());
    for (const kind of SUMMARY_KINDS) {
      expectNonEmpty(SUMMARY_HEADLINE[kind], `SUMMARY_HEADLINE.${kind}`);
    }
  });

  it('UNMIGRATED_GROUP_COPY covers every group with a header', () => {
    expect(Object.keys(UNMIGRATED_GROUP_COPY).sort()).toEqual([...GROUP_KEYS].sort());
    for (const key of GROUP_KEYS) {
      expectNonEmpty(UNMIGRATED_GROUP_COPY[key].header, `UNMIGRATED_GROUP_COPY.${key}.header`);
      const subline = UNMIGRATED_GROUP_COPY[key].subline;
      if (subline !== null) expectNonEmpty(subline, `UNMIGRATED_GROUP_COPY.${key}.subline`);
    }
  });

  it('SOURCE_LABEL spells both platforms in full', () => {
    expect(Object.keys(SOURCE_LABEL).sort()).toEqual([...SOURCES].sort());
    expect(SOURCE_LABEL.facebook).toBe('Facebook');
    expect(SOURCE_LABEL.instagram).toBe('Instagram');
  });

  it('ACCOUNTS_CENTER_URL has an https URL per source', () => {
    expect(Object.keys(ACCOUNTS_CENTER_URL).sort()).toEqual([...SOURCES].sort());
    for (const source of SOURCES) {
      expectNonEmpty(ACCOUNTS_CENTER_URL[source], `ACCOUNTS_CENTER_URL.${source}`);
      expect(ACCOUNTS_CENTER_URL[source].startsWith('https://')).toBe(true);
    }
  });

  it('PICK_FAILURE_COPY covers every PickFailureReason', () => {
    expect(Object.keys(PICK_FAILURE_COPY).sort()).toEqual([...PICK_FAILURE_REASONS].sort());
    for (const reason of PICK_FAILURE_REASONS) {
      expectNonEmpty(PICK_FAILURE_COPY[reason], `PICK_FAILURE_COPY.${reason}`);
    }
  });

  it('describeStripLine answers for every view kind, and per pause cause', () => {
    for (const kind of VIEW_KINDS) {
      const line = copy.describeStripLine(view(kind));
      if (line !== null) expectNonEmpty(line, `STRIP_LINE.${kind}`);
    }
    for (const cause of PAUSE_CAUSES) {
      expect(copy.describeStripLine(view('paused', cause))).toBe(PAUSE_COPY[cause].strip);
    }
    // The no-cause fallback is the table entry, not a crash.
    expect(copy.describeStripLine(view('paused'))).toBe('Import paused');
  });
});

// ---------------------------------------------------------------------------
// skippedOther arithmetic
// ---------------------------------------------------------------------------

describe('skippedOther', () => {
  const summary = makeSummary({
    created: 0,
    heldVideo: 4,
    skippedByReason: makeSkips({
      held_video: 4,
      duplicate_in_archive: 3,
      empty_post: 5,
      text_too_long: 7,
    }),
  });

  it('sums only the reasons without a line of their own', () => {
    // 4 + 3 + 5 + 7 = 19 skipped in total; held_video and duplicate_in_archive
    // are reported on their own lines, so "other" is 5 + 7 = 12.
    expect(skippedOther(summary)).toBe(12);
  });

  it('is 0 when every skip has its own line', () => {
    expect(
      skippedOther(
        makeSummary({ skippedByReason: makeSkips({ held_video: 9, duplicate_in_archive: 2 }) }),
      ),
    ).toBe(0);
  });

  it('describeSummaryLines emits that number without double-counting', () => {
    const lines = describeSummaryLines(summary, null, NOW);
    expect(lines).toEqual([
      '4 video posts will be importable in a future update. Keep your export file.',
      "12 weren't imported",
      '3 posts appeared more than once in your export and were imported once',
    ]);
    // The totals that WOULD appear if held/duplicate were folded in.
    expect(lines).not.toContain("19 weren't imported");
    expect(lines).not.toContain("16 weren't imported");
    expect(lines).not.toContain("15 weren't imported");
  });
});

// ---------------------------------------------------------------------------
// The Share cap
// ---------------------------------------------------------------------------

describe('buildUnmigratedShareText', () => {
  const ORBIT_NAME = 'OrbitSecretName';
  const BODY = 'BODY-SECRET-never-share-this';

  const items: readonly UnmigratedImportItem[] = Array.from({ length: 1100 }, (_, i) =>
    skippedRow(SKIP_REASONS[i % SKIP_REASONS.length], i),
  );
  // Full totals, NOT capped and NOT items.length: 600 + 200 + 300 + 150 = 1250.
  const counts: UnmigratedCounts = {
    skipped: { held_video: 600, duplicate_in_archive: 200 },
    failed: { QUOTA: 300 },
    notSent: 150,
  };

  const text = buildUnmigratedShareText(items, counts, FILE_ISSUES, 'facebook');
  const lines = text.split('\n');

  it('caps the list at SHARE_ROW_CAP rows', () => {
    expect(SHARE_ROW_CAP).toBe(1000);
    expect(lines[0]).toBe('Posts not imported from your Facebook export');
    expect(lines[1]).toBe('');
    const rows = lines.slice(2, 2 + SHARE_ROW_CAP);
    expect(rows).toHaveLength(1000);
    for (const row of rows) expect(row).toMatch(/ · .+ · .+/);
  });

  it('derives the "more not listed" count from counts, not items.length', () => {
    // items.length − cap would be 100. The real remainder is 1250 − 1000.
    const footer = lines[2 + SHARE_ROW_CAP];
    expect(footer).toBe('…and 250 more not listed');
    // U+2026 HORIZONTAL ELLIPSIS, not three full stops.
    expect(footer.charCodeAt(0)).toBe(0x2026);
    expect(footer).not.toContain('...');
    expect(footer).not.toBe('…and 100 more not listed');
  });

  it('puts the file issues after the footer', () => {
    expect(lines[2 + SHARE_ROW_CAP + 1]).toBe('');
    expect(lines[2 + SHARE_ROW_CAP + 2]).toBe(FILE_ISSUE_GROUP_HEADER);
    expect(lines[2 + SHARE_ROW_CAP + 3]).toBe('your_posts_9.json · File is too large to read');
    expect(lines[2 + SHARE_ROW_CAP + 4]).toBe(
      "your_posts_8.json · File is damaged or isn't JSON. Check that Format was JSON",
    );
    expect(lines).toHaveLength(2 + SHARE_ROW_CAP + 5);
  });

  it('never carries an orbit name, a body or an id', () => {
    expect(text).not.toContain(ORBIT_NAME);
    expect(text).not.toContain(BODY);
    expect(text).not.toContain('id-secret');
  });

  it('omits the footer when nothing was left out', () => {
    const small = buildUnmigratedShareText(SAMPLE_ITEMS, SAMPLE_COUNTS, [], 'instagram');
    expect(small).not.toContain('more not listed');
    expect(small.split('\n')[0]).toBe('Posts not imported from your Instagram export');
  });
});

// ---------------------------------------------------------------------------
// totalUnmigrated — the one place the across-every-group sum is spelled
// ---------------------------------------------------------------------------

describe('totalUnmigrated', () => {
  it('sums every group, counting a missing key as zero', () => {
    expect(
      totalUnmigrated({
        skipped: { held_video: 4, empty_post: 5 },
        failed: { QUOTA: 2, IMPORT_RESULT_UNKNOWN: 1 },
        notSent: 3,
      }),
    ).toBe(15);
  });

  it('is 0 for an empty list', () => {
    expect(totalUnmigrated({ skipped: {}, failed: {}, notSent: 0 })).toBe(0);
  });

  it('is what the share footer counts from', () => {
    // The footer is `total − rows shown`, which is the whole reason the total
    // may not be derived from `items.length`.
    const counts: UnmigratedCounts = { skipped: { empty_post: 1250 }, failed: {}, notSent: 0 };
    const text = buildUnmigratedShareText(
      Array.from({ length: 1100 }, (_, i) => skippedRow('empty_post', i)),
      counts,
      [],
      'facebook',
    );
    expect(totalUnmigrated(counts)).toBe(1250);
    expect(text).toContain(describeMoreFooter(1250 - SHARE_ROW_CAP));
  });
});

// ---------------------------------------------------------------------------
// §5 BRAND AUDIT
//
// The audit walks `import * as copy` rather than an enumerated list, so a
// string ADDED to an existing const, array or Record is covered with no edit
// here. A new exported FUNCTION is covered too: `CALL_FIXTURES` below must name
// every exported function, and the first assertion fails loudly until it does.
// ---------------------------------------------------------------------------

type CallArgs = readonly unknown[];

const everySummaryWithTerminal: readonly CallArgs[] = TERMINAL_CODES.map((code) => [
  makeSummary({ errorCode: code, created: 3, notSubmitted: 2 }),
  makePreflight({ contentRetentionDays: 30 }),
  NOW,
]);

const CALL_FIXTURES: Readonly<Record<string, readonly CallArgs[]>> = {
  plural: [
    [1, 'post'],
    [2, 'post'],
    [0, 'photo'],
    [1, 'photo', 'photos'],
    [2, 'video post'],
  ],
  formatCountdown: [[0], [-1], [NaN], [Infinity], [245000], [59000], [3600000]],
  deriveImportView: [
    [makeInput({ phase: 'hydrating' })],
    [makeInput({ phase: 'idle', jobId: 'job-1' })],
    [makeInput({ phase: 'ready', preflight: makePreflight() })],
    [makeInput({ phase: 'paused', pauseCauses: ['network'] })],
    [makeInput({ phase: 'done', summary: makeSummary() })],
  ],
  describeStartRow: SOURCES.map((source) => [source]),
  describeIntoCaption: [['Family'], [null]],
  describeOtherOrbitCaption: [['Family'], [null]],
  describeHowToIntro: SOURCES.flatMap((source) => [
    [source, 'Family'],
    [source, null],
  ]),
  describeAllowance: [[0], [1], [988]],
  describeHowToSteps: SOURCES.map((source) => [source]),
  describeParseProgress: [
    [0, 0],
    [1, 1],
    [412, 980],
  ],
  describeHeldVideoLine: [[1], [7]],
  describePreflightLines: SOURCES.flatMap((source) => [
    // Rebuilt at launch: no parse summary at all.
    [makePreflight(), source, NOW],
    [makePreflight({ summary: makeParseSummary({ otherSourceDetected: true }) }), source, NOW],
    [
      makePreflight({
        summary: makeParseSummary({ importableMedia: 0, locationDataRemoved: false }),
        contentRetentionDays: 30,
        heldVideo: 5,
        remainingPosts: 13,
      }),
      source,
      NOW,
    ],
  ]),
  describeAllowanceWarning: [
    [1, 5],
    [0, 12],
  ],
  describeRetentionLine: [
    [null, NOW],
    [30, NOW],
    [1, NOW],
  ],
  describeSkipSummaryLine: [[1], [9]],
  describeFileIssueSummaryLine: [[1], [3]],
  describeImportButton: [[1], [120]],
  describeRefusal: [
    [makePreflight({ overAllowance: 'posts' })],
    [makePreflight({ overAllowance: 'bytes' })],
  ],
  describeMediaProgress: [[0], [1], [40]],
  describeRunProgress: [
    [0, 12],
    [12, 12],
  ],
  describePauseTitle: PAUSE_CAUSES.flatMap((cause) => [
    [cause, null],
    [cause, 245000],
    [cause, -1],
  ]),
  describeStalled: [...PAUSE_CAUSES.map((cause) => [cause]), [null]],
  describeStripLine: [
    ...VIEW_KINDS.map((kind) => [view(kind)]),
    ...PAUSE_CAUSES.map((cause) => [view('paused', cause)]),
  ],
  describeSummaryHeadline: [
    [makeSummary()],
    [makeSummary({ cancelled: true })],
    [makeSummary({ errorCode: 'ARCHIVE' })],
  ],
  skippedOther: [[makeSummary({ skippedByReason: makeSkips({ empty_post: 2 }) })]],
  // Returns a number, so it contributes no strings to the audit — it is listed
  // because the fixture table must name every exported function.
  totalUnmigrated: [[SAMPLE_COUNTS], [{ skipped: {}, failed: {}, notSent: 0 }]],
  describeSummaryLines: [
    [makeSummary(), null, NOW],
    [
      makeSummary({
        created: 4,
        duplicate: 1,
        failed: 2,
        heldVideo: 3,
        notSubmitted: 5,
        cancelled: true,
        skippedByReason: makeSkips({ duplicate_in_archive: 2, malformed_post: 1 }),
      }),
      makePreflight({ contentRetentionDays: 7 }),
      NOW,
    ],
    ...everySummaryWithTerminal,
  ],
  groupUnmigrated: [[SAMPLE_ITEMS], [SKIP_REASONS.map((reason, i) => skippedRow(reason, i))], [[]]],
  describeUnmigratedReason: [
    ...SKIP_REASONS.map((reason, i) => [skippedRow(reason, i)]),
    ...FAILED_ITEM_CODES.map((code) => [
      {
        kind: 'failed' as const,
        code,
        id: 'id-secret-f',
        originalDate: null,
        sourceFile: null,
        sourceIndex: null,
      },
    ]),
    [
      {
        kind: 'not_sent' as const,
        id: 'id-secret-n',
        originalDate: MAR_4_2019,
        sourceFile: 'your_posts_0.json',
        sourceIndex: 1,
      },
    ],
  ],
  describeUnmigratedRow: [
    [skippedRow('empty_post', 1)],
    [
      {
        kind: 'not_sent' as const,
        id: 'id-secret-x',
        originalDate: null,
        sourceFile: null,
        sourceIndex: null,
      },
    ],
  ],
  // The screen-reader form of the same row (#928 Brief 2b).
  describeUnmigratedRowA11y: [
    [skippedRow('empty_post', 1)],
    [
      {
        kind: 'not_sent' as const,
        id: 'id-secret-y',
        originalDate: null,
        sourceFile: null,
        sourceIndex: null,
      },
    ],
  ],
  describeMoreFooter: [[0], [1], [250]],
  // Every transition the announcer can make, including the two that depend on
  // where the run came FROM (paused → running vs anything → running).
  describeImportAnnouncement: [
    ...VIEW_KINDS.map((kind) => [view(kind), null, 300, makeSummary()]),
    ...PAUSE_CAUSES.map((cause) => [view('paused', cause), 'running', 300, null]),
    [view('running'), 'paused', 300, null],
    [view('running'), 'stalled', 1, null],
    [view('running'), 'preflight', 300, null],
    [view('completed'), 'running', 300, makeSummary({ created: 4 })],
    [view('cancelled'), 'running', 300, makeSummary({ cancelled: true })],
    [view('failed'), 'running', 300, makeSummary({ errorCode: 'NETWORK' })],
    [view('completed'), 'running', 300, null],
  ],
  describeFileIssueRow: FILE_ISSUE_REASONS.map((reason) => [
    { sourceFile: 'your_posts_0.json', reason },
  ]),
  buildUnmigratedShareText: SOURCES.map((source) => [
    SAMPLE_ITEMS,
    SAMPLE_COUNTS,
    FILE_ISSUES,
    source,
  ]),
};

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) collectStrings(entry, out);
  }
}

/**
 * Every user-facing string a copy module can emit: every exported const, and
 * the result of every exported function called with its fixtures.
 *
 * Takes the module as an argument so the audit's own machinery can be
 * mutation-tested below against a module with planted violations.
 */
function collectEveryString(
  module: Readonly<Record<string, unknown>>,
  fixtures: Readonly<Record<string, readonly CallArgs[]>>,
): readonly string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(module)) {
    if (typeof value !== 'function') {
      collectStrings(value, out);
      continue;
    }
    const fn = value as (...args: unknown[]) => unknown;
    for (const args of fixtures[name] ?? []) collectStrings(fn(...args), out);
  }
  return out;
}

/** The §5 rules. One place, so the mutation proof uses the real regexes. */
const BRAND = /facebook|instagram|FaceBook|\bFB\b|\bIG\b|\bInsta\b/;
const META_LOGIN = /meta log ?in/i;
const RESUME = /\bresume[sd]?\b/i;
const ANOTHER_DEVICE = /try another device/i;

/**
 * URLs are the ONE exemption, and it is a RULE rather than a list of export
 * names: a link's host is the platform's own lowercase domain and cannot be
 * re-spelled. Everything that is not an https URL is audited.
 */
function brandOffenders(strings: readonly string[]): readonly string[] {
  return strings.filter((s) => !s.startsWith('https://') && BRAND.test(s));
}

describe('brand audit (§5)', () => {
  const exportedFunctions = Object.entries(copy)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name)
    .sort();

  it('exercises every exported function — a new one must get a fixture here', () => {
    expect(Object.keys(CALL_FIXTURES).sort()).toEqual(exportedFunctions);
    for (const name of exportedFunctions) {
      expect(CALL_FIXTURES[name].length).toBeGreaterThan(0);
    }
  });

  const strings = collectEveryString(copy, CALL_FIXTURES);

  it('collects a substantial corpus (the walk is not silently empty)', () => {
    expect(strings.length).toBeGreaterThan(200);
    // A const, and a string that only a FUNCTION call can produce — proof that
    // both halves of the walk contribute.
    expect(strings).toContain(PHOTOS_REDOWNLOAD_NOTE);
    expect(strings).toContain(CANCELLED_COPY);
    expect(strings.some((s) => s.includes('Resuming in 4:05.'))).toBe(true);
  });

  it('never spells a platform name in lowercase or abbreviated form', () => {
    expect(brandOffenders(strings)).toEqual([]);
    // Positive control: the URL exemption is narrow enough that the URLs
    // really would have been caught without it.
    expect(BRAND.test(ACCOUNTS_CENTER_URL.facebook)).toBe(true);
    expect(BRAND.test(ACCOUNTS_CENTER_URL.instagram)).toBe(true);
  });

  it('never tells the member to log in to Meta', () => {
    expect(strings.filter((s) => META_LOGIN.test(s))).toEqual([]);
  });

  it('never uses the word "resume" (but keeps "Resuming")', () => {
    expect(strings.filter((s) => RESUME.test(s))).toEqual([]);
    // The boundary matters: "Resuming" is the correct copy and must survive.
    expect(RESUME.test('Resuming shortly.')).toBe(false);
    expect(RESUME.test('Import resuming shortly')).toBe(false);
    expect(RESUME.test('The import will resume.')).toBe(true);
    expect(strings.some((s) => s.includes('Resuming'))).toBe(true);
  });

  it('never tells the member to try another device', () => {
    expect(strings.filter((s) => ANOTHER_DEVICE.test(s))).toEqual([]);
  });

  // The audit is only worth its green tick if it would go red on a real
  // violation. Mutating `importCopy.ts` to prove that is not an option here,
  // so the same walk and the same regexes are run over a module shaped like it
  // with one violation of each rule planted — in a nested const, in an array,
  // and in a function's return value.
  it('would catch a planted violation in a const, an array or a call result', () => {
    const mutated: Readonly<Record<string, unknown>> = {
      SOURCE_LABEL: { facebook: 'facebook', instagram: 'Instagram' },
      HOW_TO_NOTES: ['Keep Orbital open.', 'Open your IG export.'],
      ACCOUNTS_CENTER_URL: { facebook: 'https://accountscenter.facebook.com/x' },
      describeThing: (n: unknown) =>
        `The import will resume in ${String(n)}. Meta login required. Try another device.`,
    };
    const planted = collectEveryString(mutated, { describeThing: [[1]] });

    expect(brandOffenders(planted)).toEqual(['facebook', 'Open your IG export.']);
    expect(planted.filter((s) => META_LOGIN.test(s))).toHaveLength(1);
    expect(planted.filter((s) => RESUME.test(s))).toHaveLength(1);
    expect(planted.filter((s) => ANOTHER_DEVICE.test(s))).toHaveLength(1);
    // And the URL is still exempt, so the exemption is not what hides the rest.
    expect(planted).toContain('https://accountscenter.facebook.com/x');
  });
});

// ---------------------------------------------------------------------------
// §4 exact-string pins — the copy that carries product meaning
// ---------------------------------------------------------------------------

describe('§4 copy pins', () => {
  it('pins all four pick-failure arms', () => {
    expect(PICK_FAILURE_COPY.archive).toBe(
      "Orbital couldn't read those files. Make sure you picked the ZIP files from Meta, " +
        'including every part, and that Format was JSON.',
    );
    expect(PICK_FAILURE_COPY.key_pending).toBe(
      "This orbit's encryption key hasn't reached this phone yet. Try again in a minute.",
    );
    expect(PICK_FAILURE_COPY.network).toBe(
      "Couldn't reach the server to check your import allowance. Nothing was imported. Try again.",
    );
    expect(PICK_FAILURE_COPY.other).toBe(
      'Something went wrong while reading your export. Nothing was imported. Try again.',
    );
  });

  it('pins the re-pick prompt and its trailer', () => {
    expect(PAUSE_COPY.needs_repick.title).toBe(
      'Orbital lost access to your export files. Pick the same ZIP files again, ' +
        'every part, to continue.',
    );
    expect(NEXT_TRAILER.repick).toBe(
      'Posts already imported are kept. Pick the archive again to finish. ' +
        'Anything already imported is skipped.',
    );
  });

  it('pins the cancelled copy', () => {
    expect(CANCELLED_COPY).toBe(
      'You stopped the import. Posts already imported stay in the orbit. To import the rest, ' +
        'pick the archive again. Posts already imported are skipped automatically.',
    );
  });

  it('pins the photos re-download note', () => {
    expect(PHOTOS_REDOWNLOAD_NOTE).toBe(
      "Imported photos aren't kept on this phone. They download again the first time you view them.",
    );
  });

  it('pins the singular/plural noun pairing', () => {
    expect(plural(1, 'post')).toBe('1 post');
    expect(plural(2, 'post')).toBe('2 posts');
    expect(plural(0, 'post')).toBe('0 posts');
    expect(plural(2, 'photo', 'photos are')).toBe('2 photos are');
  });
});

// ---------------------------------------------------------------------------
// formatCountdown
// ---------------------------------------------------------------------------

describe('formatCountdown', () => {
  it('renders m:ss with a zero-padded second', () => {
    expect(formatCountdown(245000)).toBe('4:05');
    expect(formatCountdown(244001)).toBe('4:05');
    expect(formatCountdown(59000)).toBe('0:59');
    expect(formatCountdown(60000)).toBe('1:00');
    expect(formatCountdown(600000)).toBe('10:00');
  });

  it('rounds a part-second up rather than showing 0:00 while time remains', () => {
    expect(formatCountdown(1)).toBe('0:01');
    expect(formatCountdown(1500)).toBe('0:02');
  });

  it('is 0:00 for zero, negative and non-finite input', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-1)).toBe('0:00');
    expect(formatCountdown(-600000)).toBe('0:00');
    expect(formatCountdown(NaN)).toBe('0:00');
    expect(formatCountdown(Infinity)).toBe('0:00');
    expect(formatCountdown(-Infinity)).toBe('0:00');
  });
});
