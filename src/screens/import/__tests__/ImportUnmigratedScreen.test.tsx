/**
 * "What didn't migrate" (#928 §4.5).
 *
 * ## What this suite pins
 *
 * 1. **One read, on mount.** The list is a synchronous `executeSync` against a
 *    capped query. Reading it again on every store emission would block the JS
 *    thread during the very run it is describing, and dismissing the summary
 *    from underneath the screen would empty a list the member is reading.
 * 2. **The §4.5 group order, with TRUTHFUL counts.** The headers count from the
 *    `COUNT … GROUP BY`, so they stay right above a capped list — the fixtures
 *    deliberately give a group more in `counts` than it has rows.
 * 3. **The share text.** Dates, basenames and reasons only: no orbit name, no
 *    id, and never more than {@link SHARE_ROW_CAP} rows.
 *
 * ## Mocking shape
 *
 * The 2a shape: the runner is mocked EXCEPT for its store, which is a real
 * `zustand/vanilla` store. `getImportUnmigratedItems` is a `jest.fn()` on that
 * mocked module.
 *
 * ## The read is DEFERRED
 *
 * The screen snapshots in `InteractionManager.runAfterInteractions`, so the
 * push animation is never blocked by two synchronous op-sqlite reads. The
 * suite drives that queue by hand: `flushInteractions` is the default (run the
 * callback at once), and the one test that cares about the spinner holds the
 * callback back instead.
 *
 * ## The ten-row ceiling in these fixtures
 *
 * `FlatList` renders `initialNumToRender` (10) rows and waits for layout events
 * that never arrive under react-test-renderer. Every fixture that asserts on
 * RENDERED rows therefore stays at or under ten rows; the share fixture is
 * deliberately far larger, because the share text is built from the snapshot
 * rather than from what is on screen.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { InteractionManager, Share } from 'react-native';
import { ThemeProvider } from '../../../theme';
import { findByTestId, hasHostTestId } from '../../../testUtils/rtr';
import { ImportUnmigratedScreen } from '../ImportUnmigratedScreen';
import {
  FILE_ISSUE_GROUP_HEADER,
  SHARE_ROW_CAP,
  SOURCE_LABEL,
  UNMIGRATED_EMPTY_COPY,
  UNMIGRATED_GROUP_COPY,
  describeFileIssueRow,
  describeMoreFooter,
  describeUnmigratedReason,
  describeUnmigratedRow,
  describeUnmigratedRowA11y,
  plural,
} from '../importCopy';
import { formatDateWithYear } from '../../../utils/formatPostTimestamp';

import type { ImportPreflight } from '../../../services/metaImport/importRunner';
import type { FileIssue, SkipReason } from '../../../services/metaImport/types';
import type {
  ImportRunnerState,
  UnmigratedCounts,
  UnmigratedImportItem,
  UnmigratedImportList,
} from '../../../services/metaImport/importRunner';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGoBack = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  return {
    SafeAreaView: ({ children, ...props }: { children: unknown }) =>
      ReactModule.createElement('View', props, children),
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
  };
});

interface FakeAppState {
  activeConversationId: string | null;
  conversations: Record<string, { id: string; name: string; type: string }>;
}

/** The orbit name exists precisely so the share text can be shown not to carry it. */
const ORBIT_NAME = 'Zephyr Family Orbit';
const CONVERSATION_ID = 'conv-7f3a-secret';

const mockAppState: FakeAppState = {
  activeConversationId: CONVERSATION_ID,
  conversations: { [CONVERSATION_ID]: { id: CONVERSATION_ID, name: ORBIT_NAME, type: 'group' } },
};

jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: Object.assign(
    jest.fn((selector: (state: unknown) => unknown) => selector(mockAppState)),
    { getState: () => mockAppState },
  ),
}));

