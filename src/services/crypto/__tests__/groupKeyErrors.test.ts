/**
 * Tests for groupKeyErrors — the closed failure vocabulary, the ecies_open
 * classifier and the reporter registry.
 *
 * The classifier is the gate in front of every demote request, so the cases
 * that matter most are the NEGATIVE ones: anything that is not provably a
 * SignalError must return null and be rethrown untouched.
 */

import {
  GroupKeyUnwrapError,
  isGroupKeyUnwrapError,
  classifyEciesOpenError,
  setGroupKeyFailureReporter,
  reportGroupKeyFailure,
  resetGroupKeyFailureBudget,
  REWRAP_REFUSAL_CODES,
} from '../groupKeyErrors';

/** Build an error shaped exactly like a uniffi-lifted SignalError. */
function signalError(tag: string, reason?: string): Error {
  const err = new Error(`SignalError.${tag}`);
  Object.assign(err, reason === undefined ? { tag } : { tag, inner: { reason } });
  return err;
}

afterEach(() => {
  setGroupKeyFailureReporter(null);
});

// ---------------------------------------------------------------------------
// GroupKeyUnwrapError
// ---------------------------------------------------------------------------

describe('GroupKeyUnwrapError', () => {
  it('carries code, selfHeal and refusalCode', () => {
    const e = new GroupKeyUnwrapError('recipient_mismatch', 'refused', 'NO_KEY_HOLDER');
    expect(e.name).toBe('GroupKeyUnwrapError');
    expect(e.code).toBe('recipient_mismatch');
    expect(e.selfHeal).toBe('refused');
    expect(e.refusalCode).toBe('NO_KEY_HOLDER');
  });

  it('leaves refusalCode undefined when omitted', () => {
    expect(new GroupKeyUnwrapError('corrupt', 'not_eligible').refusalCode).toBeUndefined();
  });

  it('builds its message from enum values only', () => {
    expect(new GroupKeyUnwrapError('sender_mismatch', 'requested').message).toBe(
      'Group key unwrap failed: sender_mismatch / requested',
    );
    expect(
      new GroupKeyUnwrapError('recipient_mismatch', 'refused', 'DEMO_ACCOUNT').message,
    ).toBe('Group key unwrap failed: recipient_mismatch / refused / DEMO_ACCOUNT');
  });

  it('is an Error with a usable stack', () => {
    const e = new GroupKeyUnwrapError('unknown', 'failed');
    expect(e instanceof Error).toBe(true);
    expect(typeof e.stack).toBe('string');
  });

  it('isGroupKeyUnwrapError matches by name, not by instanceof', () => {
    expect(isGroupKeyUnwrapError(new GroupKeyUnwrapError('corrupt', 'failed'))).toBe(true);
    // A factory-mocked copy from another module registry.
    expect(isGroupKeyUnwrapError({ name: 'GroupKeyUnwrapError' })).toBe(true);
    expect(isGroupKeyUnwrapError(new Error('nope'))).toBe(false);
    expect(isGroupKeyUnwrapError(null)).toBe(false);
    expect(isGroupKeyUnwrapError('GroupKeyUnwrapError')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyEciesOpenError — positive cases
// ---------------------------------------------------------------------------

describe('classifyEciesOpenError — recognised SignalErrors', () => {
  it("maps InvalidMessage 'decryption failed' to recipient_mismatch", () => {
    expect(
      classifyEciesOpenError(signalError('InvalidMessage', 'ecies_open: decryption failed')),
    ).toBe('recipient_mismatch');
  });

  it("maps InvalidMessage 'DH produced identity point' to corrupt", () => {
    expect(
      classifyEciesOpenError(
        signalError(
          'InvalidMessage',
          'ecies_open: DH produced identity point (small-order ephemeral key)',
        ),
      ),
    ).toBe('corrupt');
  });

  it("maps InvalidKey 'does not match expected sender' to sender_mismatch", () => {
    expect(
      classifyEciesOpenError(
        signalError('InvalidKey', 'ecies_open: sender public key does not match expected sender'),
      ),
    ).toBe('sender_mismatch');
  });

  it('maps a bare InvalidSignature (no inner) to corrupt', () => {
    expect(classifyEciesOpenError(signalError('InvalidSignature'))).toBe('corrupt');
  });

  it('maps an unrecognised reason on a known tag to unknown', () => {
    expect(
      classifyEciesOpenError(signalError('InvalidMessage', 'ecies_open: bad version byte 3')),
    ).toBe('unknown');
    expect(
      classifyEciesOpenError(signalError('InvalidKey', 'ecies_open: invalid sender public key')),
    ).toBe('unknown');
  });

  it('maps any other SignalError variant to unknown', () => {
    expect(classifyEciesOpenError(signalError('InternalError', 'boom'))).toBe('unknown');
    expect(classifyEciesOpenError(signalError('InvalidArgument', 'nope'))).toBe('unknown');
    expect(classifyEciesOpenError(signalError('StoreError', 'nope'))).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// classifyEciesOpenError — negative cases (must be rethrown by callers)
// ---------------------------------------------------------------------------

describe('classifyEciesOpenError — not a SignalError', () => {
  it('returns null for a plain object that only has a tag', () => {
    expect(classifyEciesOpenError({ tag: 'InvalidMessage' })).toBeNull();
    expect(
      classifyEciesOpenError({ tag: 'InvalidMessage', inner: { reason: 'decryption failed' } }),
    ).toBeNull();
  });

  it('returns null for an ordinary Error', () => {
    expect(classifyEciesOpenError(new Error('No authenticated user'))).toBeNull();
    expect(classifyEciesOpenError(new Error('ECIES envelope requires sender identity'))).toBeNull();
  });

  it('returns null for an error whose message merely mentions SignalError', () => {
    expect(classifyEciesOpenError(new Error('wrapped: SignalError.InvalidMessage'))).toBeNull();
  });

  it('returns null for primitives and nullish values', () => {
    expect(classifyEciesOpenError(null)).toBeNull();
    expect(classifyEciesOpenError(undefined)).toBeNull();
    expect(classifyEciesOpenError('SignalError.InvalidMessage')).toBeNull();
    expect(classifyEciesOpenError(42)).toBeNull();
  });

  it('returns unknown, not a crash, when tag or inner are the wrong types', () => {
    const e1 = new Error('SignalError.InvalidMessage');
    Object.assign(e1, { tag: 7, inner: { reason: 'decryption failed' } });
    expect(classifyEciesOpenError(e1)).toBe('unknown');

    const e2 = new Error('SignalError.InvalidMessage');
    Object.assign(e2, { tag: 'InvalidMessage', inner: 'decryption failed' });
    expect(classifyEciesOpenError(e2)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Refusal code allowlist
// ---------------------------------------------------------------------------

describe('REWRAP_REFUSAL_CODES', () => {
  it('is frozen and holds the backend vocabulary plus the client sentinel', () => {
    expect(Object.isFrozen(REWRAP_REFUSAL_CODES)).toBe(true);
    expect(Object.keys(REWRAP_REFUSAL_CODES).sort()).toEqual(
      [
        'DEMO_ACCOUNT',
        'ENVELOPE_CHANGED',
        'IDENTITY_MISMATCH',
        'NO_IDENTITY_KEY',
        'NO_KEY_HOLDER',
        'SELF_WRAPPED',
        'SERVER_KEY_UNREADABLE',
        'UNATTRIBUTED',
        'unrecognized',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Reporter registry
// ---------------------------------------------------------------------------

describe('reporter registry', () => {
  it('is a no-op when no reporter is installed', () => {
    expect(() =>
      reportGroupKeyFailure('g1', new GroupKeyUnwrapError('corrupt', 'failed')),
    ).not.toThrow();
    expect(() => resetGroupKeyFailureBudget()).not.toThrow();
  });

  it('forwards groupId and error to the installed reporter', () => {
    const report = jest.fn();
    const reset = jest.fn();
    setGroupKeyFailureReporter({ report, reset });

    const err = new GroupKeyUnwrapError('recipient_mismatch', 'requested');
    reportGroupKeyFailure('g1', err);
    resetGroupKeyFailureBudget();

    expect(report).toHaveBeenCalledWith('g1', err);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing reporter', () => {
    setGroupKeyFailureReporter({
      report: () => {
        throw new Error('sentry exploded');
      },
      reset: () => {
        throw new Error('sentry exploded');
      },
    });

    expect(() =>
      reportGroupKeyFailure('g1', new GroupKeyUnwrapError('corrupt', 'failed')),
    ).not.toThrow();
    expect(() => resetGroupKeyFailureBudget()).not.toThrow();
  });

  it('stops reporting once uninstalled', () => {
    const report = jest.fn();
    setGroupKeyFailureReporter({ report, reset: jest.fn() });
    setGroupKeyFailureReporter(null);

    reportGroupKeyFailure('g1', new GroupKeyUnwrapError('corrupt', 'failed'));

    expect(report).not.toHaveBeenCalled();
  });
});
