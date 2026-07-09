import {
  deriveAuthPhase,
  assertLegalTransition,
  type AuthPhase,
  type DeriveAuthPhaseInputs,
} from '../authPhase';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convenience: start from all-false defaults, override what matters. */
function inputs(overrides: Partial<DeriveAuthPhaseInputs> = {}): DeriveAuthPhaseInputs {
  return {
    restoreDone: false,
    isAuthenticated: false,
    needsTermsAcceptance: false,
    identityKeyConflict: false,
    keyRecoveryInProgress: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveAuthPhase — truth table
// ---------------------------------------------------------------------------

describe('deriveAuthPhase', () => {
  // ----- loading (restoreDone=false) -----

  it('returns loading when restoreDone is false (all other flags false)', () => {
    expect(deriveAuthPhase(inputs())).toBe('loading');
  });

  it('returns loading even if isAuthenticated is true but restoreDone is false', () => {
    expect(deriveAuthPhase(inputs({ isAuthenticated: true }))).toBe('loading');
  });

  it('returns loading even if every other flag is true but restoreDone is false', () => {
    expect(
      deriveAuthPhase(
        inputs({
          isAuthenticated: true,
          needsTermsAcceptance: true,
          identityKeyConflict: true,
          keyRecoveryInProgress: true,
        }),
      ),
    ).toBe('loading');
  });

  // ----- unauthenticated -----

  it('returns unauthenticated when restoreDone but not authenticated', () => {
    expect(deriveAuthPhase(inputs({ restoreDone: true }))).toBe('unauthenticated');
  });

  it('returns unauthenticated regardless of needsTermsAcceptance when not authenticated', () => {
    expect(
      deriveAuthPhase(inputs({ restoreDone: true, needsTermsAcceptance: true })),
    ).toBe('unauthenticated');
  });

  it('returns unauthenticated regardless of identityKeyConflict when not authenticated', () => {
    expect(
      deriveAuthPhase(inputs({ restoreDone: true, identityKeyConflict: true })),
    ).toBe('unauthenticated');
  });

  // ----- authenticated (happy path) -----

  it('returns authenticated when restoreDone + isAuthenticated + no flags', () => {
    expect(
      deriveAuthPhase(inputs({ restoreDone: true, isAuthenticated: true })),
    ).toBe('authenticated');
  });

  // ----- terms-required -----

  it('returns terms-required when authenticated + needsTermsAcceptance', () => {
    expect(
      deriveAuthPhase(
        inputs({ restoreDone: true, isAuthenticated: true, needsTermsAcceptance: true }),
      ),
    ).toBe('terms-required');
  });

  // ----- key-conflict -----

  it('returns key-conflict when authenticated + identityKeyConflict', () => {
    expect(
      deriveAuthPhase(
        inputs({ restoreDone: true, isAuthenticated: true, identityKeyConflict: true }),
      ),
    ).toBe('key-conflict');
  });

  it('key-conflict outranks terms-required', () => {
    expect(
      deriveAuthPhase(
        inputs({
          restoreDone: true,
          isAuthenticated: true,
          identityKeyConflict: true,
          needsTermsAcceptance: true,
        }),
      ),
    ).toBe('key-conflict');
  });

  // ----- key-recovery -----

  it('returns key-recovery when authenticated + keyRecoveryInProgress', () => {
    expect(
      deriveAuthPhase(
        inputs({ restoreDone: true, isAuthenticated: true, keyRecoveryInProgress: true }),
      ),
    ).toBe('key-recovery');
  });

  it('key-recovery outranks key-conflict', () => {
    expect(
      deriveAuthPhase(
        inputs({
          restoreDone: true,
          isAuthenticated: true,
          keyRecoveryInProgress: true,
          identityKeyConflict: true,
        }),
      ),
    ).toBe('key-recovery');
  });

  it('key-recovery outranks terms-required', () => {
    expect(
      deriveAuthPhase(
        inputs({
          restoreDone: true,
          isAuthenticated: true,
          keyRecoveryInProgress: true,
          needsTermsAcceptance: true,
        }),
      ),
    ).toBe('key-recovery');
  });

  it('key-recovery outranks both key-conflict and terms-required simultaneously', () => {
    expect(
      deriveAuthPhase(
        inputs({
          restoreDone: true,
          isAuthenticated: true,
          keyRecoveryInProgress: true,
          identityKeyConflict: true,
          needsTermsAcceptance: true,
        }),
      ),
    ).toBe('key-recovery');
  });

  // ----- Priority ordering exhaustive -----

  describe('priority ordering', () => {
    it('loading > everything (restoreDone=false always wins)', () => {
      expect(
        deriveAuthPhase(
          inputs({
            restoreDone: false,
            isAuthenticated: true,
            needsTermsAcceptance: true,
            identityKeyConflict: true,
            keyRecoveryInProgress: true,
          }),
        ),
      ).toBe('loading');
    });

    it('unauthenticated > key-recovery (not authenticated)', () => {
      expect(
        deriveAuthPhase(
          inputs({
            restoreDone: true,
            isAuthenticated: false,
            keyRecoveryInProgress: true,
          }),
        ),
      ).toBe('unauthenticated');
    });

    it('key-recovery > key-conflict > terms-required > authenticated', () => {
      // All authenticated sub-states on, recovery wins
      const allOn = inputs({
        restoreDone: true,
        isAuthenticated: true,
        keyRecoveryInProgress: true,
        identityKeyConflict: true,
        needsTermsAcceptance: true,
      });
      expect(deriveAuthPhase(allOn)).toBe('key-recovery');

      // Remove recovery: conflict wins
      const noRecovery = { ...allOn, keyRecoveryInProgress: false };
      expect(deriveAuthPhase(noRecovery)).toBe('key-conflict');

      // Remove conflict: terms wins
      const noConflict = { ...noRecovery, identityKeyConflict: false };
      expect(deriveAuthPhase(noConflict)).toBe('terms-required');

      // Remove terms: authenticated
      const noTerms = { ...noConflict, needsTermsAcceptance: false };
      expect(deriveAuthPhase(noTerms)).toBe('authenticated');
    });
  });

  // ----- Mapping documentation -----
  // This documents the 1:1 mapping from the old App.tsx branch stack
  // to the new deriveAuthPhase approach:
  //
  // OLD BRANCH                              → NEW AuthPhase
  // ─────────────────────────────────────────────────────────
  // authStatus === 'loading'                → 'loading'
  //   (restoreDone=false)
  //
  // authStatus === 'unauthenticated'        → 'unauthenticated'
  //   (restoreDone=true, !isAuthenticated)
  //   preAuthScreen sub-state (login/signup/forgotPassword/resetPassword)
  //   is orthogonal and rendered within the unauthenticated case
  //
  // authStatus === 'authenticated'          → 'terms-required'
  //   && needsTermsAcceptance
  //
  // authStatus === 'authenticated'          → 'authenticated'
  //   && !needsTermsAcceptance
  //
  // (not yet in old code)                   → 'key-conflict'
  //   Placeholder — hard-wired false in PR-2
  //
  // (not yet in old code)                   → 'key-recovery'
  //   Placeholder — hard-wired false in PR-2
});

// ---------------------------------------------------------------------------
// assertLegalTransition
// ---------------------------------------------------------------------------

describe('assertLegalTransition', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // Self-transitions are always silent
  const ALL_PHASES: AuthPhase[] = [
    'loading',
    'unauthenticated',
    'authenticated',
    'terms-required',
    'key-conflict',
    'key-recovery',
  ];

  it.each(ALL_PHASES)('self-transition %s → %s is always silent', (phase) => {
    assertLegalTransition(phase, phase);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // --- Legal transitions (no warning) ---

  const LEGAL_CASES: Array<[AuthPhase, AuthPhase]> = [
    // loading →
    ['loading', 'unauthenticated'],
    ['loading', 'authenticated'],
    ['loading', 'terms-required'],
    // unauthenticated →
    ['unauthenticated', 'loading'],
    ['unauthenticated', 'authenticated'],
    ['unauthenticated', 'terms-required'],
    // authenticated →
    ['authenticated', 'unauthenticated'],
    ['authenticated', 'loading'],
    ['authenticated', 'terms-required'],
    ['authenticated', 'key-conflict'],
    ['authenticated', 'key-recovery'],
    // terms-required →
    ['terms-required', 'authenticated'],
    ['terms-required', 'unauthenticated'],
    ['terms-required', 'loading'],
    // key-conflict →
    ['key-conflict', 'key-recovery'],
    ['key-conflict', 'terms-required'],
    ['key-conflict', 'unauthenticated'],
    ['key-conflict', 'loading'],
    ['key-conflict', 'authenticated'],
    // key-recovery →
    ['key-recovery', 'authenticated'],
    ['key-recovery', 'terms-required'],
    ['key-recovery', 'unauthenticated'],
    ['key-recovery', 'loading'],
  ];

  it.each(LEGAL_CASES)('legal: %s → %s does not warn', (from, to) => {
    assertLegalTransition(from, to);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // --- Illegal transitions (should warn) ---

  const ILLEGAL_CASES: Array<[AuthPhase, AuthPhase]> = [
    // loading cannot jump directly to key phases
    ['loading', 'key-conflict'],
    ['loading', 'key-recovery'],
    // unauthenticated cannot jump to key phases
    ['unauthenticated', 'key-conflict'],
    ['unauthenticated', 'key-recovery'],
    // terms-required cannot jump to key phases
    ['terms-required', 'key-conflict'],
    ['terms-required', 'key-recovery'],
    // key-recovery cannot jump to key-conflict (recovery resolves to authenticated or logout)
    ['key-recovery', 'key-conflict'],
  ];

  it.each(ILLEGAL_CASES)('illegal: %s → %s warns', (from, to) => {
    assertLegalTransition(from, to);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Unexpected transition: ${from} → ${to}`),
    );
  });
});