jest.mock('../../../services/metaImport/importRunner', () => {
  const { createStore } = require('zustand/vanilla');
  return {
    importStore: createStore(() => ({
      phase: 'done',
      jobId: 'job-1',
      conversationId: null,
      source: 'facebook',
      preflight: null,
      total: 0,
      created: 0,
      duplicate: 0,
      failed: 0,
      skipped: 0,
      heldVideo: 0,
      mediaDone: 0,
      parseProgress: null,
      pauseCauses: [],
      resumeAtMs: null,
      summary: null,
      errorCode: null,
      autoRetryExhausted: false,
    })),
    cancelImport: jest.fn(),
    getImportUnmigratedItems: jest.fn(),
  };
});

import { importStore } from '../../../services/metaImport/importRunner';

const store = importStore;

const mockGetItems = (
  jest.requireMock('../../../services/metaImport/importRunner') as {
    getImportUnmigratedItems: jest.Mock;
  }
).getImportUnmigratedItems;

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

const PREFLIGHT_WITH_FILE_ISSUES: ImportPreflight = {
  summary: {
    importable: 4,
    importableMedia: 2,
    skipped: NO_SKIPS,
    earliestDate: null,
    latestDate: null,
    fileIssues: [
      { sourceFile: 'your_posts_2.json', reason: 'json_unparseable' },
      { sourceFile: 'your_posts_3.json', reason: 'json_too_large' },
    ],
    idScheme: { fbid: 0, content: 4 },
    otherSourceDetected: false,
    locationDataRemoved: true,
  },
  allowance: { postsUsed: 0, bytesUsed: 0, postsLimit: 1000, bytesLimit: 2147483648 },
  limits: {
    batchMax: 50,
    mediaPerItemMax: 10,
    metaMaxBytes: 4096,
    ivMax: 16,
    titleMax: 200,
    bodyMax: 20000,
    minDate: '2004-01-01',
    mediaContentClasses: ['image'],
  },
  contentRetentionDays: null,
  importable: 4,
  remainingPosts: 996,
  estimatedBytes: 1024,
  remainingBytes: 2147482624,
  overAllowance: null,
  nothingToImport: false,
  heldVideo: 1,
  skippedByReason: NO_SKIPS,
};

/** 4 March 2019, UTC — the date the rows are expected to render. */
const MARCH_4_2019 = Date.UTC(2019, 2, 4, 12, 0, 0);

const HELD_ROW: UnmigratedImportItem = {
  id: 'row-held',
  originalDate: MARCH_4_2019,
  sourceFile: 'your_posts_1.json',
  sourceIndex: 3,
  kind: 'skipped',
  reason: 'held_video',
};

const INCOMPLETE_ROW: UnmigratedImportItem = {
  id: 'row-incomplete',
  originalDate: Date.UTC(2020, 6, 9),
  sourceFile: 'your_posts_1.json',
  sourceIndex: 9,
  kind: 'skipped',
  reason: 'media_missing',
};

const FAILED_ROW: UnmigratedImportItem = {
  id: 'row-failed',
  originalDate: Date.UTC(2021, 0, 2),
  sourceFile: 'your_posts_2.json',
  sourceIndex: 1,
  kind: 'failed',
  code: 'IMPORT_ITEM_INVALID',
};

const NOT_SENT_ROW: UnmigratedImportItem = {
  id: 'row-not-sent',
  originalDate: null,
  sourceFile: null,
  sourceIndex: null,
  kind: 'not_sent',
};

const PERMANENT_ROW: UnmigratedImportItem = {
  id: 'row-permanent',
  originalDate: Date.UTC(2022, 10, 30),
  sourceFile: 'your_posts_2.json',
  sourceIndex: 44,
  kind: 'skipped',
  reason: 'empty_post',
};

/**
 * Counts that deliberately EXCEED the rows: the headers read from the
 * `COUNT … GROUP BY`, which is what keeps them honest above a capped list.
 */
