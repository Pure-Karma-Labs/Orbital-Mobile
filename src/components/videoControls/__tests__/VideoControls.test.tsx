/**
 * Wiring tests for the custom video overlay (#662).
 *
 * The inline gesture-handler mock swallows real pans and taps, so this file
 * deliberately proves only what a component test CAN prove: what renders, what
 * the pressables call, and how the hidden state is expressed. The scrubbing
 * maths and the visibility state machine are covered directly in
 * scrubberLogic.test.ts.
 */

import React from 'react';
import { Animated } from 'react-native';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { ThemeProvider } from '../../../theme';
import { VideoControls, type VideoControlsProps } from '../VideoControls';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));

/**
 * Chainable gesture stubs — every builder method returns the same object, so
 * the real call chains in VideoControls type- and run-through unchanged. The
 * callbacks are captured but never invoked by RNGH here; tests that need to
 * exercise them call them directly.
 */
jest.mock('react-native-gesture-handler', () => {
  const makeStub = () => {
    const stub: Record<string, unknown> = {};
    const methods = [
      'onEnd',
      'onBegin',
      'onStart',
      'onUpdate',
      'onFinalize',
      'runOnJS',
      'activeOffsetX',
      'failOffsetY',
      'blocksExternalGesture',
      'simultaneousWithExternalGesture',
    ];
    for (const m of methods) {
      stub[m] = jest.fn(() => stub);
    }
    return stub;
  };
  return {
    Gesture: { Tap: () => makeStub(), Pan: () => makeStub(), Native: () => makeStub() },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let mounted: ReactTestRenderer | null = null;

const BASE_PROPS: VideoControlsProps = {
  paused: false,
  currentTime: 0,
  duration: 0,
  visible: true,
  onTogglePlay: jest.fn(),
  onSeek: jest.fn(),
  onInteraction: jest.fn(),
};

function render(overrides: Partial<VideoControlsProps> = {}): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(VideoControls, { ...BASE_PROPS, ...overrides }),
      ),
    );
  });
  mounted = renderer;
  return renderer;
}

/** Host nodes only — composites carry the same testID and would double-count. */
function byTestId(root: ReactTestInstance, testID: string): ReactTestInstance[] {
  return root.findAll(
    (n) => typeof n.type === 'string' && n.props.testID === testID,
  );
}

function pressableByTestId(
  root: ReactTestInstance,
  testID: string,
): ReactTestInstance {
  return root.findAll(
    (n) => n.props.testID === testID && typeof n.props.onPress === 'function',
  )[0];
}

function textOf(root: ReactTestInstance, testID: string): string {
  const node = byTestId(root, testID)[0];
  return String(node.children[0]);
}

/**
 * Every rendered Text child. The cast mirrors LightboxVideoPage.test.tsx:
 * ReactTestInstance['type'] is ElementType, which excludes RN's host tags.
 */
function textContents(root: ReactTestInstance): unknown[] {
  return root
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => n.children[0]);
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  if (mounted) {
    const renderer = mounted;
    mounted = null;
    act(() => {
      renderer.unmount();
    });
  }
});

// ---------------------------------------------------------------------------
// 1. Transport button
// ---------------------------------------------------------------------------

describe('play/pause button', () => {
  it('shows the pause glyph while playing', () => {
    const renderer = render({ paused: false });
    expect(byTestId(renderer.root, 'video-controls-toggle-play')[0]).toBeDefined();
    const glyphs = textContents(renderer.root);
    expect(glyphs).toContain('❚❚');
    expect(glyphs).not.toContain('▶');
  });

  it('shows the play glyph while paused', () => {
    const renderer = render({ paused: true });
    const glyphs = textContents(renderer.root);
    expect(glyphs).toContain('▶');
    expect(glyphs).not.toContain('❚❚');
  });

  it('calls onTogglePlay exactly once per press', () => {
    const onTogglePlay = jest.fn();
    const renderer = render({ onTogglePlay });

    act(() => {
      pressableByTestId(renderer.root, 'video-controls-toggle-play').props.onPress();
    });

    expect(onTogglePlay).toHaveBeenCalledTimes(1);
  });

  it('labels itself for screen readers by transport state', () => {
    const renderer = render({ paused: false });
    const button = pressableByTestId(renderer.root, 'video-controls-toggle-play');
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe('Pause video');

    act(() => {
      renderer.update(
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(VideoControls, { ...BASE_PROPS, paused: true }),
        ),
      );
    });

    expect(
      pressableByTestId(renderer.root, 'video-controls-toggle-play').props
        .accessibilityLabel,
    ).toBe('Play video');
  });
});

