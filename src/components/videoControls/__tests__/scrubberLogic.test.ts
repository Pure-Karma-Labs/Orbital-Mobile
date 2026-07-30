/**
 * Tests for the pure scrubber maths + chrome visibility state machine (#662).
 *
 * This module carries all the logic the component layer deliberately does not,
 * because the repo's inline gesture-handler mock swallows real gestures — so
 * this file is where scrubbing correctness is actually proven.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  AUTO_HIDE_MS,
  clampSeconds,
  fractionOfDuration,
  INITIAL_VISIBILITY,
  nextVisibility,
  offsetToSeconds,
  PROGRESS_INTERVAL_MS,
  shouldArmAutoHide,
  type VisibilityEvent,
  type VisibilityState,
} from '../scrubberLogic';
import { useControlsVisibility } from '../useControlsVisibility';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('auto-hides after 3s and polls progress 10x/second', () => {
    expect(AUTO_HIDE_MS).toBe(3000);
    expect(PROGRESS_INTERVAL_MS).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// clampSeconds
// ---------------------------------------------------------------------------

describe('clampSeconds', () => {
  it('passes an in-range value through untouched', () => {
    expect(clampSeconds(12.5, 42)).toBe(12.5);
  });

  it('clamps past the end to the duration', () => {
    expect(clampSeconds(999, 42)).toBe(42);
  });

  it('clamps negatives to zero', () => {
    expect(clampSeconds(-5, 42)).toBe(0);
  });

  it('returns 0 when the duration is unknown', () => {
    // onLoad has not landed yet — seeking anywhere but 0 would be a guess.
    expect(clampSeconds(10, 0)).toBe(0);
    expect(clampSeconds(10, -1)).toBe(0);
    expect(clampSeconds(10, NaN)).toBe(0);
    expect(clampSeconds(10, Infinity)).toBe(0);
  });

  it('returns 0 for a non-finite seconds value', () => {
    expect(clampSeconds(NaN, 42)).toBe(0);
    expect(clampSeconds(-Infinity, 42)).toBe(0);
  });

  it('accepts exactly the duration', () => {
    expect(clampSeconds(42, 42)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// offsetToSeconds
// ---------------------------------------------------------------------------

describe('offsetToSeconds', () => {
  it('maps track offsets linearly onto the duration', () => {
    expect(offsetToSeconds(0, 200, 40)).toBe(0);
    expect(offsetToSeconds(50, 200, 40)).toBe(10);
    expect(offsetToSeconds(100, 200, 40)).toBe(20);
    expect(offsetToSeconds(200, 200, 40)).toBe(40);
  });

  it('keeps sub-second precision', () => {
    expect(offsetToSeconds(1, 200, 40)).toBeCloseTo(0.2, 10);
    expect(offsetToSeconds(133, 200, 40)).toBeCloseTo(26.6, 10);
  });

  it('clamps a drag past the left edge to 0:00', () => {
    expect(offsetToSeconds(-40, 200, 40)).toBe(0);
  });

  it('clamps a drag past the right edge to the duration', () => {
    expect(offsetToSeconds(400, 200, 40)).toBe(40);
  });

  it('returns 0 before the track has been laid out', () => {
    expect(offsetToSeconds(50, 0, 40)).toBe(0);
    expect(offsetToSeconds(50, -10, 40)).toBe(0);
    expect(offsetToSeconds(50, NaN, 40)).toBe(0);
  });

  it('returns 0 when the duration is unknown', () => {
    expect(offsetToSeconds(50, 200, 0)).toBe(0);
    expect(offsetToSeconds(50, 200, NaN)).toBe(0);
  });

  it('returns 0 for a non-finite offset', () => {
    expect(offsetToSeconds(NaN, 200, 40)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fractionOfDuration
// ---------------------------------------------------------------------------

describe('fractionOfDuration', () => {
  it('reports the played fraction', () => {
    expect(fractionOfDuration(10, 40)).toBe(0.25);
    expect(fractionOfDuration(40, 40)).toBe(1);
  });

  it('never divides by an unknown duration', () => {
    expect(fractionOfDuration(10, 0)).toBe(0);
    expect(fractionOfDuration(10, NaN)).toBe(0);
    expect(Number.isNaN(fractionOfDuration(10, 0))).toBe(false);
  });

  it('floors at 0 and caps at 1', () => {
    expect(fractionOfDuration(-5, 40)).toBe(0);
    expect(fractionOfDuration(9999, 40)).toBe(1);
  });

  it('treats a non-finite position as unplayed', () => {
    expect(fractionOfDuration(NaN, 40)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// nextVisibility
// ---------------------------------------------------------------------------

describe('nextVisibility', () => {
  const shown: VisibilityState = { visible: true, epoch: 3, scrubbing: false };
  const hidden: VisibilityState = { visible: false, epoch: 3, scrubbing: false };

  it('starts visible and not scrubbing', () => {
    expect(INITIAL_VISIBILITY).toEqual({
      visible: true,
      epoch: 0,
      scrubbing: false,
    });
  });

  it.each<VisibilityEvent>(['play', 'pause', 'scrubStart', 'scrubEnd', 'ended'])(
    '%s always resolves to visible with a re-armed countdown',
    (event) => {
      expect(nextVisibility(hidden, event)).toMatchObject({
        visible: true,
        epoch: 4,
      });
      expect(nextVisibility(shown, event)).toMatchObject({
        visible: true,
        epoch: 4,
      });
    },
  );

  it('scrubStart raises the scrubbing flag and scrubEnd lowers it', () => {
    const dragging = nextVisibility(shown, 'scrubStart');
    expect(dragging.scrubbing).toBe(true);
    expect(nextVisibility(dragging, 'scrubEnd').scrubbing).toBe(false);
  });

  it('carries the scrubbing flag through unrelated events', () => {
    // A drag can outlive a timerFired that was already in flight; losing the
    // flag there would let the next epoch bump re-arm mid-drag.
    const dragging: VisibilityState = { visible: true, epoch: 3, scrubbing: true };
    expect(nextVisibility(dragging, 'timerFired').scrubbing).toBe(true);
    expect(nextVisibility(dragging, 'play').scrubbing).toBe(true);
    expect(nextVisibility(dragging, 'pause').scrubbing).toBe(true);
    expect(nextVisibility(dragging, 'ended').scrubbing).toBe(true);

    const hiddenDragging: VisibilityState = {
      visible: false,
      epoch: 3,
      scrubbing: true,
    };
    expect(nextVisibility(hiddenDragging, 'tap').scrubbing).toBe(true);
  });

  it('tap only transitions hidden -> visible', () => {
    expect(nextVisibility(hidden, 'tap')).toMatchObject({
      visible: true,
      epoch: 4,
    });
  });

  it('tap while visible is a no-op — there is no tap-to-hide', () => {
    // The full-page detector is unmounted while the chrome is up, so this
    // branch only exists to guarantee the button can never be hidden by the
    // ancestor tap that a press might also satisfy (#518).
    expect(nextVisibility(shown, 'tap')).toBe(shown);
  });

  it('timerFired hides, and is idempotent once hidden', () => {
    expect(nextVisibility(shown, 'timerFired')).toMatchObject({
      visible: false,
      epoch: 3,
    });
    expect(nextVisibility(hidden, 'timerFired')).toBe(hidden);
  });

  it('returns the same object reference on no-op transitions', () => {
    // Identity is the useReducer bail-out signal — a fresh object would
    // re-render the overlay on every swallowed tap.
    expect(nextVisibility(shown, 'tap')).toBe(shown);
    expect(nextVisibility(hidden, 'timerFired')).toBe(hidden);
  });

  it('ignores an unknown event', () => {
    expect(nextVisibility(shown, 'nonsense' as VisibilityEvent)).toBe(shown);
  });
});

// ---------------------------------------------------------------------------
// shouldArmAutoHide
// ---------------------------------------------------------------------------

describe('shouldArmAutoHide', () => {
  it('arms only while visible AND playing', () => {
    expect(shouldArmAutoHide(true, true)).toBe(true);
    expect(shouldArmAutoHide(true, false)).toBe(false);
    expect(shouldArmAutoHide(false, true)).toBe(false);
    expect(shouldArmAutoHide(false, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useControlsVisibility — driven through a probe component
// ---------------------------------------------------------------------------

interface Probe {
  visible: boolean;
  notify: (event: VisibilityEvent) => void;
}

function makeProbe(): {
  render: (playing: boolean) => React.JSX.Element;
  read: () => Probe;
} {
  let latest: Probe = { visible: true, notify: () => {} };

  function ProbeComponent({ playing }: { playing: boolean }): null {
    latest = useControlsVisibility(playing);
    return null;
  }

  return {
    render: (playing: boolean) =>
      React.createElement(ProbeComponent, { playing }),
    read: () => latest,
  };
}

describe('useControlsVisibility', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    if (renderer) {
      const r = renderer;
      renderer = null;
      act(() => {
        r.unmount();
      });
    }
    jest.useRealTimers();
  });

  it('starts visible and hides 3s into playback', () => {
    const probe = makeProbe();
    act(() => {
      renderer = create(probe.render(true));
    });
    expect(probe.read().visible).toBe(true);

    act(() => {
      jest.advanceTimersByTime(AUTO_HIDE_MS - 1);
    });
    expect(probe.read().visible).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(probe.read().visible).toBe(false);
  });

  it('never hides while paused', () => {
    const probe = makeProbe();
    act(() => {
      renderer = create(probe.render(false));
    });

    act(() => {
      jest.advanceTimersByTime(AUTO_HIDE_MS * 5);
    });
    expect(probe.read().visible).toBe(true);
  });

  it('restarts the countdown on an interaction that does not change visibility', () => {
    const probe = makeProbe();
    act(() => {
      renderer = create(probe.render(true));
    });

    act(() => {
      jest.advanceTimersByTime(AUTO_HIDE_MS - 100);
    });
    expect(probe.read().visible).toBe(true);

    // Still visible, but the epoch bump must re-arm from zero.
    act(() => {
      probe.read().notify('scrubEnd');
    });
    act(() => {
      jest.advanceTimersByTime(AUTO_HIDE_MS - 100);
    });
    expect(probe.read().visible).toBe(true);

    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(probe.read().visible).toBe(false);
  });

  it('brings the chrome back on tap and hides it again after 3s', () => {
    const probe = makeProbe();
    act(() => {
      renderer = create(probe.render(true));
    });
    act(() => {
      jest.advanceTimersByTime(AUTO_HIDE_MS);
    });
    expect(probe.read().visible).toBe(false);

    act(() => {
      probe.read().notify('tap');
    });
    expect(probe.read().visible).toBe(true);

    act(() => {
      jest.advanceTimersByTime(AUTO_HIDE_MS);
    });
    expect(probe.read().visible).toBe(false);
  });

  it('never hides mid-drag, however long the drag lasts', () => {
    const probe = makeProbe();
    act(() => {
      renderer = create(probe.render(true));
    });

    act(() => {
      probe.read().notify('scrubStart');
    });

    // A deliberate, slow scrub through a long video — far past AUTO_HIDE_MS.
    act(() => {
      jest.advanceTimersByTime(AUTO_HIDE_MS * 4);
    });
    expect(probe.read().visible).toBe(true);

    // Release re-arms from the release, not from the start of the drag.
    act(() => {
      probe.read().notify('scrubEnd');
    });
    act(() => {
      jest.advanceTimersByTime(AUTO_HIDE_MS - 1);
    });
    expect(probe.read().visible).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(probe.read().visible).toBe(false);
  });

  it('keeps the chrome up after playback ends', () => {
    const probe = makeProbe();
    act(() => {
      renderer = create(probe.render(true));
    });
    act(() => {
      jest.advanceTimersByTime(AUTO_HIDE_MS);
    });
    expect(probe.read().visible).toBe(false);

    // onEnd: show the replay affordance, and stop playing.
    act(() => {
      probe.read().notify('ended');
    });
    act(() => {
      renderer!.update(probe.render(false));
    });
    act(() => {
      jest.advanceTimersByTime(AUTO_HIDE_MS * 3);
    });
    expect(probe.read().visible).toBe(true);
  });

  it('leaves no timer pending after unmount', () => {
    const probe = makeProbe();
    act(() => {
      renderer = create(probe.render(true));
    });
    const r = renderer!;
    renderer = null;
    act(() => {
      r.unmount();
    });

    expect(jest.getTimerCount()).toBe(0);
  });
});
