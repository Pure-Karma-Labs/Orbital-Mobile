/**
 * The Settings entry point for the Meta import (#928 §3.3).
 *
 * ## What this suite pins
 *
 * 1. **Gating.** Each of §3.3's five hide reasons, independently: no active
 *    orbit, a DM, `hydrating`, a 404 probe, a REJECTED probe.
 * 2. **One import per device.** The start rows disappear for every view whose
 *    job already exists, including `blocked`.
 * 3. **The section is OFF the 250 ms emission stream.** A fixed render count
 *    across counter-only store writes is the assertion that would fail the day
 *    someone widens a selector or puts a count in the row label.
 * 4. **The orbit name never enters a `SettingsRow` label** — it reaches the
 *    screen only through `EmojiText`.
 *
 * ## Mocking shape
 *
 * The runner is mocked EXCEPT for its store, which is a real
 * `zustand/vanilla` store the tests write to in order to drive phases — the
 * `FileLibraryScreen.test.tsx:194-218` pattern. A plain object would break
 * `useSyncExternalStore`, and with it the very bail-out behaviour test (3)
 * exists to measure.
 *
 * `useFocusEffect` is implemented as a plain `useEffect` so the availability
 * probe actually runs; without it every test would see `checking` and the
 * section would be hidden for the wrong reason.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../../theme';
import {
  findAllByTestId,
  findByTestId,
  findHostByTestId,
  hasHostTestId,
  renderedText,
} from '../../../testUtils/rtr';
import { ImportSettingsSection } from '../ImportSettingsSection';
import {
  IMPORT_SECTION_HEADER,
  OTHER_ORBIT_STATUS_LABEL,
  describeIntoCaption,
  describeOtherOrbitCaption,
  describeStartRow,
} from '../importCopy';

import type { ImportPreflight, ImportRunnerState } from '../../../services/metaImport/importRunner';
import type { SkipReason } from '../../../services/metaImport/types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  // The real hook runs its callback on focus. react-test-renderer has no
  // navigator, so the effect would never fire and the probe would never
  // resolve — `useEffect(cb, [cb])` is the same contract (run, return the
  // cleanup) minus the focus subscription.
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    const ReactModule = require('react');
    ReactModule.useEffect(effect, [effect]);
  },
}));

interface FakeConversation {
  id: string;
  name: string;
  type: string;
}

interface FakeAppState {
  activeConversationId: string | null;
  conversations: Record<string, FakeConversation>;
}

/** Mutable: each test sets it BEFORE rendering, as a real store read would. */
const mockAppState: FakeAppState = { activeConversationId: null, conversations: {} };

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
      phase: 'hydrating',
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
    probeImportAvailability: jest.fn(),
    pickAndStartParse: jest.fn(),
    cancelImport: jest.fn(),
    resumeImportAtLaunch: jest.fn(),
  };
});

import { importStore, probeImportAvailability } from '../../../services/metaImport/importRunner';

const mockProbe = probeImportAvailability as jest.Mock;

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

const ALLOWANCE = {
  postsUsed: 0,
  bytesUsed: 0,
  postsLimit: 1000,
  bytesLimit: 2147483648,
};

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

/** A runnable preflight — `deriveImportView` reads only the two flags. */
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
  heldVideo: 0,
  skippedByReason: NO_SKIPS,
};

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

const ACTIVE_ORBIT: FakeConversation = { id: 'g1', name: 'Test Orbit', type: 'group' };
const OTHER_ORBIT: FakeConversation = { id: 'g2', name: 'Other Orbit', type: 'group' };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const mountedRenderers: ReactTestRenderer[] = [];

function sectionElement(onRender?: React.ProfilerOnRenderCallback): React.ReactElement {
  const section = React.createElement(ImportSettingsSection, null);
  const body =
    onRender === undefined
      ? section
      : React.createElement(React.Profiler, { id: 'import-settings-section', onRender }, section);
  return React.createElement(ThemeProvider, { colorSchemeOverride: 'light' }, body);
}

/**
 * Mounts and flushes the availability probe.
 *
 * `await act(async …)` is required: the probe resolves in a microtask and its
 * `setState` is what decides whether the section renders at all.
 */
