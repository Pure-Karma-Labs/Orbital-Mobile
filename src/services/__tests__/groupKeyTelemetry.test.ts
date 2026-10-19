/**
 * Tests for groupKeyTelemetry.ts (#912) — the only emitter for group-key
 * unwrap failures, and the reporter the import-free crypto registry calls.
 *
 * Two things are pinned here, and both are privacy/noise boundaries rather
 * than an API:
 *  - the `groupId` the crypto layer hands over is a BUDGET KEY ONLY. It must
 *    never appear in the event: `scrubEvent` would not recognise a
 *    conversation id inside a tag, so nothing downstream would catch it.
 *  - one event per (group, outcome) per session, cleared by the wipes — so a
 *    user reopening the same dead conversation is one fact, not ten, and the
 *    next account on the device does not inherit this one's spent keys.
 */

jest.mock('../telemetry', () => ({
  captureError: jest.fn(),
}));

import { captureError } from '../telemetry';
import {
  installGroupKeyFailureReporter,
  clearGroupKeyTelemetryState,
} from '../groupKeyTelemetry';
import {
  GroupKeyUnwrapError,
  reportGroupKeyFailure,
  resetGroupKeyFailureBudget,
  setGroupKeyFailureReporter,
} from '../crypto/groupKeyErrors';
import type { SelfHealOutcome } from '../crypto/groupKeyErrors';

const mockCaptureError = captureError as unknown as jest.Mock;

/** A groupId distinctive enough that a substring search for it is meaningful. */
const GROUP_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_GROUP_ID = '99999999-8888-7777-6666-555555555555';

/** The CaptureContext the reporter attached to call `i`. */
function context(i = 0): Record<string, unknown> {
  return mockCaptureError.mock.calls[i][1] as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  // The budget is module state: without this, case order would decide outcomes.
  clearGroupKeyTelemetryState();
  installGroupKeyFailureReporter();
});

afterEach(() => {
  // Leave the registry empty so this suite cannot report for another one.
  setGroupKeyFailureReporter(null);
});

describe('installGroupKeyFailureReporter', () => {
  it('fills the registry slot so a crypto-side report reaches captureError', () => {
    const error = new GroupKeyUnwrapError('recipient_mismatch', 'requested');

    reportGroupKeyFailure(GROUP_ID, error);

    expect(mockCaptureError).toHaveBeenCalledTimes(1);
    expect(mockCaptureError.mock.calls[0][0]).toBe(error);
  });

  it('is a no-op for the crypto side when nothing is installed', () => {
    setGroupKeyFailureReporter(null);

    expect(() =>
      reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('corrupt', 'failed')),
    ).not.toThrow();
    expect(mockCaptureError).not.toHaveBeenCalled();
  });
});

describe('the per-session budget', () => {
  it('drops a repeat of the same (group, outcome)', () => {
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'requested'));
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'requested'));

    expect(mockCaptureError).toHaveBeenCalledTimes(1);
  });

  // The useful signal is the TRANSITION — `requested` then `exhausted` for the
  // same group is two facts, not a repeat.
  it('reports a different outcome for the same group', () => {
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'requested'));
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'exhausted'));

    expect(mockCaptureError).toHaveBeenCalledTimes(2);
  });

  it('reports the same outcome for a different group', () => {
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'requested'));
    reportGroupKeyFailure(
      OTHER_GROUP_ID,
      new GroupKeyUnwrapError('recipient_mismatch', 'requested'),
    );

    expect(mockCaptureError).toHaveBeenCalledTimes(2);
  });

  // The budget keys off the outcome, not the failure code: the same group
  // arriving twice at `requested` is still one event.
  it('keys off the outcome alone, not the failure code', () => {
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'requested'));
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('sender_mismatch', 'requested'));

    expect(mockCaptureError).toHaveBeenCalledTimes(1);
  });
});

