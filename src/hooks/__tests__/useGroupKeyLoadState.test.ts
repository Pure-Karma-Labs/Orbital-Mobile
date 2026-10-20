/**
 * Tests for useGroupKeyLoadState — the group-key read-surface state pair and
 * its error routing (#912 / #940).
 *
 * Nothing is mocked: `groupKeyErrorCopy` is a pure function over an
 * import-free error module, and the errors are built by NAME exactly as the
 * three screen suites build them (the class itself lives behind the crypto
 * boundary no screen may import).
 *
 * The expected copy is pinned as LITERALS rather than imported from
 * `utils/errorMessages`, so a silent reword of user-facing text fails here.
 *
 * Uses the project's minimal renderHook helper (see useFuseSearch.test.ts) —
 * @testing-library/react-native is not installed. No fake timers.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useGroupKeyLoadState, type GroupKeyLoadState } from '../useGroupKeyLoadState';

// ---------------------------------------------------------------------------
// Copy, pinned as literals
// ---------------------------------------------------------------------------

const RESENDING =
  "This conversation's encryption key is being re-sent by another member. Please try again in a moment.";
const RETRY_LATER =
  "Couldn't recover this conversation's encryption key right now. Please try again in a few minutes.";
const UNREADABLE =
  "This device can't open this conversation's encryption key. Another member needs to open Orbital to re-send it.";
const DEVICE_KEY =
  "This device's encryption keys need to be restored before this conversation can be opened.";

// ---------------------------------------------------------------------------
// Error fixtures
// ---------------------------------------------------------------------------

function pendingWrap(): Error {
  const e = new Error('Group key not yet available (pending wrap)');
  e.name = 'PendingWrapError';
  return e;
}

function unwrapFailure(selfHeal: string): Error {
  const e = new Error(`Group key unwrap failed: recipient_mismatch / ${selfHeal}`);
  e.name = 'GroupKeyUnwrapError';
  (e as unknown as { selfHeal: string }).selfHeal = selfHeal;
  return e;
}

// ---------------------------------------------------------------------------
// Minimal renderHook helper
// ---------------------------------------------------------------------------

interface Harness {
  result: { current: GroupKeyLoadState };
  /** Re-render with a (possibly different) resetKey. */
  rerender: (resetKey?: string | null) => void;
  unmount: () => void;
  /** Render count, for the stable-identity assertions. */
  renders: () => number;
}