async function renderSection(
  onRender?: React.ProfilerOnRenderCallback,
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(sectionElement(onRender));
  });
  mountedRenderers.push(renderer);
  return renderer;
}

/** Every testID the section can render. All three must be gone when hidden. */
function expectHidden(root: ReactTestInstance): void {
  expect(hasHostTestId(root, 'import-status-row')).toBe(false);
  expect(hasHostTestId(root, 'import-facebook-row')).toBe(false);
  expect(hasHostTestId(root, 'import-instagram-row')).toBe(false);
  expect(hasHostTestId(root, 'import-into-caption')).toBe(false);
}

interface RowProps {
  label: string;
  emojiUnified: string;
}

/**
 * The `SettingsRow` COMPONENT node's props — where `label` and `emojiUnified`
 * live. Presence is asserted separately through `hasHostTestId`; this is only
 * for reading props off a row already known to be on screen.
 */
function rowProps(root: ReactTestInstance, testID: string): RowProps {
  const node = findAllByTestId(root, testID).find(
    (candidate) =>
      typeof candidate.props.label === 'string' && typeof candidate.props.emojiUnified === 'string',
  );
  if (node === undefined) throw new Error(`No SettingsRow props for testID "${testID}"`);
  return node.props as RowProps;
}

function press(root: ReactTestInstance, testID: string): void {
  act(() => {
    (findByTestId(root, testID).props as { onPress: () => void }).onPress();
  });
}

function captionText(root: ReactTestInstance, testID: string): string {
  return String(findHostByTestId(root, testID).props.children);
}

function setAvailable(): void {
  mockProbe.mockResolvedValue({ available: true, allowance: ALLOWANCE, limits: LIMITS });
}

/** The §3.3 happy path: a group orbit, an available probe, no job. */
function setUpShown(): void {
  mockAppState.activeConversationId = 'g1';
  mockAppState.conversations = { g1: ACTIVE_ORBIT, g2: OTHER_ORBIT };
  setAvailable();
  importStore.setState({ ...BASE_STATE }, true);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAppState.activeConversationId = null;
  mockAppState.conversations = {};
  importStore.setState({ ...BASE_STATE }, true);
  setAvailable();
});

afterEach(() => {
  while (mountedRenderers.length > 0) {
    const renderer = mountedRenderers.pop();
    act(() => {
      renderer?.unmount();
    });
  }
});

// ---------------------------------------------------------------------------
// §3.3 gating — hidden
// ---------------------------------------------------------------------------

describe('ImportSettingsSection — hidden (§3.3)', () => {
  it('renders nothing when there is no active conversation', async () => {
    mockAppState.activeConversationId = null;
    mockAppState.conversations = { g1: ACTIVE_ORBIT };

    const renderer = await renderSection();

    expectHidden(renderer.root);
  });

  it('renders nothing when the active conversation is a DM', async () => {
    mockAppState.activeConversationId = 'dm1';
    mockAppState.conversations = { dm1: { id: 'dm1', name: 'Bob', type: 'direct' } };
    setAvailable();

    const renderer = await renderSection();

    expectHidden(renderer.root);
  });

  it('renders nothing while the runner is hydrating', async () => {
    setUpShown();
    importStore.setState({ phase: 'hydrating' });

    const renderer = await renderSection();

    expectHidden(renderer.root);
  });

  it('renders nothing when the probe answers unavailable (404, flag off)', async () => {
    setUpShown();
    mockProbe.mockResolvedValue({ available: false, allowance: null, limits: null });

    const renderer = await renderSection();

    expect(mockProbe).toHaveBeenCalledWith('g1');
    expectHidden(renderer.root);
  });

  it('renders nothing when the probe REJECTS (network failure)', async () => {
    setUpShown();
    mockProbe.mockRejectedValue(new Error('offline'));

    const renderer = await renderSection();

    expect(mockProbe).toHaveBeenCalledWith('g1');
    expectHidden(renderer.root);
  });
});

// ---------------------------------------------------------------------------
// §3.3 gating — shown
// ---------------------------------------------------------------------------

