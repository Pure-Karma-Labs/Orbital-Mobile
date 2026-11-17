/**
 * The how-to screen and the file pick (#928 §3.2, §4.1).
 *
 * ## What this suite pins
 *
 * 1. **`Linking.openURL`, never a WebView.** Hosting a Meta login inside
 *    Orbital is exactly what the intro copy promises we do not do, so the
 *    absence is asserted twice: on the rendered tree, and on the module source.
 * 2. **Every `pickAndStartParse` arm.** One test per arm — a new arm that
 *    nobody handled would leave the member on a screen that did nothing.
 * 3. **`resumeImportAtLaunch` runs BEFORE the replace** on a refusal in the
 *    same orbit: the status screen it replaces into reads the store, and
 *    navigating first would show `none` for a job that exists.
 * 4. **The orbit comes from the ROUTE**, never from `activeConversationId` —
 *    the member can switch the active orbit from another tab mid-flow.
 *
 * The runner is mocked EXCEPT for its store, which is a real `zustand/vanilla`
 * store the tests write to in order to drive the parsing phase
 * (`FileLibraryScreen.test.tsx:194-218`).
 */

import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { Alert, Linking, type AlertButton } from 'react-native';
import { ThemeProvider } from '../../../theme';
import {
  bannerMessage,
  findByTestId,
  findHostByTestId,
  hasHostTestId,
} from '../../../testUtils/rtr';
import { ImportHowToScreen } from '../ImportHowToScreen';
import {
  ACCOUNTS_CENTER_URL,
  PICK_FAILURE_COPY,
  describeHowToIntro,
  describeIntoCaption,
} from '../importCopy';

import type { ImportPreflight, ImportRunnerState } from '../../../services/metaImport/importRunner';
import type { PickFailureReason, PickParseResult } from '../../../services/metaImport/importRunner';
import type { SkipReason } from '../../../services/metaImport/types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockReplace = jest.fn();
const mockGoBack = jest.fn();
const mockNavigate = jest.fn();

/** Mutable so one test can point the screen at a different orbit. */
const mockRouteParams: { source: 'facebook' | 'instagram'; conversationId: string } = {
  source: 'facebook',
  conversationId: 'g1',
};

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    replace: mockReplace,
    goBack: mockGoBack,
    navigate: mockNavigate,
  }),
  useRoute: () => ({ params: mockRouteParams }),
  // See ImportSettingsSection.test.tsx — without this the availability probe
  // never runs and the allowance line never appears.
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    const ReactModule = require('react');
    ReactModule.useEffect(effect, [effect]);
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  return {
    SafeAreaView: ({ children, ...props }: { children: unknown }) =>
      ReactModule.createElement('View', props, children),
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
  };
});

interface FakeConversation {
  id: string;
  name: string;
  type: string;
}

interface FakeAppState {
  activeConversationId: string | null;
  conversations: Record<string, FakeConversation>;
}

const mockAppState: FakeAppState = { activeConversationId: 'g1', conversations: {} };

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
    probeImportAvailability: jest.fn(),
    pickAndStartParse: jest.fn(),
    cancelImport: jest.fn(),
    resumeImportAtLaunch: jest.fn(),
  };
});

import {
  cancelImport,
  importStore,
  pickAndStartParse,
  probeImportAvailability,
  resumeImportAtLaunch,
} from '../../../services/metaImport/importRunner';

const mockProbe = probeImportAvailability as jest.Mock;
const mockPick = pickAndStartParse as jest.Mock;
const mockCancel = cancelImport as jest.Mock;
const mockResume = resumeImportAtLaunch as jest.Mock;

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

const PREFLIGHT: ImportPreflight = {
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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const mountedRenderers: ReactTestRenderer[] = [];

async function renderScreen(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(ImportHowToScreen, null),
      ),
    );
  });
  mountedRenderers.push(renderer);
  return renderer;
}

function tap(root: ReactTestInstance, testID: string): void {
  act(() => {
    (findByTestId(root, testID).props as { onPress: () => void }).onPress();
  });
}

/** Taps and flushes the pick's async tail (`setError` / `replace` / Alert). */
async function tapAndSettle(root: ReactTestInstance, testID: string): Promise<void> {
  await act(async () => {
    (findByTestId(root, testID).props as { onPress: () => void }).onPress();
  });
}

