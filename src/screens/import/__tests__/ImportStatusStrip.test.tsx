/**
 * The one line above the tab bar while an import is live (#928 §3.4).
 *
 * ## What this suite pins
 *
 * 1. **It appears only when it has something to say.** `describeStripLine`
 *    returning null is what hides it — an empty strip would still eat a fixed
 *    line of every tab screen.
 * 2. **It hides on the import's own routes.** Repeating the screen the member
 *    is already reading is noise, and tapping it would go nowhere.
 * 3. **The hook order never changes with the focused route.** The hide is a
 *    late `return null`, AFTER every hook. A hook called conditionally would
 *    crash the tab bar the first time the member opened ImportStatus — which is
 *    precisely the render this suite drives, on the SAME component instance.
 * 4. **This is the one place counts belong.** The Settings row is count-free so
 *    that screen stays off the 250 ms emission stream; the strip is not.
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '../../../theme';
import { findByTestId, findHostByTestId, hasHostTestId } from '../../../testUtils/rtr';
import { EmojiText } from '../../../components/EmojiText';
import { ImportStatusStrip } from '../ImportStatusStrip';
import { PAUSE_COPY, describeRunProgress } from '../importCopy';

import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import type { NavigationState, ParamListBase, PartialState } from '@react-navigation/native';
import type { ImportRunnerState } from '../../../services/metaImport/importRunner';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('../openImportStatus', () => ({ openImportStatus: jest.fn() }));

interface FakeAppState {
  activeConversationId: string | null;
  conversations: Record<string, { id: string; name: string; type: string }>;
}

const ORBIT_NAME = 'Family Orbit';

const mockAppState: FakeAppState = {
  activeConversationId: 'g1',
  conversations: { g1: { id: 'g1', name: ORBIT_NAME, type: 'group' } },
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
  };
});

import { importStore } from '../../../services/metaImport/importRunner';
import { openImportStatus } from '../openImportStatus';

const store = importStore;
const mockOpen = openImportStatus as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type NestedState = NavigationState<ParamListBase> | PartialState<NavigationState<ParamListBase>>;
type TabState = BottomTabBarProps['state'];

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
  created: 10,
  duplicate: 1,
  failed: 1,
  heldVideo: 0,
};

/** A Settings stack focused on `screens`' last entry. */
function nestedStack(screens: string[]): NestedState {
  return {
    key: 'SettingsStack-key',
    index: screens.length - 1,
    routes: screens.map((name, index) => ({
      key: `${name}-key-${index}`,
      name,
      params: undefined,
    })),
    routeNames: screens,
    type: 'stack',
    stale: false as const,
  };
}

function tabState(options: { focusedIndex?: number; settingsNested?: NestedState }): TabState {
  const routes = [
    { key: 'Threads-key', name: 'Threads', params: undefined, state: undefined },
    { key: 'Chats-key', name: 'Chats', params: undefined, state: undefined },
    {
      key: 'Settings-key',
      name: 'Settings',
      params: undefined,
      state: options.settingsNested,
    },
  ];

  return {
    index: options.focusedIndex ?? 0,
    routes,
    key: 'tab-state-key',
    routeNames: ['Threads', 'Chats', 'Settings'],
    type: 'tab',
    stale: false,
    history: [],
    preloadedRouteKeys: [],
  } as unknown as TabState;
}

const navigation = {
  navigate: jest.fn(),
  dispatch: jest.fn(),
  emit: jest.fn(),
} as unknown as BottomTabBarProps['navigation'];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const mountedRenderers: ReactTestRenderer[] = [];

function stripElement(state: TabState): React.ReactElement {
  return (
    <ThemeProvider colorSchemeOverride="light">
      <ImportStatusStrip tabState={state} navigation={navigation} />
    </ThemeProvider>
  );
}

function renderStrip(state: TabState = tabState({ focusedIndex: 0 })): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(stripElement(state));
  });
  mountedRenderers.push(renderer);
  return renderer;
}

function stripLabel(root: ReactTestInstance): string {
  return String(findHostByTestId(root, 'import-status-strip').props.accessibilityLabel);
}

/**
 * `EmojiText` is a `React.memo`, and react-test-renderer renders the INNER
 * function: the tree node's `type` is `EmojiText.type`, which is why
 * `findAllByType(EmojiText)` finds nothing. Comparing against that inner
 * function keeps the assertion exact — a plain `Text` cannot satisfy it.
 */
const EMOJI_TEXT_INNER = (EmojiText as unknown as { type: unknown }).type;

function findEmojiTexts(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((node) => node.type === EMOJI_TEXT_INNER);
}