describe('ImportSettingsSection — shown (§3.3)', () => {
  it('renders the header, the orbit caption and both start rows when idle', async () => {
    setUpShown();

    const renderer = await renderSection();
    const root = renderer.root;

    expect(renderedText(root)).toContain(IMPORT_SECTION_HEADER);
    expect(hasHostTestId(root, 'import-into-caption')).toBe(true);
    expect(captionText(root, 'import-into-caption')).toBe(describeIntoCaption('Test Orbit'));
    expect(hasHostTestId(root, 'import-facebook-row')).toBe(true);
    expect(hasHostTestId(root, 'import-instagram-row')).toBe(true);
    expect(rowProps(root, 'import-facebook-row').label).toBe(describeStartRow('facebook'));
    expect(rowProps(root, 'import-instagram-row').label).toBe(describeStartRow('instagram'));
    // No job on this device ⇒ nothing to show a status for.
    expect(hasHostTestId(root, 'import-status-row')).toBe(false);
  });

  it('carries the inbox glyph on every row it renders', async () => {
    setUpShown();

    const idle = await renderSection();
    expect(rowProps(idle.root, 'import-facebook-row').emojiUnified).toBe('1F4E5');
    expect(rowProps(idle.root, 'import-instagram-row').emojiUnified).toBe('1F4E5');

    importStore.setState({ phase: 'running', jobId: 'job-1', conversationId: 'g1' });
    const running = await renderSection();
    expect(hasHostTestId(running.root, 'import-status-row')).toBe(true);
    expect(rowProps(running.root, 'import-status-row').emojiUnified).toBe('1F4E5');
  });
});

// ---------------------------------------------------------------------------
// One import per device: the start rows go away for every active-job view
// ---------------------------------------------------------------------------