let openURLSpy: jest.SpyInstance;
let alertSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteParams.source = 'facebook';
  mockRouteParams.conversationId = 'g1';
  mockAppState.activeConversationId = 'g1';
  mockAppState.conversations = {
    g1: { id: 'g1', name: 'Route Orbit', type: 'group' },
    g2: { id: 'g2', name: 'Other Orbit', type: 'group' },
  };
  importStore.setState({ ...BASE_STATE }, true);
  mockProbe.mockResolvedValue({ available: true, allowance: ALLOWANCE, limits: LIMITS });
  mockResume.mockResolvedValue(undefined);
  openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as unknown as boolean);
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => {
  while (mountedRenderers.length > 0) {
    const renderer = mountedRenderers.pop();
    act(() => {
      renderer?.unmount();
    });
  }
  openURLSpy.mockRestore();
  alertSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Accounts Center: a system-browser link, never a WebView
// ---------------------------------------------------------------------------

describe('ImportHowToScreen — Accounts Center link', () => {
  it('hands the URL to the system browser exactly once', async () => {
    const renderer = await renderScreen();

    tap(renderer.root, 'import-accounts-center-link');

    expect(openURLSpy).toHaveBeenCalledTimes(1);
    const url = String(openURLSpy.mock.calls[0][0]);
    expect(url).toBe(ACCOUNTS_CENTER_URL.facebook);
    expect(url.startsWith('https://accountscenter.')).toBe(true);
  });

  it('uses the Instagram Accounts Center URL for an Instagram import', async () => {
    mockRouteParams.source = 'instagram';
    const renderer = await renderScreen();

    tap(renderer.root, 'import-accounts-center-link');

    expect(String(openURLSpy.mock.calls[0][0])).toBe(ACCOUNTS_CENTER_URL.instagram);
  });

  it('renders no WebView anywhere in the tree', async () => {
    const renderer = await renderScreen();

    const webViews = renderer.root.findAll((node) => {
      const type: unknown = node.type;
      const name =
        typeof type === 'string'
          ? type
          : ((type as { displayName?: string; name?: string } | null)?.displayName ??
            (type as { name?: string } | null)?.name ??
            '');
      return /webview/i.test(String(name));
    });

    expect(webViews).toHaveLength(0);
    // Positive control: the walk really did see this screen's tree.
    expect(hasHostTestId(renderer.root, 'import-how-to-screen')).toBe(true);
  });

  it('imports no webview package in its module source', () => {
    const fs = require('fs');
    const path = require('path');
    const source: string = fs.readFileSync(
      path.join(__dirname, '..', 'ImportHowToScreen.tsx'),
      'utf8',
    );

    // The doc comment names WebView on purpose ("never a WebView"), so the
    // assertion is about IMPORTS, not about the word.
    expect(source).not.toMatch(/from\s+['"][^'"]*webview[^'"]*['"]/i);
    expect(source).not.toMatch(/require\(\s*['"][^'"]*webview[^'"]*['"]\s*\)/i);
    // Positive control: the file really was read.
    expect(source).toContain('ACCOUNTS_CENTER_URL');
  });
});

// ---------------------------------------------------------------------------
// Every pickAndStartParse arm (§3.2)
// ---------------------------------------------------------------------------

describe('ImportHowToScreen — pick results', () => {
  it('preflight → replaces into ImportStatus', async () => {
    const result: PickParseResult = { kind: 'preflight', preflight: PREFLIGHT };
    mockPick.mockResolvedValue(result);

    const renderer = await renderScreen();
    await tapAndSettle(renderer.root, 'import-choose-files');

    expect(mockPick).toHaveBeenCalledWith({ conversationId: 'g1', source: 'facebook' });
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('ImportStatus');
  });

  it('cancelled → stays put, with no error banner', async () => {
    const result: PickParseResult = { kind: 'cancelled' };
    mockPick.mockResolvedValue(result);

    const renderer = await renderScreen();
    await tapAndSettle(renderer.root, 'import-choose-files');

    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(bannerMessage(renderer.root, 'import-how-to-error')).toBeUndefined();
    // Positive control: the member is still on the how-to body.
    expect(hasHostTestId(renderer.root, 'import-choose-files')).toBe(true);
  });

  const failureReasons: readonly PickFailureReason[] = [
    'archive',
    'key_pending',
    'network',
    'other',
  ];

  it.each(failureReasons)('failed(%s) → shows that reason’s copy', async (reason) => {
    const result: PickParseResult = { kind: 'failed', reason };
    mockPick.mockResolvedValue(result);

    const renderer = await renderScreen();
    await tapAndSettle(renderer.root, 'import-choose-files');

    expect(bannerMessage(renderer.root, 'import-how-to-error')).toBe(PICK_FAILURE_COPY[reason]);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('refused in the SAME orbit → re-hydrates BEFORE replacing', async () => {
    const result: PickParseResult = {
      kind: 'refused',
      reason: 'job-running',
      conversationId: 'g1',
    };
    mockPick.mockResolvedValue(result);

    const renderer = await renderScreen();
    await tapAndSettle(renderer.root, 'import-choose-files');

    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('ImportStatus');
    expect(alertSpy).not.toHaveBeenCalled();
    // The order is the point: ImportStatus reads the store it re-hydrates.
    expect(mockResume.mock.invocationCallOrder[0]).toBeLessThan(
      mockReplace.mock.invocationCallOrder[0],
    );
  });

  it('refused in ANOTHER orbit → alerts, naming that orbit, and View replaces', async () => {
    const result: PickParseResult = {
      kind: 'refused',
      reason: 'job-running',
      conversationId: 'g2',
    };
    mockPick.mockResolvedValue(result);

    const renderer = await renderScreen();
    await tapAndSettle(renderer.root, 'import-choose-files');

    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();

    const [, message, buttons] = alertSpy.mock.calls[0] as [string, string, AlertButton[]];
    expect(message).toContain('Other Orbit');

    const view = buttons.find((button) => button.text === 'View');
    expect(view).toBeDefined();
    act(() => {
      view?.onPress?.();
    });
    expect(mockReplace).toHaveBeenCalledWith('ImportStatus');
  });

  it('names "an orbit you\'ve left" when the other orbit is gone', async () => {
    mockAppState.conversations = { g1: { id: 'g1', name: 'Route Orbit', type: 'group' } };
    const result: PickParseResult = {
      kind: 'refused',
      reason: 'job-running',
      conversationId: 'g2',
    };
    mockPick.mockResolvedValue(result);

    const renderer = await renderScreen();
    await tapAndSettle(renderer.root, 'import-choose-files');

    const [, message] = alertSpy.mock.calls[0] as [string, string, AlertButton[]];
    expect(message).toContain("an orbit you've left");
  });

  it('a double tap starts exactly one pick', async () => {
    let settle!: (result: PickParseResult) => void;
    mockPick.mockReturnValue(
      new Promise<PickParseResult>((resolve) => {
        settle = resolve;
      }),
    );

    const renderer = await renderScreen();
    const button = findByTestId(renderer.root, 'import-choose-files').props as {
      onPress: () => void;
    };

    act(() => {
      button.onPress();
      button.onPress();
    });

    expect(mockPick).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle({ kind: 'cancelled' });
    });
    expect(mockPick).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The parse is rendered INLINE
// ---------------------------------------------------------------------------

describe('ImportHowToScreen — the inline parse view', () => {
  it('replaces the how-to body while the phase is parsing', async () => {
    importStore.setState({ phase: 'parsing', jobId: 'job-1', conversationId: 'g1' });

    const renderer = await renderScreen();

    expect(hasHostTestId(renderer.root, 'import-parse-view')).toBe(true);
    expect(hasHostTestId(renderer.root, 'import-choose-files')).toBe(false);
    expect(hasHostTestId(renderer.root, 'import-how-to-orbit')).toBe(false);
    expect(hasHostTestId(renderer.root, 'import-accounts-center-link')).toBe(false);
  });

  it('cancels the parse from the inline view', async () => {
    importStore.setState({ phase: 'parsing', jobId: 'job-1', conversationId: 'g1' });

    const renderer = await renderScreen();
    tap(renderer.root, 'import-parse-cancel');

    expect(mockCancel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The orbit comes from the route param
// ---------------------------------------------------------------------------

describe('ImportHowToScreen — the orbit comes from the route', () => {
  /**
   * The intro INTERPOLATES the orbit name, so it is a display site for
   * user-generated content: a name with an emoji in it must render OpenMoji
   * like every other surface, not the system glyph a plain `<Text>` would
   * give it.
   */
  it('renders the intro through EmojiText, name and all', async () => {
    mockRouteParams.conversationId = 'g1';

    const renderer = await renderScreen();
    const introNodes = renderer.root.findAll(
      (node) => node.props?.testID === 'import-how-to-intro',
    );
    expect(introNodes.length).toBeGreaterThan(0);

    // The component node, which is EmojiText's inner render (react-test-renderer
    // renders through the memo wrapper), not a bare host Text.
    const owner = introNodes.find((node) => typeof node.type === 'function');
    expect(owner).toBeDefined();
    expect(String(owner?.props.children)).toBe(describeHowToIntro('facebook', 'Route Orbit'));

    // And the rendered text really is the intro, carrying the orbit name.
    const host = findHostByTestId(renderer.root, 'import-how-to-intro');
    expect(String(host.props.children)).toContain('Route Orbit');
  });

  it('names the route’s orbit, not the active one', async () => {
    mockRouteParams.conversationId = 'g1';
    mockAppState.activeConversationId = 'g2';

    const renderer = await renderScreen();
    const caption = String(findHostByTestId(renderer.root, 'import-how-to-orbit').props.children);

    expect(caption).toBe(describeIntoCaption('Route Orbit'));
    expect(caption).not.toContain('Other Orbit');
    // …and the probe asked about the ROUTE's orbit too.
    expect(mockProbe).toHaveBeenCalledWith('g1');
  });

  it('picks into the route’s orbit even when the active orbit differs', async () => {
    mockRouteParams.conversationId = 'g1';
    mockAppState.activeConversationId = 'g2';
    const result: PickParseResult = { kind: 'cancelled' };
    mockPick.mockResolvedValue(result);

    const renderer = await renderScreen();
    await tapAndSettle(renderer.root, 'import-choose-files');

    expect(mockPick).toHaveBeenCalledWith({ conversationId: 'g1', source: 'facebook' });
  });
});
