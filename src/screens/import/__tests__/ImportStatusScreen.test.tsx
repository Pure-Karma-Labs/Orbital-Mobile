/**
 * The one import screen, from preflight to summary (#928 §3.1, §4.2–§4.4).
 *
 * ## What this suite pins
 *
 * 1. **Every view kind renders its own child view.** `deriveImportView` has a
 *    row per state; a row nobody rendered would leave the member on a blank
 *    screen, so each one is asserted by the child's own testID.
 * 2. **Both busy latches.** `confirmAndRunImport` and a pre-run cancel are the
 *    two actions with a gap between the tap and the phase moving. The latch
 *    holds across a COUNTER-only emission (the runner republishes every 250 ms)
 *    and clears when the run's identity — phase, job id, summary — actually
 *    moves. A second tap in between must be a no-op, which is the only thing
 *    standing between a slow cancel and two cancels.
 * 3. **The re-pick's captured pair.** `repickArchiveParts` resets the store to
 *    idle on a different archive, so the orbit and source the replace carries
 *    must have been read BEFORE the call. The test proves it by emptying the
 *    store after the call and asserting the replace is still correct.
 * 4. **The progress bar is silent.** `announceProgress={false}` plus a label:
 *    a value announcement per imported post would talk over everything else.
 *
 * ## Mocking shape
 *
 * The 2a shape (`ImportSettingsSection.test.tsx`, `ImportHowToScreen.test.tsx`):
 * the runner is mocked EXCEPT for its store, which is a real `zustand/vanilla`
 * store the tests write to in order to drive phases. `discardImportPreflight`
 * is a `jest.fn()` on the mocked runner module.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { Alert, type AlertButton } from 'react-native';
import { ThemeProvider } from '../../../theme';
import {
  findByTestId,
  findHostByTestId,
  hasHostTestId,
  renderedText,
} from '../../../testUtils/rtr';
import { ImportStatusScreen } from '../ImportStatusScreen';
import {
  BLOCKED_COPY,
  CLOSE_OTHER_CONFIRM_BODY,
  CLOSE_OTHER_CONFIRM_LABEL,
  CLOSE_OTHER_FAILED_COPY,
  CLOSE_OTHER_KEEP_LABEL,
  DIFFERENT_ARCHIVE_CHOOSE_LABEL,
  DIFFERENT_ARCHIVE_DISMISS_LABEL,
  NO_IMPORT_COPY,
  PAUSE_COPY,
  STALLED_COPY,
  STOP_IMPORT_LABEL,
  describeCloseOtherConfirmTitle,
  describeCloseOtherLabel,
  describeCloseOtherStale,
  describeImportOtherInsteadLabel,
  describeImportOtherLabel,
  describeMediaProgress,
  describeOtherImportOpen,
  describeOtherSourceOffer,
  describePauseTitle,
  describeRunProgress,
  describeSummaryHeadline,
  describeSummaryLines,
} from '../importCopy';

import type {
  ImportPreflight,
  ImportSummary,
  PauseCause,
} from '../../../services/metaImport/importRunner';
import type { ParseSummary, SkipReason } from '../../../services/metaImport/types';
import type { ImportRunnerState } from '../../../services/metaImport/importRunner';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockReplace = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    goBack: mockGoBack,
    navigate: mockNavigate,
    replace: mockReplace,
  }),
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

const mockAppState: FakeAppState = {
  activeConversationId: 'g1',
  conversations: { g1: { id: 'g1', name: 'Test Orbit', type: 'group' } },
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
      phase: 'idle',
      jobId: null,
      conversationId: null,
      source: null,
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
    confirmAndRunImport: jest.fn(),
    dismissImportSummary: jest.fn(),
    repickArchiveParts: jest.fn(),
    resumeImport: jest.fn(),
    resumeImportAtLaunch: jest.fn(),
    discardImportPreflight: jest.fn(),
    closeOtherImport: jest.fn(),
    // The REAL predicate, not a jest.fn: it is a pure two-line function over
    // the preflight, and a stub would let the view's `disabled` wiring pass
    // while disagreeing with the runner about what can start.
    canStartFromPreflight: (preflight: {
      overAllowance: unknown;
      nothingToImport: boolean;
      otherOpenImport: unknown;
    }) =>
      preflight.overAllowance === null &&
      !preflight.nothingToImport &&
      preflight.otherOpenImport === null,
  };
});

import {
  cancelImport,
  closeOtherImport,
  confirmAndRunImport,
  dismissImportSummary,
  importStore,
  repickArchiveParts,
  resumeImport,
  resumeImportAtLaunch,
} from '../../../services/metaImport/importRunner';

const mockCancel = cancelImport as jest.Mock;
const mockConfirm = confirmAndRunImport as jest.Mock;
const mockDismiss = dismissImportSummary as jest.Mock;
const mockRepick = repickArchiveParts as jest.Mock;
const mockResume = resumeImport as jest.Mock;
const mockResumeAtLaunch = resumeImportAtLaunch as jest.Mock;
const mockCloseOther = closeOtherImport as jest.Mock;

const mockDiscard = (
  jest.requireMock('../../../services/metaImport/importRunner') as {
    discardImportPreflight: jest.Mock;
  }
).discardImportPreflight;

/**
 * The runner's real `zustand/vanilla` store, which these tests drive.
 */
const store = importStore;

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

const ALLOWANCE = { postsUsed: 0, bytesUsed: 0, postsLimit: 1000, bytesLimit: 2147483648 };

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

const RUNNABLE_PREFLIGHT: ImportPreflight = {
  summary: null,
  source: 'facebook' as const,
  otherOpenImport: null,
  allowance: ALLOWANCE,
  limits: LIMITS,
  contentRetentionDays: null,
  importable: 12,
  remainingPosts: 988,
  estimatedBytes: 1024,
  remainingBytes: 2147482624,
  overAllowance: null,
  nothingToImport: false,
  alreadyPresent: 0,
  alreadyPresentMedia: 0,
  heldVideo: 0,
  skippedByReason: NO_SKIPS,
};

