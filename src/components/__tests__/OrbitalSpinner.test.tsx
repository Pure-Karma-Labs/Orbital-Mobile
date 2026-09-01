/**
 * Coverage for the *real* OrbitalSpinner.
 *
 * Every other suite gets the global mock from jest.setup.ts (#731), so this is
 * the only file where the real component runs. The lifecycle test below pins
 * the invariant that made the mock necessary: the recursive rotation chain must
 * stop when the component unmounts.
 */
jest.unmock('../OrbitalSpinner');

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { OrbitalSpinner } from '../OrbitalSpinner';
import { ThemeProvider } from '../../theme';

function render(size?: number): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        ThemeProvider,
        { colorSchemeOverride: 'light' },
        React.createElement(OrbitalSpinner, size == null ? {} : { size }),
      ),
    );
  });
  return renderer;
}

describe('OrbitalSpinner — render', () => {
  it('renders three coloured dots inside the rotating container', () => {
    const renderer = render();
    // Animated.View wrapper + one View per dot.
    const views = renderer.root.findAllByType('View' as never);
    expect(views.length).toBeGreaterThanOrEqual(3);
    act(() => renderer.unmount());
  });

  it('scales dot geometry from the size prop', () => {
    const small = render(24);
    const large = render(48);
    const dotOf = (r: ReactTestRenderer): number => {
      const dots = r.root
        .findAllByType('View' as never)
        .map((n) => n.props.style)
        .filter((s): s is { width: number } => !!s && typeof s.width === 'number' && s.position === 'absolute');
      return dots[0].width;
    };
    expect(dotOf(large)).toBeGreaterThan(dotOf(small));
    act(() => {
      small.unmount();
      large.unmount();
    });
  });
});

describe('OrbitalSpinner — animation lifecycle (#731)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps rescheduling the rotation while mounted', () => {
    const renderer = render();
    // RN's native-animation mock re-arms via setTimeout(..., 16); the chain
    // should still have work queued after several frames.
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    act(() => {
      jest.advanceTimersByTime(16 * 5);
    });
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('stops rescheduling once unmounted — the chain must not outlive the component', () => {
    const renderer = render();
    act(() => {
      jest.advanceTimersByTime(16 * 3);
    });

    act(() => renderer.unmount());

    // Drain whatever was already queued at unmount time. `alive.current` is now
    // false, so the callback must not re-arm. If this regresses, the chain
    // leaks into later tests — the cascade and CI hang behind #731.
    act(() => {
      jest.advanceTimersByTime(16 * 10);
    });
    expect(jest.getTimerCount()).toBe(0);
  });
});
