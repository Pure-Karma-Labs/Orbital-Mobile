/**
 * The preflight view's three VERDICTS, as rendered text (#928 §4.2, #930).
 *
 * ## Why this suite exists beside `ImportStatusScreen.test.tsx`
 *
 * That suite asserts which CHILD view each state renders, by testID. What the
 * member actually reads inside the child is a different question, and #930
 * turns it into a load-bearing one: the same `nothing` kind now has two
 * opposite meanings — an export with nothing importable in it, and an export
 * whose every importable post is already in the orbit. Telling a member who
 * just picked a full archive that "there's nothing in this export that Orbital
 * can import" is false, and no testID assertion can catch it.
 *
 * So this suite renders the view directly and reads its text back.
 *
 * ## Mocking shape
 *
 * Only `canStartFromPreflight` is needed from the runner, and it is the REAL
 * predicate rather than a `jest.fn` — the module is mocked solely because
 * importing it for real reaches MMKV → NitroModules, which throws under Jest.
 * Everything else (theme, `Button`, `ErrorBanner`) is the real component.
 *
 * ## Why `renderedText` and not `queryByText`
 *
 * A line can be rendered alone in its own `Text` (today) or interpolated into
 * a longer one (tomorrow). The absence assertions here are about CURATED copy
 * that must not be SELECTED — so each one is paired with a positive assertion
 * on the same root, which is what proves the helper saw the tree at all.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../../theme';
import { hasHostTestId, renderedText } from '../../../testUtils/rtr';
import { ImportPreflightView } from '../ImportPreflightView';
import {
  ALL_PRESENT_COPY,
  NOTHING_TO_IMPORT_COPY,
  describeAllPresentLine,
  describeAlreadyPresentLine,
  describeHeldVideoLine,
  describeImportOtherInsteadLabel,
  describeRefusal,
} from '../importCopy';

import type { ImportPreflight } from '../../../services/metaImport/importRunner';
import type { ParseSummary, SkipReason } from '../../../services/metaImport/types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../../../services/metaImport/importRunner', () => ({
  // A deliberate COPY of `canStartFromPreflight`, not the real export and not
  // a `jest.fn()` stub.
  //
  // It cannot be the real one: importing `importRunner` pulls in the store,
  // `importCrypto` and the repository, and with them MMKV and the nitro
  // modules — none of which exist in this environment, so the suite would not
  // load at all. It must not be a stub either, because then the Import
  // button's `disabled` wiring would pass against an answer nothing produces.
  //
  // THE DRIFT RISK IS REAL AND UNGUARDED: nothing joins this copy to the
  // predicate it mirrors, so a fourth condition added to the runner's version
  // (an `alreadyPresent` arm, say) leaves this suite asserting that Import is
  // enabled in a state the runner refuses. `importRunner.test.ts` is where
  // the real predicate is pinned; if you change it there, change it here.
  canStartFromPreflight: (preflight: {
    overAllowance: unknown;
    nothingToImport: boolean;
    otherOpenImport: unknown;
  }) =>
    preflight.overAllowance === null &&
    !preflight.nothingToImport &&
    preflight.otherOpenImport === null,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NO_SKIPS: Readonly<Record<SkipReason, number>> = {
  held_video: 0,
  unsupported_image_format: 0,
  image_too_large: 0,
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

const ALLOWANCE = { postsUsed: 300, bytesUsed: 0, postsLimit: 5000, bytesLimit: 2147483648 };

const LIMITS = {
  batchMax: 50,
  mediaPerItemMax: 10,
  metaMaxBytes: 4096,
  ivMax: 16,
  titleMax: 200,
  bodyMax: 20000,
  minDate: '2004-01-01',
  mediaContentClasses: ['image' as const],
};

function makeParseSummary(over: Partial<ParseSummary> = {}): ParseSummary {
  return {
    importable: 300,
    importableMedia: 412,
    skipped: NO_SKIPS,
    earliestDate: Date.UTC(2019, 2, 4, 12, 0, 0),
    latestDate: Date.UTC(2021, 10, 9, 12, 0, 0),
    fileIssues: [],
    idScheme: { fbid: 300, content: 0 },
    otherSourceDetected: false,
    locationDataRemoved: true,
    ...over,
  };
}

function makePreflight(over: Partial<ImportPreflight> = {}): ImportPreflight {
  return {
    summary: makeParseSummary(),
    source: 'facebook' as const,
    otherOpenImport: null,
    allowance: ALLOWANCE,
    limits: LIMITS,
    contentRetentionDays: null,
    importable: 300,
    remainingPosts: 4700,
    estimatedBytes: 55 * 1024 * 1024,
    remainingBytes: 2047 * 1024 * 1024,
    overAllowance: null,
    nothingToImport: false,
    alreadyPresent: 0,
    alreadyPresentMedia: 0,
    heldVideo: 0,
    skippedByReason: NO_SKIPS,
    ...over,
  };
}

/**
 * The all-present dead end: 300 importable posts, every one of them already in
 * this orbit, so `importable` is 0 and `overAllowance` stays null (the runner
 * never sets it when `nothingToImport` is the verdict).
 */