const REFUSED_PREFLIGHT: ImportPreflight = { ...RUNNABLE_PREFLIGHT, overAllowance: 'posts' };

const NOTHING_PREFLIGHT: ImportPreflight = {
  ...RUNNABLE_PREFLIGHT,
  importable: 0,
  nothingToImport: true,
};

const COMPLETED_SUMMARY: ImportSummary = {
  source: 'facebook' as const,
  otherSourceDetected: false,
  created: 12,
  duplicate: 1,
  failed: 0,
  heldVideo: 0,
  skippedByReason: NO_SKIPS,
  notSubmitted: 0,
  errorCode: null,
  cancelled: false,
};

const CANCELLED_SUMMARY: ImportSummary = { ...COMPLETED_SUMMARY, cancelled: true };

const FAILED_SUMMARY: ImportSummary = { ...COMPLETED_SUMMARY, errorCode: 'NETWORK' };

const BASE_STATE: ImportRunnerState = {
  phase: 'idle',
  jobId: null,
  conversationId: null,
  source: null,
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
};

/** A live run, in the orbit the fake app store knows about. */
const RUNNING_STATE: Partial<ImportRunnerState> = {
  phase: 'running',
  jobId: 'job-1',
  conversationId: 'g1',
  source: 'facebook',
  total: 300,
  created: 12,
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const mountedRenderers: ReactTestRenderer[] = [];

function renderScreen(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ThemeProvider colorSchemeOverride="light">
        <ImportStatusScreen />
      </ThemeProvider>,
    );
  });
  mountedRenderers.push(renderer);
  return renderer;
}

function setState(patch: Partial<ImportRunnerState>): void {
  act(() => {
    store.setState(patch);
  });
}

function tap(root: ReactTestInstance, testID: string): void {
  act(() => {
    (findByTestId(root, testID).props as { onPress: () => void }).onPress();
  });
}

async function tapAndSettle(root: ReactTestInstance, testID: string): Promise<void> {
  await act(async () => {
    (findByTestId(root, testID).props as { onPress: () => void }).onPress();
  });
}

interface ControlProps {
  loading?: boolean;
  disabled?: boolean;
  title?: string;
}

interface BarProps {
  progress?: number;
  announceProgress?: boolean;
  accessibilityLabel?: string;
}

/** The `Button` COMPONENT node's props — where `loading`/`disabled` live. */
function controlProps(root: ReactTestInstance, testID: string): ControlProps {
  return findByTestId(root, testID).props as ControlProps;
}

/** The `ProgressBar` COMPONENT node's props. */
function barProps(root: ReactTestInstance, testID: string): BarProps {
  return findByTestId(root, testID).props as BarProps;
}

function runTitle(root: ReactTestInstance): string {
  return String(findHostByTestId(root, 'import-run-title').props.children);
}

/** The buttons of the most recent `Alert.alert` call. */
function alertButtons(): AlertButton[] {
  const calls = alertSpy.mock.calls;
  return calls[calls.length - 1][2] as AlertButton[];
}

function pressAlertButton(predicate: (button: AlertButton) => boolean): void {
  const button = alertButtons().find(predicate);
  expect(button).toBeDefined();
  act(() => {
    button?.onPress?.();
  });
}

let alertSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  store.setState({ ...BASE_STATE }, true);
  // Every one of these is awaited (`.catch`/`.then`) by the screen, so an
  // undefined return would throw inside the handler rather than fail an
  // assertion.
  mockConfirm.mockResolvedValue(undefined);
  mockDiscard.mockResolvedValue(undefined);
  mockRepick.mockResolvedValue('resumed');
  mockResumeAtLaunch.mockResolvedValue(undefined);
  mockCloseOther.mockResolvedValue('closed');
  // `clearAllMocks` clears CALLS, not implementations, so a test that gives
  // the dismiss a store-resetting body would otherwise leak it into the next
  // one. Restated here rather than switched to `resetAllMocks`, which would
  // also throw away the resolved values above.
  mockDismiss.mockImplementation(() => {});
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => {
  while (mountedRenderers.length > 0) {
    const renderer = mountedRenderers.pop();
    act(() => {
      renderer?.unmount();
    });
  }
  alertSpy.mockRestore();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// §3.1 — one test per view kind
// ---------------------------------------------------------------------------

/** Every child view the screen can render. Exactly one may be on screen. */
const ALL_VIEW_TEST_IDS: readonly string[] = [
  'import-checking-view',
  'import-none-view',
  'import-parse-view',
  'import-preflight-view',
  'import-summary-view',
  'import-run-view-running',
  'import-run-view-paused',
  'import-run-view-stalled',
  'import-run-view-repick',
  'import-run-view-blocked',
];

describe('ImportStatusScreen — the view kind decides the body (§3.1)', () => {
  const views: ReadonlyArray<[string, Partial<ImportRunnerState>, string]> = [
    ['checking', { phase: 'hydrating' }, 'import-checking-view'],
    ['none', { phase: 'idle', jobId: null }, 'import-none-view'],
    ['blocked', { phase: 'idle', jobId: 'job-1' }, 'import-run-view-blocked'],
    ['parsing', { phase: 'parsing', jobId: 'job-1' }, 'import-parse-view'],
    [
      'nothing',
      { phase: 'ready', jobId: 'job-1', preflight: NOTHING_PREFLIGHT, source: 'facebook' },
      'import-preflight-view',
    ],
    [
      'refused',
      { phase: 'ready', jobId: 'job-1', preflight: REFUSED_PREFLIGHT, source: 'facebook' },
      'import-preflight-view',
    ],
    [
      'preflight',
      { phase: 'ready', jobId: 'job-1', preflight: RUNNABLE_PREFLIGHT, source: 'facebook' },
      'import-preflight-view',
    ],
    ['running', RUNNING_STATE, 'import-run-view-running'],
    [
      'paused',
      { phase: 'paused', jobId: 'job-1', pauseCauses: ['network'] },
      'import-run-view-paused',
    ],
    [
      'repick',
      { phase: 'paused', jobId: 'job-1', pauseCauses: ['needs_repick'] },
      'import-run-view-repick',
    ],
    [
      'stalled',
      {
        phase: 'paused',
        jobId: 'job-1',
        pauseCauses: ['network'],
        autoRetryExhausted: true,
      },
      'import-run-view-stalled',
    ],
    [
      'completed',
      { phase: 'done', jobId: 'job-1', summary: COMPLETED_SUMMARY },
      'import-summary-view',
    ],
    [
      'cancelled',
      { phase: 'done', jobId: 'job-1', summary: CANCELLED_SUMMARY },
      'import-summary-view',
    ],
    ['failed', { phase: 'done', jobId: 'job-1', summary: FAILED_SUMMARY }, 'import-summary-view'],
  ];

  it.each(views)('renders the %s body and nothing else', (_name, patch, expectedTestId) => {
    store.setState(patch);

    const renderer = renderScreen();

    expect(hasHostTestId(renderer.root, expectedTestId)).toBe(true);
    for (const other of ALL_VIEW_TEST_IDS) {
      if (other === expectedTestId) continue;
      expect(hasHostTestId(renderer.root, other)).toBe(false);
    }
  });

  it('falls back to the "no import" body when a ready phase carries no preflight', () => {
    store.setState({ phase: 'ready', jobId: 'job-1', preflight: null });

    const renderer = renderScreen();

    expect(hasHostTestId(renderer.root, 'import-none-view')).toBe(true);
    expect(renderedText(renderer.root)).toContain(NO_IMPORT_COPY);
  });
});

// ---------------------------------------------------------------------------
// §4.2 — the preflight's two buttons
// ---------------------------------------------------------------------------

describe('ImportStatusScreen — preflight', () => {
  function renderPreflight(): ReactTestRenderer {
    store.setState({
      phase: 'ready',
      jobId: 'job-1',
      conversationId: 'g1',
      source: 'facebook',
      preflight: RUNNABLE_PREFLIGHT,
    });
    return renderScreen();
  }

  it('starts exactly one import and stays busy across a counter-only emission', () => {
    const renderer = renderPreflight();
    const root = renderer.root;

    expect(controlProps(root, 'import-confirm').loading).toBe(false);

    tap(root, 'import-confirm');

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(controlProps(root, 'import-confirm').loading).toBe(true);

    // The runner republishes every 250 ms while counters move. None of that is
    // the run moving on, so the spinner must stay.
    setState({ created: 1, mediaDone: 2 });
    setState({ created: 2, mediaDone: 5 });
    expect(controlProps(root, 'import-confirm').loading).toBe(true);

    // A second tap while busy is a no-op.
    tap(root, 'import-confirm');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('clears the busy latch once the phase has moved to running', () => {
    const renderer = renderPreflight();
    const root = renderer.root;

    tap(root, 'import-confirm');
    expect(controlProps(root, 'import-confirm').loading).toBe(true);

    setState({ phase: 'running', total: 300 });
    expect(hasHostTestId(root, 'import-run-view-running')).toBe(true);

    // Back to a preflight (a second archive, later in the session): the latch
    // cleared on the transition, so the button is tappable again.
    setState({ phase: 'ready', preflight: RUNNABLE_PREFLIGHT });
    expect(controlProps(root, 'import-confirm').loading).toBe(false);

    tap(root, 'import-confirm');
    expect(mockConfirm).toHaveBeenCalledTimes(2);
  });

  /**
   * `confirmAndRunImport` has silent returns of its own — a job that is no
   * longer `ready`, an entry that joins another. The phase never moves, so
   * only the promise settling can give the button back.
   */
  it('clears the busy latch when confirm returns having published nothing', async () => {
    const renderer = renderPreflight();
    const root = renderer.root;

    await tapAndSettle(root, 'import-confirm');

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(store.getState().phase).toBe('ready');
    expect(controlProps(root, 'import-confirm').loading).toBe(false);

    tap(root, 'import-confirm');
    expect(mockConfirm).toHaveBeenCalledTimes(2);
  });

  it('discards the preflight and then goes back', async () => {
    const renderer = renderPreflight();

    await tapAndSettle(renderer.root, 'import-discard');

    expect(mockDiscard).toHaveBeenCalledTimes(1);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    // The order is the point: Back lands on a Settings section that reads the
    // store the discard has already cleared.
    expect(mockDiscard.mock.invocationCallOrder[0]).toBeLessThan(
      mockGoBack.mock.invocationCallOrder[0],
    );
  });
});

// ---------------------------------------------------------------------------
// §4.3 — the running view
// ---------------------------------------------------------------------------

describe('ImportStatusScreen — running', () => {
  it('renders a silent progress bar carrying the same sentence as the line above', () => {
    store.setState(RUNNING_STATE);

    const renderer = renderScreen();
    const bar = barProps(renderer.root, 'import-progress-bar');

    expect(bar.announceProgress).toBe(false);
    expect(bar.accessibilityLabel).toBe(describeRunProgress(12, 300));
    expect(bar.accessibilityLabel).toMatch(/^Imported \d+ of \d+ posts$/);
    // …and the host node really is not a live progressbar.
    expect(findHostByTestId(renderer.root, 'import-progress-bar').props.accessibilityRole).toBe(
      undefined,
    );
  });

  it('counts every settled post towards the bar, not just the created ones', () => {
    store.setState({ ...RUNNING_STATE, created: 10, duplicate: 3, failed: 2, heldVideo: 1 });

    const renderer = renderScreen();

    expect(barProps(renderer.root, 'import-progress-bar').accessibilityLabel).toBe(
      describeRunProgress(16, 300),
    );
  });

  it('hides the bar entirely when the total is not known yet', () => {
    store.setState({ ...RUNNING_STATE, total: 0 });

    const renderer = renderScreen();

    expect(hasHostTestId(renderer.root, 'import-progress-bar')).toBe(false);
    // Positive control: the running view itself IS on screen.
    expect(hasHostTestId(renderer.root, 'import-run-view-running')).toBe(true);
  });

  it('shows the media sub-line only once a photo has been uploaded', () => {
    store.setState({ ...RUNNING_STATE, mediaDone: 0 });
    const quiet = renderScreen();
    expect(hasHostTestId(quiet.root, 'import-media-sub-line')).toBe(false);

    setState({ mediaDone: 7 });
    expect(hasHostTestId(quiet.root, 'import-media-sub-line')).toBe(true);
    expect(String(findHostByTestId(quiet.root, 'import-media-sub-line').props.children)).toBe(
      describeMediaProgress(7),
    );
  });

  it('confirms a stop, and cancels only from the destructive button', () => {
    store.setState(RUNNING_STATE);

    const renderer = renderScreen();
    tap(renderer.root, 'import-stop');

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(mockCancel).not.toHaveBeenCalled();

    const keepGoing = alertButtons().find((button) => button.style === 'cancel');
    expect(keepGoing).toBeDefined();
    act(() => {
      keepGoing?.onPress?.();
    });
    expect(mockCancel).not.toHaveBeenCalled();

    pressAlertButton((button) => button.style === 'destructive');
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(alertButtons().some((button) => button.text === STOP_IMPORT_LABEL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §4.3 — the paused countdown
// ---------------------------------------------------------------------------

describe('ImportStatusScreen — the paused countdown', () => {
  const NOW = 1_762_000_000_000;

  beforeEach(() => {
    // A fixed clock rather than fake timers: the view reads `Date.now()` in a
    // `useState` initialiser, and the ticking interval is irrelevant to what is
    // asserted here.
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  it('counts down in m:ss while a scheduled wait is still in the future', () => {
    store.setState({
      phase: 'paused',
      jobId: 'job-1',
      pauseCauses: ['rate_limited'],
      resumeAtMs: NOW + 125_000,
    });

    const renderer = renderScreen();

    expect(runTitle(renderer.root)).toBe(describePauseTitle('rate_limited', 125_000));
    expect(runTitle(renderer.root)).toMatch(/Resuming in \d+:\d{2}\./);
  });

  it('says "Resuming shortly." for a deadline in the past', () => {
    store.setState({
      phase: 'paused',
      jobId: 'job-1',
      pauseCauses: ['rate_limited'],
      resumeAtMs: NOW - 1_000,
    });

    const renderer = renderScreen();

    expect(runTitle(renderer.root)).toContain('Resuming shortly.');
    expect(runTitle(renderer.root)).not.toMatch(/\d+:\d{2}/);
  });

  it('says "Resuming shortly." when there is no deadline at all', () => {
    store.setState({
      phase: 'paused',
      jobId: 'job-1',
      pauseCauses: ['allowance_wait'],
      resumeAtMs: null,
    });

    const renderer = renderScreen();

    expect(runTitle(renderer.root)).toContain('Resuming shortly.');
    expect(runTitle(renderer.root)).not.toMatch(/\d+:\d{2}/);
  });

  it('shows no countdown for a cause that clears on an event, deadline or not', () => {
    store.setState({
      phase: 'paused',
      jobId: 'job-1',
      pauseCauses: ['network'],
      resumeAtMs: NOW + 125_000,
    });

    const renderer = renderScreen();

    expect(runTitle(renderer.root)).toBe(PAUSE_COPY.network.title);
    expect(runTitle(renderer.root)).not.toMatch(/\d+:\d{2}/);
    expect(runTitle(renderer.root)).not.toContain('Resuming');
  });
});

// ---------------------------------------------------------------------------
// §4.3 — which pauses offer a Retry
// ---------------------------------------------------------------------------

describe('ImportStatusScreen — retry visibility', () => {
  const actionable: readonly PauseCause[] = ['network', 'archive_retry', 'key_pending'];
  const waiting: readonly PauseCause[] = ['rate_limited', 'allowance_wait', 'background'];

  it.each(actionable)('offers Retry for %s', (cause) => {
    store.setState({ phase: 'paused', jobId: 'job-1', pauseCauses: [cause] });

    const renderer = renderScreen();

    expect(hasHostTestId(renderer.root, 'import-retry')).toBe(true);
    expect(controlProps(renderer.root, 'import-retry').title).toBe(PAUSE_COPY[cause].action);
  });

  it.each(waiting)('offers no Retry for %s, because a tap could not clear it', (cause) => {
    store.setState({ phase: 'paused', jobId: 'job-1', pauseCauses: [cause] });

    const renderer = renderScreen();

    expect(hasHostTestId(renderer.root, 'import-retry')).toBe(false);
    // Positive control: the paused view IS on screen and Stop is reachable.
    expect(hasHostTestId(renderer.root, 'import-run-view-paused')).toBe(true);
    expect(hasHostTestId(renderer.root, 'import-stop')).toBe(true);
  });

  it('retries a paused run through resumeImport', () => {
    store.setState({ phase: 'paused', jobId: 'job-1', pauseCauses: ['network'] });

    const renderer = renderScreen();
    tap(renderer.root, 'import-retry');

    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(mockResumeAtLaunch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §4.3 — stalled and blocked
// ---------------------------------------------------------------------------

describe('ImportStatusScreen — stalled', () => {
  function renderStalled(): ReactTestRenderer {
    store.setState({
      phase: 'paused',
      jobId: 'job-1',
      pauseCauses: ['network'],
      autoRetryExhausted: true,
    });
    return renderScreen();
  }

  it('retries through resumeImport and stops through cancelImport', () => {
    const renderer = renderStalled();
    const root = renderer.root;

    expect(runTitle(root)).toBe(STALLED_COPY.other);

    tap(root, 'import-retry');
    expect(mockResume).toHaveBeenCalledTimes(1);

    tap(root, 'import-stop');
    pressAlertButton((button) => button.style === 'destructive');
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });
});

describe('ImportStatusScreen — blocked', () => {
  function renderBlocked(): ReactTestRenderer {
    store.setState({ phase: 'idle', jobId: 'job-1', conversationId: 'g1', source: 'facebook' });
    return renderScreen();
  }

  it('re-enters through the launch path, and starts over by discarding', async () => {
    const renderer = renderBlocked();
    const root = renderer.root;

    expect(runTitle(root)).toBe(BLOCKED_COPY);
    // A blocked job has no counters to show.
    expect(hasHostTestId(root, 'import-progress-bar')).toBe(false);

    // Settled, because Retry holds Start over off while it is in flight.
    await tapAndSettle(root, 'import-retry');
    expect(mockResumeAtLaunch).toHaveBeenCalledTimes(1);
    expect(mockResume).not.toHaveBeenCalled();

    tap(root, 'import-start-over');
    expect(mockDiscard).toHaveBeenCalledTimes(1);
    // Start over is not the Stop alert: nothing has been uploaded.
    expect(alertSpy).not.toHaveBeenCalled();
  });

  /**
   * The blocker's UI half. Both buttons drive the SAME job through the
   * runner's pre-run gate, where a discard now queues behind an in-flight
   * retry — so the screen must not let the member start one on top of the
   * other, and neither spinner may outlive its own call.
   */
  it('holds Start over off while Retry is in flight, and releases it after', async () => {
    const renderer = renderBlocked();
    const root = renderer.root;

    // A retry that does not settle until we say so.
    let releaseRetry!: () => void;
    mockResumeAtLaunch.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseRetry = resolve;
      }),
    );

    tap(root, 'import-retry');
    expect(controlProps(root, 'import-retry').loading).toBe(true);
    expect(controlProps(root, 'import-start-over').disabled).toBe(true);

    // The tap is refused rather than merely styled as disabled.
    tap(root, 'import-start-over');
    expect(mockDiscard).not.toHaveBeenCalled();
    tap(root, 'import-retry');
    expect(mockResumeAtLaunch).toHaveBeenCalledTimes(1);

    // The runner published NOTHING — the signature is unchanged — so only the
    // promise settling can clear this.
    await act(async () => {
      releaseRetry();
    });

    expect(controlProps(root, 'import-retry').loading).toBe(false);
    expect(controlProps(root, 'import-start-over').disabled).toBe(false);

    tap(root, 'import-start-over');
    expect(mockDiscard).toHaveBeenCalledTimes(1);
  });

  it('holds Retry off while Start over is in flight', () => {
    const renderer = renderBlocked();
    const root = renderer.root;

    mockDiscard.mockReturnValue(new Promise<void>(() => {}));

    tap(root, 'import-start-over');
    expect(controlProps(root, 'import-start-over').loading).toBe(true);
    expect(controlProps(root, 'import-retry').disabled).toBe(true);

    tap(root, 'import-retry');
    expect(mockResumeAtLaunch).not.toHaveBeenCalled();
  });

  /**
   * The exact shape of the blocking finding: a discard that joins (or queues
   * behind) another entry and returns having published nothing at all. A
   * signature-only latch leaves the member staring at a spinner that never
   * stops.
   */
  it('clears Start over when the discard resolves with no state change', async () => {
    const renderer = renderBlocked();
    const root = renderer.root;

    await tapAndSettle(root, 'import-start-over');

    expect(mockDiscard).toHaveBeenCalledTimes(1);
    expect(store.getState().jobId).toBe('job-1');
    expect(controlProps(root, 'import-start-over').loading).toBe(false);

    // And it is tappable again, rather than latched out for the session.
    tap(root, 'import-start-over');
    expect(mockDiscard).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// The ~15 s pre-run cancel (the second busy latch)
// ---------------------------------------------------------------------------

describe('ImportStatusScreen — the pre-run cancel latch', () => {
  /** Each of the three identity moves that must clear the latch. */
  const identityMoves: ReadonlyArray<[string, Partial<ImportRunnerState>]> = [
    ['the phase', { phase: 'running', total: 300 }],
    ['the job id', { jobId: 'job-2' }],
    ['the summary', { summary: CANCELLED_SUMMARY }],
  ];

  function renderPausedRun(): ReactTestRenderer {
    store.setState({
      phase: 'paused',
      jobId: 'job-1',
      conversationId: 'g1',
      pauseCauses: ['network'],
      total: 300,
      created: 4,
    });
    return renderScreen();
  }

  it('holds Stop busy across counter emissions and refuses a second cancel', () => {
    const renderer = renderPausedRun();
    const root = renderer.root;

    tap(root, 'import-stop');
    pressAlertButton((button) => button.style === 'destructive');

    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(controlProps(root, 'import-stop').loading).toBe(true);

    setState({ created: 5 });
    setState({ created: 6, mediaDone: 2 });
    expect(controlProps(root, 'import-stop').loading).toBe(true);

    // A second tap must not even reopen the confirmation.
    tap(root, 'import-stop');
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  it.each(identityMoves)('clears the Stop latch when %s changes', (_name, patch) => {
    const renderer = renderPausedRun();
    const root = renderer.root;

    tap(root, 'import-stop');
    pressAlertButton((button) => button.style === 'destructive');
    expect(controlProps(root, 'import-stop').loading).toBe(true);

    setState(patch);

    expect(controlProps(root, 'import-stop').loading).toBe(false);
  });

  it('holds Start over busy on a blocked job and refuses a second discard', () => {
    store.setState({ phase: 'idle', jobId: 'job-1', conversationId: 'g1' });
    const renderer = renderScreen();
    const root = renderer.root;

    tap(root, 'import-start-over');

    expect(mockDiscard).toHaveBeenCalledTimes(1);
    expect(controlProps(root, 'import-start-over').loading).toBe(true);

    setState({ created: 1 });
    expect(controlProps(root, 'import-start-over').loading).toBe(true);

    tap(root, 'import-start-over');
    expect(mockDiscard).toHaveBeenCalledTimes(1);

    // …and the job finally going away releases it.
    setState({ jobId: 'job-2' });
    expect(controlProps(root, 'import-start-over').loading).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4.3 — the re-pick
// ---------------------------------------------------------------------------

describe('ImportStatusScreen — re-pick', () => {
  function renderRepick(): ReactTestRenderer {
    store.setState({
      phase: 'paused',
      jobId: 'job-1',
      conversationId: 'g1',
      source: 'facebook',
      pauseCauses: ['needs_repick'],
    });
    return renderScreen();
  }

  it('asks the runner to re-pick the archive parts', async () => {
    const renderer = renderRepick();

    await tapAndSettle(renderer.root, 'import-repick');

    expect(mockRepick).toHaveBeenCalledTimes(1);
  });

  it.each(['resumed', 'cancelled'] as const)('shows no alert for %s', async (result) => {
    mockRepick.mockResolvedValue(result);
    const renderer = renderRepick();

    await tapAndSettle(renderer.root, 'import-repick');

    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('carries the orbit the store held BEFORE the re-pick, and no source', async () => {
    mockRepick.mockResolvedValue('different-archive');
    const renderer = renderRepick();

    await tapAndSettle(renderer.root, 'import-repick');

    expect(alertSpy).toHaveBeenCalledTimes(1);

    // A different archive resets the runner to idle. Reading the store now
    // would hand the replace a null orbit — which is exactly why the handler
    // read it before the call.
    setState({ phase: 'idle', jobId: null, source: null, conversationId: null });

    pressAlertButton((button) => button.text === DIFFERENT_ARCHIVE_CHOOSE_LABEL);

    expect(mockReplace).toHaveBeenCalledTimes(1);
    // No SOURCE (#996): the fresh pick detects it from the files.
    expect(mockReplace).toHaveBeenCalledWith('ImportHowTo', { conversationId: 'g1' });
    expect(mockReplace.mock.calls[0][1]).not.toHaveProperty('source');
  });

  it('dismisses back to Settings from the alert without re-picking', async () => {
    mockRepick.mockResolvedValue('different-archive');
    const renderer = renderRepick();

    await tapAndSettle(renderer.root, 'import-repick');
    pressAlertButton((button) => button.text === DIFFERENT_ARCHIVE_DISMISS_LABEL);

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §4.4 — the summary
// ---------------------------------------------------------------------------

describe('ImportStatusScreen — summary', () => {
  function renderSummary(summary: ImportSummary = COMPLETED_SUMMARY): ReactTestRenderer {
    store.setState({
      phase: 'done',
      jobId: 'job-1',
      conversationId: 'g1',
      source: 'facebook',
      summary,
      preflight: RUNNABLE_PREFLIGHT,
    });
    return renderScreen();
  }

  it('renders the headline and every summary line', () => {
    const renderer = renderSummary();

    expect(String(findHostByTestId(renderer.root, 'import-summary-headline').props.children)).toBe(
      describeSummaryHeadline(COMPLETED_SUMMARY),
    );

    const text = renderedText(renderer.root);
    const lines = describeSummaryLines(COMPLETED_SUMMARY, RUNNABLE_PREFLIGHT);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(text).toContain(line);
    }
  });

  it('dismisses the summary before going back', () => {
    const renderer = renderSummary();

    tap(renderer.root, 'import-summary-done');

    expect(mockDismiss).toHaveBeenCalledTimes(1);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    // Back first would leave the Settings section showing a settled run.
    expect(mockDismiss.mock.invocationCallOrder[0]).toBeLessThan(
      mockGoBack.mock.invocationCallOrder[0],
    );
  });

  it('opens the unmigrated list when there is something to list', () => {
    const renderer = renderSummary({ ...COMPLETED_SUMMARY, failed: 3 });

    expect(hasHostTestId(renderer.root, 'import-see-unmigrated')).toBe(true);
    tap(renderer.root, 'import-see-unmigrated');

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('ImportUnmigrated');
  });

  it('offers no unmigrated list when nothing was left behind', () => {
    const renderer = renderSummary();

    expect(hasHostTestId(renderer.root, 'import-see-unmigrated')).toBe(false);
    // Positive control: the summary itself rendered.
    expect(hasHostTestId(renderer.root, 'import-summary-done')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The OTHER source's open import (#996 §2)
//
// One open session per member per orbit ACROSS sources, so a stale one — a
// reset with no `/complete`, a reinstall, another device — blocks this
// preflight. The parsed job is untouched, which is why the way out is a Close
// button rather than a dead end.
// ---------------------------------------------------------------------------

const BLOCKED_PREFLIGHT: ImportPreflight = {
  ...RUNNABLE_PREFLIGHT,
  otherOpenImport: { importId: 'other-import-1' },
};

describe('ImportStatusScreen — the other source is still open', () => {
  function renderBlockedPreflight(): ReactTestRenderer {
    store.setState({
      phase: 'ready',
      jobId: 'job-1',
      conversationId: 'g1',
      source: 'facebook',
      preflight: BLOCKED_PREFLIGHT,
    });
    return renderScreen();
  }

  it('explains itself and refuses to start', () => {
    const renderer = renderBlockedPreflight();
    const root = renderer.root;

    expect(String(findHostByTestId(root, 'import-other-open-notice').props.children)).toBe(
      describeOtherImportOpen('facebook'),
    );
    // Named by the OTHER platform, which is the one that has to be closed.
    expect(controlProps(root, 'import-close-other').title).toBe(
      describeCloseOtherLabel('facebook'),
    );
    expect(controlProps(root, 'import-confirm').disabled).toBe(true);
    // Walking away is never blocked.
    expect(controlProps(root, 'import-discard').disabled).toBe(false);
  });

  it('shows neither notice nor Close on an ordinary preflight', () => {
    setState({ phase: 'ready', jobId: 'job-1', preflight: RUNNABLE_PREFLIGHT });
    const renderer = renderScreen();

    expect(hasHostTestId(renderer.root, 'import-other-open-notice')).toBe(false);
    expect(hasHostTestId(renderer.root, 'import-close-other')).toBe(false);
    expect(controlProps(renderer.root, 'import-confirm').disabled).toBe(false);
  });

  it.each([
    ['refused', { ...BLOCKED_PREFLIGHT, overAllowance: 'posts' as const }],
    ['nothing', { ...BLOCKED_PREFLIGHT, importable: 0, nothingToImport: true }],
  ])(
    'offers neither notice nor Close on a %s archive, which the other import does not block',
    (_kind, preflight) => {
      setState({ phase: 'ready', jobId: 'job-1', conversationId: 'g1', preflight });
      const renderer = renderScreen();

      expect(hasHostTestId(renderer.root, 'import-other-open-notice')).toBe(false);
      expect(hasHostTestId(renderer.root, 'import-close-other')).toBe(false);
    },
  );

  it('puts a confirm in front of the close, and only then closes', () => {
    const renderer = renderBlockedPreflight();
    const root = renderer.root;

    tap(root, 'import-close-other');

    // The session may still be RUNNING on another device, which this one
    // cannot see — so the member is told before anything happens.
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe(describeCloseOtherConfirmTitle('facebook'));
    expect(alertSpy.mock.calls[0][1]).toBe(CLOSE_OTHER_CONFIRM_BODY);
    expect(mockCloseOther).not.toHaveBeenCalled();

    pressAlertButton((button) => button.text === CLOSE_OTHER_KEEP_LABEL);
    expect(mockCloseOther).not.toHaveBeenCalled();

    tap(root, 'import-close-other');
    pressAlertButton((button) => button.text === CLOSE_OTHER_CONFIRM_LABEL);
    expect(mockCloseOther).toHaveBeenCalledTimes(1);
  });

  it('holds the button busy, and Import disabled, while the close runs', () => {
    mockCloseOther.mockReturnValue(new Promise<string>(() => {}));
    const renderer = renderBlockedPreflight();
    const root = renderer.root;

    tap(root, 'import-close-other');
    pressAlertButton((button) => button.text === CLOSE_OTHER_CONFIRM_LABEL);

    expect(controlProps(root, 'import-close-other').loading).toBe(true);
    expect(controlProps(root, 'import-confirm').disabled).toBe(true);

    // A second tap neither re-asks nor re-closes.
    tap(root, 'import-close-other');
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(mockCloseOther).toHaveBeenCalledTimes(1);
  });

  /**
   * The latch is FINALLY-ONLY by nature: a successful close re-prices the
   * preflight in place, so the signature — phase, job, summary — never moves.
   * Only the promise settling can give the button back, which is why every
   * outcome is checked rather than the happy one.
   */
  it.each(['closed', 'closed-stale', 'failed', 'cancelled'] as const)(
    'returns the button on a %s result',
    async (outcome) => {
      mockCloseOther.mockResolvedValue(outcome);
      const renderer = renderBlockedPreflight();
      const root = renderer.root;

      tap(root, 'import-close-other');
      await act(async () => {
        alertButtons()
          .find((button) => button.text === CLOSE_OTHER_CONFIRM_LABEL)
          ?.onPress?.();
      });

      expect(store.getState().preflight).toBe(BLOCKED_PREFLIGHT);
      expect(controlProps(root, 'import-close-other').loading).toBe(false);
    },
  );

  it('shows an error banner only when the close actually failed', async () => {
    mockCloseOther.mockResolvedValue('failed');
    const renderer = renderBlockedPreflight();
    const root = renderer.root;

    tap(root, 'import-close-other');
    await act(async () => {
      alertButtons()
        .find((button) => button.text === CLOSE_OTHER_CONFIRM_LABEL)
        ?.onPress?.();
    });

    expect(hasHostTestId(root, 'import-close-other-error')).toBe(true);
    expect(renderedText(root)).toContain(CLOSE_OTHER_FAILED_COPY);
    expect(hasHostTestId(root, 'import-close-other-stale')).toBe(false);
  });

  /**
   * `closed-stale` is the honest middle: the other session IS closed, only the
   * re-price failed. An error banner would tell the member to retry something
   * that already worked.
   */
  it('reports a stale close as information, not an error', async () => {
    mockCloseOther.mockResolvedValue('closed-stale');
    const renderer = renderBlockedPreflight();
    const root = renderer.root;

    tap(root, 'import-close-other');
    await act(async () => {
      alertButtons()
        .find((button) => button.text === CLOSE_OTHER_CONFIRM_LABEL)
        ?.onPress?.();
    });

    expect(String(findHostByTestId(root, 'import-close-other-stale').props.children)).toBe(
      describeCloseOtherStale('facebook'),
    );
    expect(hasHostTestId(root, 'import-close-other-error')).toBe(false);
    // Import stays disabled: the allowance on screen is still the old one.
    expect(controlProps(root, 'import-confirm').disabled).toBe(true);
    // …and re-tapping is safe, because `/complete` is idempotent.
    expect(controlProps(root, 'import-close-other').loading).toBe(false);
  });

  it('leaves nothing on screen when the close worked', async () => {
    mockCloseOther.mockResolvedValue('closed');
    const renderer = renderBlockedPreflight();
    const root = renderer.root;

    tap(root, 'import-close-other');
    await act(async () => {
      alertButtons()
        .find((button) => button.text === CLOSE_OTHER_CONFIRM_LABEL)
        ?.onPress?.();
    });

    expect(hasHostTestId(root, 'import-close-other-error')).toBe(false);
    expect(hasHostTestId(root, 'import-close-other-stale')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// "Import the other one" (#996)
//
// One job is one source, so the other half of the same export is a second
// import — and the member has those files on their device right now.
// ---------------------------------------------------------------------------

const BOTH_SOURCES_SUMMARY: ImportSummary = { ...COMPLETED_SUMMARY, otherSourceDetected: true };

/** A parse that saw both platforms, for the refusal views' "instead" offer. */
const BOTH_SOURCES_PARSE: ParseSummary = {
  importable: 0,
  importableMedia: 0,
  skipped: NO_SKIPS,
  earliestDate: null,
  latestDate: null,
  fileIssues: [],
  idScheme: { fbid: 0, content: 0 },
  otherSourceDetected: true,
  locationDataRemoved: false,
};

describe('ImportStatusScreen — importing the other source', () => {
  function renderSummaryOffer(summary: ImportSummary = BOTH_SOURCES_SUMMARY): ReactTestRenderer {
    store.setState({
      phase: 'done',
      jobId: 'job-1',
      conversationId: 'g1',
      source: 'facebook',
      summary,
    });
    return renderScreen();
  }

  it('offers the other source on a settled summary', () => {
    const renderer = renderSummaryOffer();
    const root = renderer.root;

    expect(String(findHostByTestId(root, 'import-other-source-offer').props.children)).toBe(
      describeOtherSourceOffer('facebook'),
    );
    expect(controlProps(root, 'import-other-source').title).toBe(
      describeImportOtherLabel('instagram'),
    );
  });

  it('offers nothing when the export held only this source', () => {
    const renderer = renderSummaryOffer(COMPLETED_SUMMARY);
    expect(hasHostTestId(renderer.root, 'import-other-source-offer')).toBe(false);
    expect(hasHostTestId(renderer.root, 'import-other-source')).toBe(false);
  });

  it.each([
    ['cancelled', { ...CANCELLED_SUMMARY, otherSourceDetected: true }],
    ['failed', { ...FAILED_SUMMARY, otherSourceDetected: true }],
  ])('offers it on a %s summary too', (_name, summary) => {
    const renderer = renderSummaryOffer(summary as ImportSummary);
    expect(hasHostTestId(renderer.root, 'import-other-source')).toBe(true);
  });

  /**
   * The capture is the whole subtlety: `dismissImportSummary` resets the store
   * to INITIAL_STATE, which NULLS `conversationId`. Reading it after the
   * dismiss would navigate with nothing.
   */
  it('dismisses first, then replaces with the orbit it captured', () => {
    const renderer = renderSummaryOffer();

    tap(renderer.root, 'import-other-source');

    expect(mockDismiss).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('ImportHowTo', {
      conversationId: 'g1',
      preferredSource: 'instagram',
    });
    expect(mockDismiss.mock.invocationCallOrder[0]).toBeLessThan(
      mockReplace.mock.invocationCallOrder[0],
    );
  });

  it('replaces exactly once on a double tap, and never with a null orbit', () => {
    const renderer = renderSummaryOffer();
    const root = renderer.root;

    // The real dismiss nulls the store; this one does too, so the second tap
    // meets the same world the member's second tap would — including the
    // button being gone from the tree, which is why the handler is captured
    // from the FIRST render and called twice.
    mockDismiss.mockImplementation(() => {
      store.setState({ ...BASE_STATE }, true);
    });
    const press = (findByTestId(root, 'import-other-source').props as { onPress: () => void })
      .onPress;

    act(() => {
      press();
      press();
    });

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace.mock.calls[0][1]).toEqual({
      conversationId: 'g1',
      preferredSource: 'instagram',
    });
  });

  it('disables Done while the second import is starting', () => {
    const renderer = renderSummaryOffer();
    const root = renderer.root;

    expect(controlProps(root, 'import-summary-done').disabled).toBe(false);
    tap(root, 'import-other-source');
    expect(controlProps(root, 'import-summary-done').disabled).toBe(true);
  });

  it.each([
    ['refused', { ...REFUSED_PREFLIGHT, summary: BOTH_SOURCES_PARSE }],
    ['nothing', { ...NOTHING_PREFLIGHT, summary: BOTH_SOURCES_PARSE }],
  ])('offers "instead" from a %s preflight, discarding first', async (_name, preflight) => {
    store.setState({
      phase: 'ready',
      jobId: 'job-1',
      conversationId: 'g1',
      source: 'facebook',
      preflight: preflight as ImportPreflight,
    });
    const renderer = renderScreen();
    const root = renderer.root;

    expect(controlProps(root, 'import-other-instead').title).toBe(
      describeImportOtherInsteadLabel('instagram'),
    );

    await tapAndSettle(root, 'import-other-instead');

    expect(mockDiscard).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('ImportHowTo', {
      conversationId: 'g1',
      preferredSource: 'instagram',
    });
    expect(mockDiscard.mock.invocationCallOrder[0]).toBeLessThan(
      mockReplace.mock.invocationCallOrder[0],
    );
  });

  it('shows no "instead" offer when the export held only this source', () => {
    store.setState({
      phase: 'ready',
      jobId: 'job-1',
      conversationId: 'g1',
      source: 'facebook',
      preflight: REFUSED_PREFLIGHT,
    });
    const renderer = renderScreen();
    expect(hasHostTestId(renderer.root, 'import-other-instead')).toBe(false);
  });

  it('replaces exactly once when "instead" is double-tapped', async () => {
    store.setState({
      phase: 'ready',
      jobId: 'job-1',
      conversationId: 'g1',
      source: 'facebook',
      preflight: { ...REFUSED_PREFLIGHT, summary: BOTH_SOURCES_PARSE },
    });
    const renderer = renderScreen();
    const root = renderer.root;

    await act(async () => {
      (findByTestId(root, 'import-other-instead').props as { onPress: () => void }).onPress();
      (findByTestId(root, 'import-other-instead').props as { onPress: () => void }).onPress();
    });

    expect(mockDiscard).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace.mock.calls[0][1]).toEqual({
      conversationId: 'g1',
      preferredSource: 'instagram',
    });
  });
});