const COUNTS: UnmigratedCounts = {
  skipped: { held_video: 50, media_missing: 4, empty_post: 6 },
  failed: { IMPORT_ITEM_INVALID: 9 },
  notSent: 12,
};

/** One row per group, scrambled: §4.5's order must come from the grouping. */
const GROUPED_LIST: UnmigratedImportList = {
  items: [PERMANENT_ROW, NOT_SENT_ROW, FAILED_ROW, INCOMPLETE_ROW, HELD_ROW],
  counts: COUNTS,
  truncated: 0,
};

const EMPTY_LIST: UnmigratedImportList = {
  items: [],
  counts: { skipped: {}, failed: {}, notSent: 0 },
  truncated: 0,
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const mountedRenderers: ReactTestRenderer[] = [];

function screenElement(): React.ReactElement {
  return (
    <ThemeProvider colorSchemeOverride="light">
      <ImportUnmigratedScreen />
    </ThemeProvider>
  );
}

function renderScreen(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(screenElement());
  });
  mountedRenderers.push(renderer);
  return renderer;
}

/** A host-filtered array query: `rtr.ts` has no shared counterpart for this. */
function findAllHostByTestId(root: ReactTestInstance, testID: string): ReactTestInstance[] {
  return root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID);
}

/** Every host `testID` in the tree, in depth-first order. */
function hostTestIdsInOrder(root: ReactTestInstance): string[] {
  return root
    .findAll((node) => typeof node.type === 'string' && typeof node.props.testID === 'string')
    .map((node) => String(node.props.testID));
}

function textsOf(node: ReactTestInstance): string[] {
  return node
    .findAll((child) => (child.type as unknown) === 'Text')
    .map((child) => String(child.props.children));
}

function setStore(patch: Partial<ImportRunnerState>): void {
  store.setState(patch);
}

let shareSpy: jest.SpyInstance;
let interactionSpy: jest.SpyInstance;
/** Set by the hold-it-back implementation; `null` once it has been run. */
let queuedInteraction: (() => void) | null = null;

/** A `runAfterInteractions` handle. Only `cancel` is ever called. */
function fakeHandle(): { then: () => void; done: () => void; cancel: () => void } {
  return { then: () => {}, done: () => {}, cancel: () => {} };
}

beforeEach(() => {
  jest.clearAllMocks();
  queuedInteraction = null;
  // Default: run the snapshot callback synchronously, so every test below
  // sees a loaded screen. The deferral itself is asserted separately.
  interactionSpy = jest.spyOn(InteractionManager, 'runAfterInteractions').mockImplementation(((
    callback: (() => void) | undefined,
  ) => {
    if (typeof callback === 'function') callback();
    return fakeHandle();
  }) as never);
  store.setState(
    {
      phase: 'done',
      jobId: 'job-1',
      conversationId: CONVERSATION_ID,
      source: 'facebook',
      preflight: null,
      total: 0,
      created: 0,
      duplicate: 0,
      failed: 0,
      skipped: 0,
      heldVideo: 0,
      mediaDone: 0,
      parseProgress: null,
      pauseCauses: [],
      resumeAtMs: null,
      summary: null,
      errorCode: null,
      autoRetryExhausted: false,
    },
    true,
  );
  mockGetItems.mockReturnValue(GROUPED_LIST);
  shareSpy = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: 'sharedAction' as const, activityType: undefined });
});

