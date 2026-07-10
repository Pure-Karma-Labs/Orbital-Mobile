/**
 * Auth phase derivation — maps raw boolean inputs to a single discriminated
 * phase value that AppContent switches on.
 *
 * Priority (highest wins):
 *   loading > unauthenticated > key-recovery > key-conflict > terms-required > authenticated
 *
 * key-recovery outranks key-conflict so that a recovery-in-progress session
 * cannot re-enter the conflict gate.
 *
 * PR-2 of #528: the two key-related phases are wired to `false` in App.tsx
 * and rendered as unreachable placeholders. PR-6 will supply real inputs.
 */

export type AuthPhase =
  | 'loading'
  | 'unauthenticated'
  | 'authenticated'
  | 'terms-required'
  | 'key-conflict'
  | 'key-recovery';

export interface DeriveAuthPhaseInputs {
  restoreDone: boolean;
  isAuthenticated: boolean;
  needsTermsAcceptance: boolean;
  identityKeyConflict: boolean;
  keyRecoveryInProgress: boolean;
}

/**
 * Pure function — no side effects, deterministic.
 */
export function deriveAuthPhase(inputs: DeriveAuthPhaseInputs): AuthPhase {
  if (!inputs.restoreDone) return 'loading';
  if (!inputs.isAuthenticated) return 'unauthenticated';

  // Authenticated from here on — check sub-states in priority order
  if (inputs.keyRecoveryInProgress) return 'key-recovery';
  if (inputs.identityKeyConflict) return 'key-conflict';
  if (inputs.needsTermsAcceptance) return 'terms-required';

  return 'authenticated';
}

// ---------------------------------------------------------------------------
// Dev-only transition legality assertion
// ---------------------------------------------------------------------------

/**
 * Legal transitions between auth phases.
 *
 * This table must reflect every transition that deriveAuthPhase CAN produce
 * given any sequence of input changes — not just the "happy-path" UI flows.
 * A transition is legal here if the store inputs can change in a way that
 * causes deriveAuthPhase to emit it, even if the scenario is unlikely.
 *
 * Self-transitions (same→same) are always legal and not listed.
 *
 * Known lower-probability transitions to audit when PR-6 wires real inputs:
 *
 *   loading → key-conflict / key-recovery
 *     Possible under batched hydration: restoreSession sets isAuthenticated
 *     AND identityKeyConflict/keyRecoveryInProgress in the same store
 *     flush, so the first non-loading phase could be key-conflict or
 *     key-recovery directly.
 *
 *   key-recovery → terms-required
 *     Recovery resolves (keyRecoveryInProgress clears) while
 *     needsTermsAcceptance is still true — deriveAuthPhase falls through
 *     to terms-required.
 *
 *   key-conflict → terms-required
 *     Conflict resolves (identityKeyConflict clears) while
 *     needsTermsAcceptance is still true — same fall-through.
 */
const LEGAL_TRANSITIONS: ReadonlyMap<AuthPhase, ReadonlySet<AuthPhase>> = new Map([
  ['loading', new Set<AuthPhase>(['unauthenticated', 'authenticated', 'terms-required', 'key-conflict', 'key-recovery'])],
  ['unauthenticated', new Set<AuthPhase>(['loading', 'authenticated', 'terms-required', 'key-conflict'])],
  ['authenticated', new Set<AuthPhase>(['unauthenticated', 'loading', 'terms-required', 'key-conflict', 'key-recovery'])],
  ['terms-required', new Set<AuthPhase>(['authenticated', 'unauthenticated', 'loading'])],
  ['key-conflict', new Set<AuthPhase>(['key-recovery', 'terms-required', 'unauthenticated', 'loading', 'authenticated'])],
  ['key-recovery', new Set<AuthPhase>(['authenticated', 'terms-required', 'unauthenticated', 'loading', 'key-conflict'])],
]);

/**
 * Warns in __DEV__ when an unexpected phase transition occurs.
 * No-op in production builds.
 */
export function assertLegalTransition(from: AuthPhase, to: AuthPhase): void {
  if (!__DEV__) return;
  if (from === to) return; // self-transition always ok

  const legal = LEGAL_TRANSITIONS.get(from);
  if (!legal || !legal.has(to)) {
    console.warn(
      `[AuthPhase] Unexpected transition: ${from} → ${to}. ` +
        `Legal from "${from}": [${legal ? Array.from(legal).join(', ') : 'none'}]`,
    );
  }
}