function renderHook(initialResetKey?: string | null): Harness {
  const result = { current: undefined as unknown as GroupKeyLoadState };
  let renders = 0;

  function TestComponent({ resetKey }: { resetKey?: string | null }): null {
    renders += 1;
    result.current = useGroupKeyLoadState(resetKey);
    return null;
  }

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(TestComponent, { resetKey: initialResetKey }));
  });

  return {
    result,
    rerender: (resetKey?: string | null) => {
      act(() => {
        renderer.update(React.createElement(TestComponent, { resetKey }));
      });
    },
    unmount: () => {
      act(() => {
        renderer.unmount();
      });
    },
    renders: () => renders,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useGroupKeyLoadState', () => {
  it('starts with neither value set', () => {
    const { result } = renderHook('orbit-1');

    expect(result.current.keyPending).toBe(false);
    expect(result.current.keyFailureMessage).toBeNull();
  });

  // -------------------------------------------------------------------------
  // applyKeyLoadError: the routing table
  // -------------------------------------------------------------------------

  describe('applyKeyLoadError', () => {
    it('routes a pending wrap to the transient banner', () => {
      const hook = renderHook('orbit-1');

      let handled: boolean | undefined;
      act(() => {
        handled = hook.result.current.applyKeyLoadError(pendingWrap());
      });

      expect(handled).toBe(true);
      expect(hook.result.current.keyPending).toBe(true);
      expect(hook.result.current.keyFailureMessage).toBeNull();
    });

    // #937: past the 24h bound the crypto layer stops raising
    // PendingWrapError and raises `stale_pending` instead, which is exactly
    // what must take the "being re-sent" banner back DOWN.
    it('routes stale_pending to the unreadable copy with the banner off', () => {
      const hook = renderHook('orbit-1');

      let handled: boolean | undefined;
      act(() => {
        handled = hook.result.current.applyKeyLoadError(unwrapFailure('stale_pending'));
      });

      expect(handled).toBe(true);
      expect(hook.result.current.keyPending).toBe(false);
      expect(hook.result.current.keyFailureMessage).toBe(UNREADABLE);
    });

    it.each([
      ['refused', UNREADABLE],
      ['exhausted', UNREADABLE],
      ['unsupported', UNREADABLE],
      ['not_eligible', UNREADABLE],
      ['rate_limited', RETRY_LATER],
      ['failed', RETRY_LATER],
      ['cooldown', RETRY_LATER],
      ['session_exhausted', RETRY_LATER],
      ['identity_mismatch', DEVICE_KEY],
      ['blocked_local_key', DEVICE_KEY],
      // An outcome this build has never heard of still lands on the message
      // that is never wrong: it promises nothing and invites no retry.
      ['something_new', UNREADABLE],
    ])('routes the %s outcome to its failure copy', (selfHeal, message) => {
      const hook = renderHook('orbit-1');

      let handled: boolean | undefined;
      act(() => {
        handled = hook.result.current.applyKeyLoadError(unwrapFailure(selfHeal));
      });

      expect(handled).toBe(true);
      expect(hook.result.current.keyPending).toBe(false);
      expect(hook.result.current.keyFailureMessage).toBe(message);
    });

    it('returns false and writes nothing for an error that is not a key failure', () => {
      const hook = renderHook('orbit-1');

      let handled: boolean | undefined;
      act(() => {
        handled = hook.result.current.applyKeyLoadError(new Error('network down'));
      });

      // The boolean is the whole contract for the callers: ThreadDetail falls
      // through to "Could not load thread", the two list screens stay silent.
      expect(handled).toBe(false);
      expect(hook.result.current.keyPending).toBe(false);
      expect(hook.result.current.keyFailureMessage).toBeNull();
    });

    it('returns false for a non-Error value', () => {
      const hook = renderHook('orbit-1');

      let handled: boolean | undefined;
      act(() => {
        handled = hook.result.current.applyKeyLoadError('not an error');
      });

      expect(handled).toBe(false);
      expect(hook.result.current.keyFailureMessage).toBeNull();
    });

    // Only ONE of the two values is ever set, in either direction.
    it('replaces a pending banner with failure copy, and back', () => {
      const hook = renderHook('orbit-1');

      act(() => {
        hook.result.current.applyKeyLoadError(pendingWrap());
      });
      act(() => {
        hook.result.current.applyKeyLoadError(unwrapFailure('refused'));
      });

      expect(hook.result.current.keyPending).toBe(false);
      expect(hook.result.current.keyFailureMessage).toBe(UNREADABLE);

      act(() => {
        hook.result.current.applyKeyLoadError(pendingWrap());
      });

      expect(hook.result.current.keyPending).toBe(true);
      expect(hook.result.current.keyFailureMessage).toBeNull();
    });

    it('leaves an existing verdict alone when the next error is not a key failure', () => {
      const hook = renderHook('orbit-1');

      act(() => {
        hook.result.current.applyKeyLoadError(unwrapFailure('refused'));
      });
      act(() => {
        hook.result.current.applyKeyLoadError(new Error('network down'));
      });

      // A network blip must not claim to be a key problem — nor clear one.
      expect(hook.result.current.keyFailureMessage).toBe(UNREADABLE);
      expect(hook.result.current.keyPending).toBe(false);
    });

    // The pending copy exists, but the pending BRANCH never sets a message:
    // the transient banner carries its own wording.
    it('never sets the re-sending copy as a failure message', () => {
      const hook = renderHook('orbit-1');

      act(() => {
        hook.result.current.applyKeyLoadError(pendingWrap());
      });

      expect(hook.result.current.keyFailureMessage).not.toBe(RESENDING);
    });
  });

  // -------------------------------------------------------------------------
  // clearKeyState
  // -------------------------------------------------------------------------

  describe('clearKeyState', () => {
    it('clears the pending banner', () => {
      const hook = renderHook('orbit-1');

      act(() => {
        hook.result.current.applyKeyLoadError(pendingWrap());
      });
      act(() => {
        hook.result.current.clearKeyState();
      });

      expect(hook.result.current.keyPending).toBe(false);
      expect(hook.result.current.keyFailureMessage).toBeNull();
    });

    it('clears a failure message', () => {
      const hook = renderHook('orbit-1');

      act(() => {
        hook.result.current.applyKeyLoadError(unwrapFailure('identity_mismatch'));
      });
      expect(hook.result.current.keyFailureMessage).toBe(DEVICE_KEY);

      act(() => {
        hook.result.current.clearKeyState();
      });

      expect(hook.result.current.keyFailureMessage).toBeNull();
      expect(hook.result.current.keyPending).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // resetKey
  // -------------------------------------------------------------------------

  describe('resetKey', () => {
    // The screens stay MOUNTED across a switch, so without this, orbit A's
    // verdict sat over orbit B — permanently, if B's own load then failed for
    // a non-key reason, since the values clear only on a success.
    it('clears both values when the key changes', () => {
      const hook = renderHook('orbit-1');

      act(() => {
        hook.result.current.applyKeyLoadError(unwrapFailure('refused'));
      });
      expect(hook.result.current.keyFailureMessage).toBe(UNREADABLE);

      hook.rerender('orbit-2');

      expect(hook.result.current.keyPending).toBe(false);
      expect(hook.result.current.keyFailureMessage).toBeNull();
    });

    it('clears a pending banner when the key changes', () => {
      const hook = renderHook('thread-a');

      act(() => {
        hook.result.current.applyKeyLoadError(pendingWrap());
      });
      expect(hook.result.current.keyPending).toBe(true);

      hook.rerender('thread-b');

      expect(hook.result.current.keyPending).toBe(false);
    });

    // A re-render for any other reason (a heal-generation bump, a store write)
    // must NOT clear: that would flash the create-first empty state on every
    // reload attempt.
    it('keeps the verdict across a re-render with the same key', () => {
      const hook = renderHook('orbit-1');

      act(() => {
        hook.result.current.applyKeyLoadError(unwrapFailure('refused'));
      });
      hook.rerender('orbit-1');
      hook.rerender('orbit-1');

      expect(hook.result.current.keyFailureMessage).toBe(UNREADABLE);
    });

    it('keeps the verdict across re-renders when no key is passed', () => {
      const hook = renderHook();

      act(() => {
        hook.result.current.applyKeyLoadError(pendingWrap());
      });
      hook.rerender();

      expect(hook.result.current.keyPending).toBe(true);
    });

    it('clears when the key goes from an id to null', () => {
      const hook = renderHook('orbit-1');

      act(() => {
        hook.result.current.applyKeyLoadError(pendingWrap());
      });
      hook.rerender(null);

      expect(hook.result.current.keyPending).toBe(false);
      expect(hook.result.current.keyFailureMessage).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Stable callbacks
  // -------------------------------------------------------------------------

  describe('callback identity', () => {
    // The screens list both callbacks in load-effect deps, where a fresh
    // identity per render would re-issue the load on EVERY render.
    it('keeps both callbacks stable across re-renders, state changes and key changes', () => {
      const hook = renderHook('orbit-1');
      const { clearKeyState, applyKeyLoadError } = hook.result.current;

      hook.rerender('orbit-1');
      expect(hook.result.current.clearKeyState).toBe(clearKeyState);
      expect(hook.result.current.applyKeyLoadError).toBe(applyKeyLoadError);

      act(() => {
        hook.result.current.applyKeyLoadError(pendingWrap());
      });
      expect(hook.result.current.keyPending).toBe(true);
      expect(hook.result.current.clearKeyState).toBe(clearKeyState);
      expect(hook.result.current.applyKeyLoadError).toBe(applyKeyLoadError);

      hook.rerender('orbit-2');
      expect(hook.result.current.clearKeyState).toBe(clearKeyState);
      expect(hook.result.current.applyKeyLoadError).toBe(applyKeyLoadError);
    });

    // Stable callbacks mean the reset effect's own deps never change for a
    // same-key render, so a re-render does not re-run it.
    it('does not re-render on a reset that has nothing to clear', () => {
      const hook = renderHook('orbit-1');
      const before = hook.renders();

      hook.rerender('orbit-2');

      // One render for the update itself; the effect's setState bails out
      // because both values are already false/null.
      expect(hook.renders()).toBe(before + 1);
    });
  });

  it('survives unmount without writing state', () => {
    const hook = renderHook('orbit-1');

    hook.unmount();

    // A late settle calls into the (now dead) setters. React ignores the
    // write; the point is that it must not throw.
    expect(() => hook.result.current.applyKeyLoadError(pendingWrap())).not.toThrow();
    expect(() => hook.result.current.clearKeyState()).not.toThrow();
  });
});