// ---------------------------------------------------------------------------
// 2. Time readouts
// ---------------------------------------------------------------------------

describe('time readouts', () => {
  it('renders elapsed and total time via formatDurationSeconds', () => {
    const renderer = render({ currentTime: 65, duration: 3700 });
    expect(textOf(renderer.root, 'video-controls-current-time')).toBe('1:05');
    expect(textOf(renderer.root, 'video-controls-duration')).toBe('1:01:40');
  });

  it('renders 0:00 before onLoad reports a duration', () => {
    const renderer = render({ currentTime: 0, duration: 0 });
    expect(textOf(renderer.root, 'video-controls-current-time')).toBe('0:00');
    expect(textOf(renderer.root, 'video-controls-duration')).toBe('0:00');
  });
});

// ---------------------------------------------------------------------------
// 3. Track
// ---------------------------------------------------------------------------

describe('scrubber track', () => {
  it('renders the track with an adjustable a11y role', () => {
    const renderer = render();
    const track = renderer.root.findAll(
      (n) => n.props.testID === 'video-controls-track',
    )[0];
    expect(track.props.accessibilityRole).toBe('adjustable');
    expect(track.props.accessibilityLabel).toBe('Video position');
    expect(typeof track.props.onLayout).toBe('function');
  });

  it('fills the track proportionally once it has been laid out', () => {
    const renderer = render({ currentTime: 10, duration: 40 });

    act(() => {
      byTestId(renderer.root, 'video-controls-track')[0].props.onLayout({
        nativeEvent: { layout: { width: 200, height: 28, x: 0, y: 0 } },
      });
    });

    // 10/40 of a 200pt track.
    const filled = renderer.root.findAll(
      (n) =>
        typeof n.type === 'string' &&
        typeof n.props.style?.width === 'number' &&
        n.props.style?.backgroundColor === '#FFFFFF',
    );
    expect(filled.some((n) => n.props.style.width === 50)).toBe(true);
  });

  it('renders an empty bar rather than NaN before layout', () => {
    const renderer = render({ currentTime: 10, duration: 40 });
    const filled = renderer.root.findAll(
      (n) =>
        typeof n.type === 'string' &&
        n.props.style?.backgroundColor === '#FFFFFF' &&
        typeof n.props.style?.width === 'number',
    );
    expect(filled.every((n) => n.props.style.width === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Hidden state
// ---------------------------------------------------------------------------

describe('hidden state', () => {
  it('renders no full-page tap layer while the chrome is visible', () => {
    // #518: an ancestor tap competing with the button is the bug this avoids.
    const renderer = render({ visible: true });
    expect(byTestId(renderer.root, 'video-controls-tap-layer').length).toBe(0);
    expect(byTestId(renderer.root, 'video-controls-chrome')[0].props.pointerEvents).toBe(
      'box-none',
    );
  });

  it('mounts the tap layer and stops the chrome taking touches while hidden', () => {
    const renderer = render({ visible: false });
    expect(byTestId(renderer.root, 'video-controls-tap-layer').length).toBe(1);
    expect(byTestId(renderer.root, 'video-controls-chrome')[0].props.pointerEvents).toBe(
      'none',
    );
  });

  it('animates opacity toward 0 when hidden and 1 when shown', () => {
    const timing = jest.spyOn(Animated, 'timing');

    const renderer = render({ visible: true });
    expect(timing.mock.calls.at(-1)?.[1].toValue).toBe(1);

    act(() => {
      renderer.update(
        React.createElement(
          ThemeProvider,
          { colorSchemeOverride: 'light' },
          React.createElement(VideoControls, { ...BASE_PROPS, visible: false }),
        ),
      );
    });
    expect(timing.mock.calls.at(-1)?.[1].toValue).toBe(0);

    timing.mockRestore();
  });

  it('lets touches through the container so the player is not blanketed', () => {
    const renderer = render();
    expect(byTestId(renderer.root, 'video-controls')[0].props.pointerEvents).toBe(
      'box-none',
    );
  });
});