afterEach(() => {
  while (mountedRenderers.length > 0) {
    const renderer = mountedRenderers.pop();
    act(() => {
      renderer?.unmount();
    });
  }
  shareSpy.mockRestore();
  interactionSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// The snapshot: read once, survive a dismiss
// ---------------------------------------------------------------------------

describe('ImportUnmigratedScreen — the mount snapshot', () => {
  /**
   * The read is two synchronous op-sqlite calls, and `executeSync` blocks the
   * JS thread — during render that is the navigator's slide-in animation.
   */
  it('defers the read past the push animation, showing a spinner meanwhile', () => {
    interactionSpy.mockImplementation(((callback: (() => void) | undefined) => {
      queuedInteraction = typeof callback === 'function' ? callback : null;
      return fakeHandle();
    }) as never);

    const renderer = renderScreen();

    // Nothing read yet, and no empty-state line claiming there is nothing to
    // list — only the spinner.
    expect(mockGetItems).not.toHaveBeenCalled();
    expect(hasHostTestId(renderer.root, 'unmigrated-loading')).toBe(true);
    expect(hasHostTestId(renderer.root, 'unmigrated-list')).toBe(false);
    expect(hasHostTestId(renderer.root, 'unmigrated-empty')).toBe(false);

    act(() => {
      queuedInteraction?.();
    });

    expect(mockGetItems).toHaveBeenCalledTimes(1);
    expect(hasHostTestId(renderer.root, 'unmigrated-loading')).toBe(false);
    expect(hasHostTestId(renderer.root, 'unmigrated-list')).toBe(true);
  });

  it('does not read after the screen is gone', () => {
    interactionSpy.mockImplementation(((callback: (() => void) | undefined) => {
      queuedInteraction = typeof callback === 'function' ? callback : null;
      return fakeHandle();
    }) as never);

    const renderer = renderScreen();
    act(() => {
      renderer.unmount();
    });
    mountedRenderers.pop();

    // The queued callback is both cancelled and guarded; firing it anyway must
    // neither read nor set state on an unmounted tree.
    act(() => {
      queuedInteraction?.();
    });
    expect(mockGetItems).not.toHaveBeenCalled();
  });

  it('reads the list exactly once across re-renders', () => {
    const renderer = renderScreen();

    expect(mockGetItems).toHaveBeenCalledTimes(1);

    // Store emissions the runner would make while the member reads…
    act(() => {
      setStore({ created: 1 });
      setStore({ created: 2, mediaDone: 3 });
    });
    // …and a re-render of the screen itself, which is what would re-run a
    // naive `useMemo(() => getImportUnmigratedItems(), [state])`.
    act(() => {
      renderer.update(screenElement());
    });
    act(() => {
      renderer.update(screenElement());
    });

    expect(mockGetItems).toHaveBeenCalledTimes(1);
    expect(findAllHostByTestId(renderer.root, 'unmigrated-row')).toHaveLength(5);
  });

  it('survives the summary being dismissed underneath it', () => {
    const renderer = renderScreen();
    expect(findAllHostByTestId(renderer.root, 'unmigrated-row')).toHaveLength(5);

    act(() => {
      setStore({ phase: 'idle', summary: null, preflight: null });
    });
    act(() => {
      renderer.update(screenElement());
    });

    expect(findAllHostByTestId(renderer.root, 'unmigrated-row')).toHaveLength(5);
    expect(mockGetItems).toHaveBeenCalledTimes(1);
    expect(hasHostTestId(renderer.root, 'unmigrated-empty')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4.5 grouping
// ---------------------------------------------------------------------------

describe('ImportUnmigratedScreen — grouping (§4.5)', () => {
  it('renders the five groups in §4.5 order, whatever order the rows arrive in', () => {
    const renderer = renderScreen();

    const headers = hostTestIdsInOrder(renderer.root).filter((id) =>
      id.startsWith('unmigrated-header-'),
    );

    expect(headers).toEqual([
      'unmigrated-header-h-held',
      'unmigrated-header-h-incomplete',
      'unmigrated-header-h-failed',
      'unmigrated-header-h-not_sent',
      'unmigrated-header-h-permanent',
    ]);
  });

  it('counts each group from the totals, not from the rows it could show', () => {
    const renderer = renderScreen();

    const held = findAllHostByTestId(renderer.root, 'unmigrated-header-h-held')[0];
    const heldTexts = textsOf(held);

    expect(heldTexts[0]).toContain(UNMIGRATED_GROUP_COPY.held.header);
    // 50 in the counts, one row on screen: the header is the truthful one.
    expect(heldTexts[1]).toBe(`${plural(50, 'post')}. ${UNMIGRATED_GROUP_COPY.held.subline}`);
    expect(findAllHostByTestId(renderer.root, 'unmigrated-row')).toHaveLength(5);

    const failed = findAllHostByTestId(renderer.root, 'unmigrated-header-h-failed')[0];
    // `failed` has no shared explanation: each row carries its own reason.
    expect(textsOf(failed)[1]).toBe(plural(9, 'post'));

    const notSent = findAllHostByTestId(renderer.root, 'unmigrated-header-h-not_sent')[0];
    expect(textsOf(notSent)[1]).toContain(plural(12, 'post'));
  });

  it('puts the capped-list footer and the file issues last', () => {
    setStore({ preflight: PREFLIGHT_WITH_FILE_ISSUES });
    mockGetItems.mockReturnValue({
      items: [HELD_ROW],
      counts: COUNTS,
      truncated: 7,
    } satisfies UnmigratedImportList);

    const renderer = renderScreen();
    const order = hostTestIdsInOrder(renderer.root);

    expect(hasHostTestId(renderer.root, 'unmigrated-more')).toBe(true);
    expect(textsOf(findAllHostByTestId(renderer.root, 'unmigrated-more')[0])).toEqual([
      describeMoreFooter(7),
    ]);

    const issues = findAllHostByTestId(renderer.root, 'unmigrated-file-issue');
    expect(issues).toHaveLength(2);
    expect(textsOf(issues[0])[0]).toBe(
      describeFileIssueRow(PREFLIGHT_WITH_FILE_ISSUES.summary?.fileIssues[0] as FileIssue),
    );

    // Order: rows → "…and N more" → the file-issue block.
    expect(order.lastIndexOf('unmigrated-row')).toBeLessThan(order.indexOf('unmigrated-more'));
    expect(order.indexOf('unmigrated-more')).toBeLessThan(order.indexOf('unmigrated-file-issue'));

    // …and the file-issue group header is above its rows.
    const headerText = renderer.root
      .findAll((node) => (node.type as unknown) === 'Text')
      .map((node) => String(node.props.children));
    expect(headerText.some((text) => text.includes(FILE_ISSUE_GROUP_HEADER))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

describe('ImportUnmigratedScreen — a row', () => {
  it('shows the original date, the source file and the reason', () => {
    const renderer = renderScreen();

    const rows = findAllHostByTestId(renderer.root, 'unmigrated-row');
    const held = textsOf(rows[0]);

    expect(held[0]).toBe(`${formatDateWithYear(MARCH_4_2019, 'utc')} · your_posts_1.json`);
    expect(held[0]).toContain('Mar 4, 2019');
    expect(held[1]).toBe(describeUnmigratedReason(HELD_ROW));
  });

  it('falls back to "No date" and "Unknown file"', () => {
    mockGetItems.mockReturnValue({
      items: [NOT_SENT_ROW],
      counts: COUNTS,
      truncated: 0,
    } satisfies UnmigratedImportList);

    const renderer = renderScreen();
    const texts = textsOf(findAllHostByTestId(renderer.root, 'unmigrated-row')[0]);

    expect(texts[0]).toBe('No date · Unknown file');
    expect(texts[0]).toBe(describeUnmigratedRow(NOT_SENT_ROW));
  });

  it('spells the month out for a screen reader', () => {
    const renderer = renderScreen();
    const row = findAllHostByTestId(renderer.root, 'unmigrated-row')[0];

    const label = String(row.props.accessibilityLabel);
    expect(label).toBe(describeUnmigratedRowA11y(HELD_ROW));
    expect(label.startsWith('March 4, 2019,')).toBe(true);
    expect(row.props.accessible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

describe('ImportUnmigratedScreen — share', () => {
  /** 1,200 rows: more than the read cap, so the text must be the one truncated. */
  function hugeList(): UnmigratedImportList {
    const items: UnmigratedImportItem[] = [];
    for (let index = 0; index < 1200; index += 1) {
      items.push({
        id: `row-id-${String(index).padStart(4, '0')}`,
        originalDate: MARCH_4_2019,
        sourceFile: 'your_posts_1.json',
        sourceIndex: index,
        kind: 'skipped',
        reason: 'held_video',
      });
    }
    return {
      items,
      counts: { skipped: { held_video: 1200 }, failed: {}, notSent: 0 },
      truncated: 0,
    };
  }

  it('shares a capped, orbit-free list', () => {
    mockGetItems.mockReturnValue(hugeList());

    const renderer = renderScreen();
    act(() => {
      (findByTestId(renderer.root, 'unmigrated-share').props as { onPress: () => void }).onPress();
    });

    expect(shareSpy).toHaveBeenCalledTimes(1);
    const message = String((shareSpy.mock.calls[0][0] as { message: string }).message);
    const lines = message.split('\n');

    expect(lines[0]).toBe(`Posts not imported from your ${SOURCE_LABEL.facebook} export`);
    expect(lines[1]).toBe('');
    // 1,000 rows, then the "…and N more" footer — never 1,200.
    expect(lines).toHaveLength(2 + SHARE_ROW_CAP + 1);
    expect(lines[lines.length - 1]).toBe(describeMoreFooter(200));
    expect(lines[2]).toBe(
      `${describeUnmigratedRow(hugeList().items[0])} · ${describeUnmigratedReason(HELD_ROW)}`,
    );

    // Dates, basenames and reasons only.
    expect(message).not.toContain(ORBIT_NAME);
    expect(message).not.toContain(CONVERSATION_ID);
    expect(message).not.toContain('row-id-');
  });

  it('appends the file issues under their own header', () => {
    setStore({ preflight: PREFLIGHT_WITH_FILE_ISSUES });
    mockGetItems.mockReturnValue({
      items: [HELD_ROW],
      counts: { skipped: { held_video: 1 }, failed: {}, notSent: 0 },
      truncated: 0,
    } satisfies UnmigratedImportList);

    const renderer = renderScreen();
    act(() => {
      (findByTestId(renderer.root, 'unmigrated-share').props as { onPress: () => void }).onPress();
    });

    const message = String((shareSpy.mock.calls[0][0] as { message: string }).message);
    expect(message).toContain(FILE_ISSUE_GROUP_HEADER);
    expect(message).toContain(
      describeFileIssueRow(PREFLIGHT_WITH_FILE_ISSUES.summary?.fileIssues[0] as FileIssue),
    );
    // No footer: nothing was truncated.
    expect(message).not.toContain('more not listed');
  });
});

// ---------------------------------------------------------------------------
// The empty case
// ---------------------------------------------------------------------------

describe('ImportUnmigratedScreen — nothing to list', () => {
  it('explains itself and offers no Share', () => {
    mockGetItems.mockReturnValue(EMPTY_LIST);

    const renderer = renderScreen();

    expect(hasHostTestId(renderer.root, 'unmigrated-empty')).toBe(true);
    expect(textsOf(renderer.root).some((text) => text === UNMIGRATED_EMPTY_COPY)).toBe(true);
    expect(hasHostTestId(renderer.root, 'unmigrated-share')).toBe(false);
    expect(findAllHostByTestId(renderer.root, 'unmigrated-row')).toHaveLength(0);
  });

  it('offers no Share when the run’s source is unknown', () => {
    setStore({ source: null });

    const renderer = renderScreen();

    expect(hasHostTestId(renderer.root, 'unmigrated-share')).toBe(false);
    // Positive control: the rows themselves are on screen.
    expect(findAllHostByTestId(renderer.root, 'unmigrated-row')).toHaveLength(5);
  });
});
