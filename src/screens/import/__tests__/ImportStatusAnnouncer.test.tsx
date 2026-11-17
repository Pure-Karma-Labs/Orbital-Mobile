/**
 * The import's accessibility announcements (#928 §3.5).
 *
 * ## What this suite pins
 *
 * 1. **Mounting mid-run says nothing.** The last announced kind is seeded from
 *    the store, so coming back to the app during an import does not re-announce
 *    "Importing 300 posts" over whatever the member is doing.
 * 2. **A KIND transition, never a tick.** The runner republishes every 250 ms;
 *    a counter-driven announcement would talk over everything else for the
 *    length of the run.
 * 3. **`paused → running` is "Import continued".** §4.4's rule against the word
 *    "resume" is unqualified, and a bare `Importing N posts` would also be a
 *    lie about where the run restarted.
 * 4. **It works with no tab bar at all.** That is the whole reason it lives in
 *    `App.tsx` rather than inside the status strip: `CustomTabBar` returns null
 *    while the Android keyboard is open, and an announcer mounted in there
 *    would silently swallow every transition that happened meanwhile. This
 *    suite mounts it ALONE.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AccessibilityInfo } from 'react-native';
import { ImportStatusAnnouncer } from '../ImportStatusAnnouncer';
import { PAUSE_COPY, describeSummaryHeadline, plural } from '../importCopy';

import type { ImportPreflight, ImportSummary } from '../../../services/metaImport/importRunner';
import type { SkipReason } from '../../../services/metaImport/types';
import type { ImportRunnerState } from '../../../services/metaImport/importRunner';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
  };
});

import { importStore } from '../../../services/metaImport/importRunner';

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

const RUNNABLE_PREFLIGHT: ImportPreflight = {
  summary: null,
  source: 'facebook' as const,
  otherOpenImport: null,
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
  importable: 300,
  remainingPosts: 700,
  estimatedBytes: 1024,
  remainingBytes: 2147482624,
  overAllowance: null,
  nothingToImport: false,
  alreadyPresent: 0,
  alreadyPresentMedia: 0,
  heldVideo: 0,
  skippedByReason: NO_SKIPS,
};

const REFUSED_PREFLIGHT: ImportPreflight = { ...RUNNABLE_PREFLIGHT, overAllowance: 'bytes' };
const NOTHING_PREFLIGHT: ImportPreflight = { ...RUNNABLE_PREFLIGHT, nothingToImport: true };

const SUMMARY: ImportSummary = {
  source: 'facebook' as const,
  otherSourceDetected: false,
  created: 298,
  duplicate: 2,
  failed: 0,
  heldVideo: 0,
  skippedByReason: NO_SKIPS,
  notSubmitted: 0,
  errorCode: null,
  cancelled: false,
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

const RUNNING_STATE: Partial<ImportRunnerState> = {
  phase: 'running',
  jobId: 'job-1',
  conversationId: 'g1',
  source: 'facebook',
  total: 300,
  created: 7,
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const mountedRenderers: ReactTestRenderer[] = [];

/** Mounted ALONE — no navigator, no tab bar, no theme. */
function mountAnnouncer(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ImportStatusAnnouncer />);
  });
  mountedRenderers.push(renderer);
  return renderer;
}

function setState(patch: Partial<ImportRunnerState>): void {
  act(() => {
    store.setState(patch);
  });
}

function announcements(): string[] {
  return announceSpy.mock.calls.map((call) => String(call[0]));
}

let announceSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  store.setState({ ...BASE_STATE }, true);
  announceSpy = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibility')
    .mockImplementation(() => undefined);
});

afterEach(() => {
  while (mountedRenderers.length > 0) {
    const renderer = mountedRenderers.pop();
    act(() => {
      renderer?.unmount();
    });
  }
  announceSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

describe('ImportStatusAnnouncer — mount', () => {
  it('renders nothing and announces nothing for a run already in progress', () => {
    store.setState(RUNNING_STATE);

    const renderer = mountAnnouncer();

    expect(renderer.toJSON()).toBeNull();
    expect(announceSpy).not.toHaveBeenCalled();
  });

  it('announces a transition with no tab bar, navigator or theme mounted', () => {
    store.setState(RUNNING_STATE);
    const renderer = mountAnnouncer();

    setState({ phase: 'paused', pauseCauses: ['network'] });

    expect(announcements()).toEqual([`Import paused. ${PAUSE_COPY.network.strip}`]);
    expect(renderer.toJSON()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// One announcement per KIND transition
// ---------------------------------------------------------------------------

describe('ImportStatusAnnouncer — transitions, not ticks', () => {
  it('stays silent through counter emissions and speaks once per kind change', () => {
    store.setState(RUNNING_STATE);
    mountAnnouncer();

    for (const created of [8, 9, 10, 11]) {
      setState({ created, mediaDone: created * 2 });
    }
    expect(announceSpy).not.toHaveBeenCalled();

    setState({ phase: 'paused', pauseCauses: ['network'] });
    expect(announceSpy).toHaveBeenCalledTimes(1);

    for (const created of [12, 13, 14]) {
      setState({ created, mediaDone: created * 2 });
    }
    expect(announceSpy).toHaveBeenCalledTimes(1);

    setState({ phase: 'running' });
    expect(announceSpy).toHaveBeenCalledTimes(2);
    expect(announcements()[1]).toBe('Import continued');
  });

  it('says nothing when a pause merely swaps one cause for another', () => {
    store.setState({ ...RUNNING_STATE, phase: 'paused', pauseCauses: ['network'] });
    mountAnnouncer();

    setState({ pauseCauses: ['archive_retry'] });

    expect(announceSpy).not.toHaveBeenCalled();
  });

  it('announces the post count when the run starts from a preflight', () => {
    store.setState({
      phase: 'ready',
      jobId: 'job-1',
      conversationId: 'g1',
      source: 'facebook',
      preflight: RUNNABLE_PREFLIGHT,
    });
    mountAnnouncer();

    setState({ phase: 'running', total: 300 });

    expect(announcements()).toEqual([`Importing ${plural(300, 'post')}`]);
  });

  it('announces the summary headline when the run settles', () => {
    store.setState(RUNNING_STATE);
    mountAnnouncer();

    setState({ phase: 'done', summary: SUMMARY });

    expect(announcements()).toEqual([describeSummaryHeadline(SUMMARY)]);
  });
});

// ---------------------------------------------------------------------------
// The silent kinds
// ---------------------------------------------------------------------------

describe('ImportStatusAnnouncer — the kinds worth no interruption', () => {
  const silent: ReadonlyArray<[string, Partial<ImportRunnerState>]> = [
    ['checking', { phase: 'hydrating' }],
    ['none', { phase: 'idle', jobId: null }],
    ['blocked', { phase: 'idle', jobId: 'job-1' }],
    ['nothing', { phase: 'ready', preflight: NOTHING_PREFLIGHT }],
    ['refused', { phase: 'ready', preflight: REFUSED_PREFLIGHT }],
  ];

  it.each(silent)('says nothing on a transition into %s', (_name, patch) => {
    store.setState(RUNNING_STATE);
    mountAnnouncer();

    setState(patch);

    expect(announceSpy).not.toHaveBeenCalled();
  });

  it('is not silent about everything (the control for the table above)', () => {
    store.setState(RUNNING_STATE);
    mountAnnouncer();

    setState({ phase: 'paused', pauseCauses: ['needs_repick'] });

    expect(announcements()).toEqual([`Import paused. ${PAUSE_COPY.needs_repick.strip}`]);
  });
});