const ALL_PRESENT: ImportPreflight = makePreflight({
  importable: 0,
  estimatedBytes: 0,
  nothingToImport: true,
  alreadyPresent: 300,
  alreadyPresentMedia: 412,
});

/** The same dead end for the pre-#930 reason: the export holds nothing. */
const NOTHING: ImportPreflight = makePreflight({
  importable: 0,
  estimatedBytes: 0,
  nothingToImport: true,
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const mountedRenderers: ReactTestRenderer[] = [];

const noop = (): void => {};

function renderView(
  kind: 'preflight' | 'refused' | 'nothing',
  preflight: ImportPreflight,
  onImportOther: ((other: 'facebook' | 'instagram') => void) | null = null,
): ReactTestInstance {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ThemeProvider colorSchemeOverride="light">
        <ImportPreflightView
          kind={kind}
          preflight={preflight}
          busy={false}
          closing={false}
          closeNotice={null}
          onImport={noop}
          onDiscard={noop}
          onSeeUnmigrated={noop}
          onCloseOther={noop}
          onImportOther={onImportOther}
        />
      </ThemeProvider>,
    );
  });
  mountedRenderers.push(renderer);
  return renderer.root;
}

afterEach(() => {
  while (mountedRenderers.length > 0) {
    const renderer = mountedRenderers.pop();
    act(() => {
      renderer?.unmount();
    });
  }
});

// ---------------------------------------------------------------------------
// (a) + (b) — the two meanings of `nothing`
// ---------------------------------------------------------------------------

describe('ImportPreflightView — nothing left to import', () => {
  it('(a) says every post is already here, never that the export is empty', () => {
    const root = renderView('nothing', ALL_PRESENT);
    const text = renderedText(root);

    expect(text).toContain(ALL_PRESENT_COPY);
    expect(text).toContain(describeAllPresentLine(300));
    // The pre-#930 line is FALSE here: the export is full of importable posts.
    expect(text).not.toContain(NOTHING_TO_IMPORT_COPY);
    // Done is the only way out: there is nothing to import, so no Import.
    expect(hasHostTestId(root, 'import-discard')).toBe(true);
    expect(hasHostTestId(root, 'import-confirm')).toBe(false);
  });

  it('(b) still says the export is empty when the pre-check found nothing', () => {
    const text = renderedText(renderView('nothing', NOTHING));

    expect(text).toContain(NOTHING_TO_IMPORT_COPY);
    expect(text).not.toContain(ALL_PRESENT_COPY);
    // 0 would be a count nobody asked for, in either wording.
    expect(text).not.toContain('already in this orbit');
    expect(text).not.toContain('imported before');
  });

  it('(d) sits beside the held-video line without contradicting it', () => {
    const preflight: ImportPreflight = { ...ALL_PRESENT, heldVideo: 4 };

    const text = renderedText(renderView('nothing', preflight));

    // Both lines, and the one that would contradict the other is absent:
    // "Everything in this export is already here" plus "4 video posts will be
    // importable in a future update" cannot both be true.
    expect(text).toContain(ALL_PRESENT_COPY);
    expect(text).toContain(describeHeldVideoLine(4));
    expect(ALL_PRESENT_COPY).not.toContain('Everything');
    expect(text).not.toContain(NOTHING_TO_IMPORT_COPY);
  });

  it('(e) the same beside the other source, whose own exit is still offered', () => {
    const preflight: ImportPreflight = {
      ...ALL_PRESENT,
      heldVideo: 4,
      summary: makeParseSummary({ otherSourceDetected: true }),
    };

    const root = renderView('nothing', preflight, noop);
    const text = renderedText(root);

    expect(text).toContain(ALL_PRESENT_COPY);
    expect(text).toContain(describeHeldVideoLine(4));
    expect(text).not.toContain(NOTHING_TO_IMPORT_COPY);
    // The dead end's exit: this source has nothing left, the other one does.
    expect(hasHostTestId(root, 'import-other-instead')).toBe(true);
    expect(text).toContain(describeImportOtherInsteadLabel('instagram'));
  });
});

// ---------------------------------------------------------------------------
// (c) — the refusal, whose counts are net too
// ---------------------------------------------------------------------------

describe('ImportPreflightView — refused', () => {
  const REFUSED: ImportPreflight = makePreflight({
    overAllowance: 'posts',
    importable: 260,
    remainingPosts: 12,
    alreadyPresent: 40,
    alreadyPresentMedia: 55,
  });

  it('(c) shows the refusal and the already-present line under it', () => {
    const text = renderedText(renderView('refused', REFUSED));

    expect(text).toContain(describeRefusal(REFUSED));
    expect(text).toContain(describeAlreadyPresentLine(40));
    // The refusal's own counts are NET, so it says so.
    expect(text).toContain('260 new Facebook posts');
  });

  it('leaves the refusal alone when the pre-check found nothing (the control)', () => {
    const plain: ImportPreflight = { ...REFUSED, alreadyPresent: 0, alreadyPresentMedia: 0 };

    const text = renderedText(renderView('refused', plain));

    expect(text).toContain(describeRefusal(plain));
    expect(text).not.toContain('already in this orbit');
    expect(text).not.toContain(' new Facebook posts');
  });
});