describe('level mapping', () => {
  // `requested` is the SUCCESS path of the self-heal — the key is on its way
  // and the user sees a transient notice. Worth counting, not worth paging.
  it('reports `requested` at warning', () => {
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'requested'));

    expect(context()).toMatchObject({ level: 'warning' });
  });

  const ERROR_OUTCOMES: SelfHealOutcome[] = [
    'cooldown',
    'exhausted',
    'refused',
    'identity_mismatch',
    'unsupported',
    'rate_limited',
    'blocked_local_key',
    'not_eligible',
    'failed',
  ];

  it.each(ERROR_OUTCOMES)('reports `%s` at error', (outcome) => {
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', outcome));

    expect(context()).toMatchObject({ level: 'error' });
  });

  it('tags the feature so the events can be found as a group', () => {
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'failed'));

    expect(context()).toEqual({
      level: 'error',
      tags: { feature: 'group-key-self-heal' },
    });
  });
});

describe('the groupId never reaches the event', () => {
  it('passes the error alone — the groupId is a budget key', () => {
    reportGroupKeyFailure(
      GROUP_ID,
      new GroupKeyUnwrapError('recipient_mismatch', 'refused', 'ENVELOPE_CHANGED'),
    );

    expect(mockCaptureError).toHaveBeenCalledTimes(1);
    // Whole call, both arguments, error message included.
    expect(JSON.stringify(mockCaptureError.mock.calls)).not.toContain(GROUP_ID);
    // ...and not a fragment of it either, in case a tag carried a prefix.
    expect(JSON.stringify(mockCaptureError.mock.calls)).not.toContain('11111111');
  });

  it('leaks nothing even across several groups and outcomes', () => {
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'requested'));
    reportGroupKeyFailure(OTHER_GROUP_ID, new GroupKeyUnwrapError('corrupt', 'not_eligible'));

    const serialized = JSON.stringify(mockCaptureError.mock.calls);
    expect(serialized).not.toContain(GROUP_ID);
    expect(serialized).not.toContain(OTHER_GROUP_ID);
    expect(serialized).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });
});

describe('clearing the budget', () => {
  it('clearGroupKeyTelemetryState lets a spent key be reported again', () => {
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'requested'));
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'requested'));
    expect(mockCaptureError).toHaveBeenCalledTimes(1);

    clearGroupKeyTelemetryState();
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'requested'));

    expect(mockCaptureError).toHaveBeenCalledTimes(2);
  });

  // `fullCryptoWipe` cannot import this module (ESLint bans telemetry facades
  // inside the crypto fence), so it clears the budget through the registry.
  // This is that path, called exactly as the fence calls it.
  it('resetGroupKeyFailureBudget reaches the installed reporter', () => {
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'requested'));
    expect(mockCaptureError).toHaveBeenCalledTimes(1);

    resetGroupKeyFailureBudget();
    reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'requested'));

    expect(mockCaptureError).toHaveBeenCalledTimes(2);
  });

  it('resetGroupKeyFailureBudget is a no-op with no reporter installed', () => {
    setGroupKeyFailureReporter(null);

    expect(() => resetGroupKeyFailureBudget()).not.toThrow();
  });
});

describe('reporting never breaks the crypto path', () => {
  it('swallows a throwing captureError and still reports the next failure', () => {
    mockCaptureError.mockImplementationOnce(() => {
      throw new Error('Sentry client not initialized');
    });

    expect(() =>
      reportGroupKeyFailure(GROUP_ID, new GroupKeyUnwrapError('recipient_mismatch', 'requested')),
    ).not.toThrow();
    expect(mockCaptureError).toHaveBeenCalledTimes(1);

    // A different budget key, so the drop below would be the budget, not the
    // throw: the reporter must still be live.
    reportGroupKeyFailure(
      OTHER_GROUP_ID,
      new GroupKeyUnwrapError('recipient_mismatch', 'requested'),
    );

    expect(mockCaptureError).toHaveBeenCalledTimes(2);
  });
});
