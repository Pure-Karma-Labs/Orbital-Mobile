/**
 * Is importing available in THIS orbit, right now? (#928 §3.3)
 *
 * The server's flag gate sits above `authenticate`, so an instance with
 * `IMPORTS_ENABLED` off answers 404 byte-identically to an unknown route —
 * which is what production answers today. Without this probe every member on
 * 1.7.8 would cross the Settings section, the how-to screen and the OS file
 * picker before finding out.
 *
 * Probed on FOCUS, not on mount: the answer for a `404` is cached for the
 * session by the runner, but a network failure is not, and re-probing on the
 * next visit is how a member who was offline a minute ago gets the section
 * back without relaunching.
 */

import { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { probeImportAvailability } from '../../services/metaImport/importRunner';

import type { ImportAllowance } from '../../types/api';
import type { ImportSource } from '../../services/metaImport/types';

/**
 * `unavailable` is a definite no (the server returned 404 — the flag is off).
 * `error` is "ask again later", and the section hides for both: offering a
 * flow whose allowance we could not read would strand the member at the
 * picker.
 */
export type ImportAvailabilityStatus = 'checking' | 'available' | 'unavailable' | 'error';

export interface ImportAvailabilityState {
  readonly status: ImportAvailabilityStatus;
  /**
   * BOTH sources' buckets, non-null only when `status === 'available'`.
   *
   * Per source since B#352; the how-to screen shows what is left of each.
   */
  readonly allowances: Readonly<Record<ImportSource, ImportAllowance>> | null;
}

// `limits` is deliberately NOT carried (#996 §7.3): nothing in the UI read it,
// and a field nobody reads is a field that drifts. The runner's own
// `ImportAvailability.limits` is untouched — the preflight needs it.

/** Which orbit the answer is ABOUT — never exposed, only compared. */
interface ProbeState extends ImportAvailabilityState {
  readonly conversationId: string | null;
}

const CHECKING: ProbeState = Object.freeze({
  conversationId: null,
  status: 'checking',
  allowances: null,
});

const NO_ORBIT: ProbeState = Object.freeze({
  conversationId: null,
  status: 'unavailable',
  allowances: null,
});

export function useImportAvailability(conversationId: string | null): ImportAvailabilityState {
  const [state, setState] = useState<ProbeState>(CHECKING);

  useFocusEffect(
    useCallback(() => {
      const id = conversationId;
      // Cleanup flips this, so a result that lands after the member switched
      // orbit or left the screen is dropped rather than shown against the
      // wrong orbit.
      let active = true;

      if (id === null) {
        setState(NO_ORBIT);
        return () => {
          active = false;
        };
      }

      // Re-focusing the SAME orbit keeps the answer on screen: the probe is
      // cached, so dropping back to `checking` would only flicker the section
      // out and back in.
      setState((prev) => (prev.conversationId === id ? prev : CHECKING));

      probeImportAvailability(id).then(
        (result) => {
          if (!active) return;
          setState({
            conversationId: id,
            status: result.available ? 'available' : 'unavailable',
            allowances: result.allowances,
          });
        },
        () => {
          // Deliberately silent: `src/screens/import/` is held to a zero-log
          // bar, and a failed availability probe is a hidden section, not an
          // incident.
          if (!active) return;
          setState({ conversationId: id, status: 'error', allowances: null });
        },
      );

      return () => {
        active = false;
      };
    }, [conversationId]),
  );

  // An answer about a DIFFERENT orbit is not an answer about this one.
  if (state.conversationId !== null && state.conversationId !== conversationId) {
    return CHECKING;
  }
  return state;
}