describe('ImportSettingsSection — active job suppresses the start rows', () => {
  const activeJobViews: ReadonlyArray<[string, Partial<ImportRunnerState>]> = [
    ['parsing', { phase: 'parsing', jobId: 'job-1', conversationId: 'g1' }],
    [
      'runnable ready (preflight)',
      { phase: 'ready', jobId: 'job-1', conversationId: 'g1', preflight: RUNNABLE_PREFLIGHT },
    ],
    ['running', { phase: 'running', jobId: 'job-1', conversationId: 'g1' }],
    ['paused', { phase: 'paused', jobId: 'job-1', conversationId: 'g1', pauseCauses: ['network'] }],
    ['idle with a jobId (blocked)', { phase: 'idle', jobId: 'job-1', conversationId: 'g1' }],
  ];

  it.each(activeJobViews)(
    'hides both start rows and shows a status row: %s',
    async (_name, patch) => {
      setUpShown();
      importStore.setState(patch);

      const renderer = await renderSection();
      const root = renderer.root;

      expect(hasHostTestId(root, 'import-status-row')).toBe(true);
      expect(hasHostTestId(root, 'import-facebook-row')).toBe(false);
      expect(hasHostTestId(root, 'import-instagram-row')).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// The count-free label (the whole reason this is its own component)
// ---------------------------------------------------------------------------

describe('ImportSettingsSection — the status label is count-free', () => {
  it('carries no digits while a run is draining', async () => {
    setUpShown();
    importStore.setState({
      phase: 'running',
      jobId: 'job-1',
      conversationId: 'g1',
      total: 300,
      created: 12,
      mediaDone: 7,
    });

    const renderer = await renderSection();
    const label = rowProps(renderer.root, 'import-status-row').label;

    expect(label).not.toMatch(/\d/);
    // Positive control: the helper really did read the row.
    expect(label.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// A job in another orbit
// ---------------------------------------------------------------------------

describe('ImportSettingsSection — a job in another orbit', () => {
  it('labels the row generically and names the orbit only in the caption', async () => {
    setUpShown();
    importStore.setState({ phase: 'running', jobId: 'job-1', conversationId: 'g2' });

    const renderer = await renderSection();
    const root = renderer.root;

    expect(rowProps(root, 'import-status-row').label).toBe(OTHER_ORBIT_STATUS_LABEL);
    expect(rowProps(root, 'import-status-row').label).not.toContain('Other Orbit');
    expect(hasHostTestId(root, 'import-other-orbit-caption')).toBe(true);
    expect(captionText(root, 'import-other-orbit-caption')).toBe(
      describeOtherOrbitCaption('Other Orbit'),
    );
    expect(captionText(root, 'import-other-orbit-caption')).toContain('Other Orbit');
  });

  it('falls back to "an orbit you\'ve left" when the orbit is gone', async () => {
    setUpShown();
    mockAppState.conversations = { g1: ACTIVE_ORBIT };
    importStore.setState({ phase: 'running', jobId: 'job-1', conversationId: 'g-left' });

    const renderer = await renderSection();

    expect(captionText(renderer.root, 'import-other-orbit-caption')).toBe(
      describeOtherOrbitCaption(null),
    );
    expect(captionText(renderer.root, 'import-other-orbit-caption')).toContain(
      "an orbit you've left",
    );
  });

  it('shows no other-orbit caption when the job is in the active orbit', async () => {
    setUpShown();
    importStore.setState({ phase: 'running', jobId: 'job-1', conversationId: 'g1' });

    const renderer = await renderSection();

    expect(hasHostTestId(renderer.root, 'import-status-row')).toBe(true);
    expect(hasHostTestId(renderer.root, 'import-other-orbit-caption')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe('ImportSettingsSection — taps', () => {
  it('navigates to ImportStatus with no params from the status row', async () => {
    setUpShown();
    importStore.setState({ phase: 'running', jobId: 'job-1', conversationId: 'g1' });

    const renderer = await renderSection();
    press(renderer.root, 'import-status-row');

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('ImportStatus');
  });

  it('navigates to ImportHowTo with the source and the ACTIVE orbit', async () => {
    setUpShown();

    const renderer = await renderSection();

    press(renderer.root, 'import-facebook-row');
    expect(mockNavigate).toHaveBeenLastCalledWith('ImportHowTo', {
      source: 'facebook',
      conversationId: 'g1',
    });

    press(renderer.root, 'import-instagram-row');
    expect(mockNavigate).toHaveBeenLastCalledWith('ImportHowTo', {
      source: 'instagram',
      conversationId: 'g1',
    });

    expect(mockNavigate).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Off the 250 ms emission stream
// ---------------------------------------------------------------------------

describe('ImportSettingsSection — render count', () => {
  /**
   * The section subscribes to a store that emits every 250 ms during a run.
   * Only PHASE-shaped fields are selected, so counter emissions must bail out
   * in `useSyncExternalStore` and commit nothing.
   *
   * Counted with a `React.Profiler` wrapper rather than by instrumenting the
   * component: `onRender` fires once per commit in its subtree, and a bailed-out
   * update produces no commit at all.
   */
  it('does not re-render on counter-only emissions', async () => {
    setUpShown();
    importStore.setState({
      phase: 'running',
      jobId: 'job-1',
      conversationId: 'g1',
      total: 300,
    });

    let renders = 0;
    const renderer = await renderSection(() => {
      renders += 1;
    });

    // Positive control: the wrapper is wired up and the section is on screen.
    expect(renders).toBeGreaterThan(0);
    expect(hasHostTestId(renderer.root, 'import-status-row')).toBe(true);
    const baseline = renders;

    for (const created of [1, 2, 3, 4, 5]) {
      act(() => {
        importStore.setState({ created, total: 300, mediaDone: created * 2 });
      });
    }

    expect(renders).toBe(baseline);
    // …and the label is still the one the member sees, unchanged.
    expect(rowProps(renderer.root, 'import-status-row').label).not.toMatch(/\d/);
  });

  it('DOES re-render when the phase changes (the control for the test above)', async () => {
    setUpShown();
    importStore.setState({ phase: 'running', jobId: 'job-1', conversationId: 'g1' });

    let renders = 0;
    await renderSection(() => {
      renders += 1;
    });
    const baseline = renders;

    act(() => {
      importStore.setState({ phase: 'paused', pauseCauses: ['network'] });
    });

    expect(renders).toBeGreaterThan(baseline);
  });
});