beforeEach(() => {
  jest.clearAllMocks();
  store.setState({ ...BASE_STATE }, true);
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
// When there is a line, and when there is not
// ---------------------------------------------------------------------------

describe('ImportStatusStrip — when it appears', () => {
  it('renders the running line, counts and all', () => {
    store.setState(RUNNING_STATE);

    const renderer = renderStrip();

    expect(hasHostTestId(renderer.root, 'import-status-strip')).toBe(true);
    const label = stripLabel(renderer.root);
    // 10 created + 1 duplicate + 1 failed = 12 settled of 300.
    expect(label).toContain(describeRunProgress(12, 300));
    // The strip is the ONE place counts belong.
    expect(label).toMatch(/\d/);
  });

  it('renders a paused line from the cause', () => {
    store.setState({
      ...RUNNING_STATE,
      phase: 'paused',
      pauseCauses: ['network'],
    });

    const renderer = renderStrip();

    expect(stripLabel(renderer.root)).toContain(PAUSE_COPY.network.strip);
  });

  it.each([
    ['idle with no job (none)', { phase: 'idle' as const, jobId: null }],
    ['hydrating (checking)', { phase: 'hydrating' as const }],
  ])('renders nothing at all: %s', (_name, patch) => {
    store.setState(patch);

    const renderer = renderStrip();

    expect(renderer.toJSON()).toBeNull();
    expect(hasHostTestId(renderer.root, 'import-status-strip')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hiding on the import's own routes
// ---------------------------------------------------------------------------

describe('ImportStatusStrip — the focused route', () => {
  const importRoutes = ['ImportStatus', 'ImportHowTo', 'ImportUnmigrated'];

  it.each(importRoutes)('hides while %s is the focused Settings screen', (routeName) => {
    store.setState(RUNNING_STATE);

    const renderer = renderStrip(
      tabState({ focusedIndex: 2, settingsNested: nestedStack(['SettingsMain', routeName]) }),
    );

    expect(renderer.toJSON()).toBeNull();
  });

  it('shows while SettingsMain is the focused Settings screen', () => {
    store.setState(RUNNING_STATE);

    const renderer = renderStrip(
      tabState({ focusedIndex: 2, settingsNested: nestedStack(['SettingsMain']) }),
    );

    expect(hasHostTestId(renderer.root, 'import-status-strip')).toBe(true);
  });

  it('shows while another tab is focused, whatever Settings is sitting on', () => {
    store.setState(RUNNING_STATE);

    const renderer = renderStrip(
      tabState({
        focusedIndex: 0,
        settingsNested: nestedStack(['SettingsMain', 'ImportStatus']),
      }),
    );

    expect(hasHostTestId(renderer.root, 'import-status-strip')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The orbit name
// ---------------------------------------------------------------------------

describe('ImportStatusStrip — the orbit name', () => {
  it('renders the name through EmojiText, never a plain Text', () => {
    store.setState(RUNNING_STATE);

    const renderer = renderStrip();

    const emojiTexts = findEmojiTexts(renderer.root);
    expect(emojiTexts).toHaveLength(1);
    expect(String(emojiTexts[0].props.children)).toContain(ORBIT_NAME);
    // One line, always: the strip's height is fixed so tab screens resize by a
    // known amount.
    expect(emojiTexts[0].props.numberOfLines).toBe(1);
    expect(stripLabel(renderer.root)).toContain(ORBIT_NAME);

    // The name reaches the screen ONLY through that node: every rendered Text
    // carrying it is one of its descendants.
    const carriers = renderer.root.findAll(
      (node) =>
        (node.type as unknown) === 'Text' && String(node.props.children).includes(ORBIT_NAME),
    );
    expect(carriers.length).toBeGreaterThan(0);
    for (const carrier of carriers) {
      expect(emojiTexts[0].findAll((node) => node === carrier)).toHaveLength(1);
    }
  });

  it('shows the line alone when the job is in an orbit this device has no name for', () => {
    store.setState({ ...RUNNING_STATE, conversationId: 'g-left' });

    const renderer = renderStrip();

    expect(stripLabel(renderer.root)).toBe(describeRunProgress(12, 300));
    expect(stripLabel(renderer.root)).not.toContain(ORBIT_NAME);
  });
});

// ---------------------------------------------------------------------------
// The tap
// ---------------------------------------------------------------------------

describe('ImportStatusStrip — the tap', () => {
  it('hands the tab state and navigation to openImportStatus', () => {
    store.setState(RUNNING_STATE);
    const state = tabState({ focusedIndex: 0 });

    const renderer = renderStrip(state);
    act(() => {
      (
        findByTestId(renderer.root, 'import-status-strip').props as { onPress: () => void }
      ).onPress();
    });

    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen).toHaveBeenCalledWith(state, navigation);
  });
});

// ---------------------------------------------------------------------------
// The hook order is the reason the hide is a late return
// ---------------------------------------------------------------------------

describe('ImportStatusStrip — hook order across hide and show', () => {
  it('keeps every hook on the same instance when the focused route becomes an import route', () => {
    store.setState(RUNNING_STATE);

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const renderer = renderStrip(
        tabState({ focusedIndex: 2, settingsNested: nestedStack(['SettingsMain']) }),
      );
      // Positive control: the strip really was on screen first.
      expect(hasHostTestId(renderer.root, 'import-status-strip')).toBe(true);

      // The SAME component instance, now asked to hide.
      act(() => {
        renderer.update(
          stripElement(
            tabState({
              focusedIndex: 2,
              settingsNested: nestedStack(['SettingsMain', 'ImportStatus']),
            }),
          ),
        );
      });
      expect(renderer.toJSON()).toBeNull();

      // …and back again, which is the direction that would throw "rendered
      // more hooks than during the previous render".
      act(() => {
        renderer.update(
          stripElement(
            tabState({ focusedIndex: 2, settingsNested: nestedStack(['SettingsMain']) }),
          ),
        );
      });
      expect(hasHostTestId(renderer.root, 'import-status-strip')).toBe(true);

      const hookWarnings = consoleErrorSpy.mock.calls.filter((call) =>
        /hook/i.test(String(call[0])),
      );
      expect(hookWarnings).toEqual([]);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
