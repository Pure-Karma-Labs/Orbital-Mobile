/**
 * Tests for groupKeyRecovery — the #912 self-heal state machine.
 *
 * What is being pinned here is ORDER and BUDGET, not crypto:
 * - the local probe runs before the network refresh that writes trust state;
 * - a definite probe mismatch latches for the session, a throw never does;
 * - only a committed demote spends the caps, while every attempt stamps the
 *   cooldown;
 * - each HTTP outcome routes to exactly one SelfHealOutcome.
 *
 * The real `api/errors` classes are used deliberately: the 409 refusal code is
 * parsed from a real wire body, so this suite also covers the C4/C5 contract.
 */

jest.mock('../../api/groups', () => ({
  requestGroupKeyRewrap: jest.fn(),
}));

jest.mock('../identityKeyAccess', () => ({
  getIdentityKeyPair: jest.fn(),
  refreshAndCompareIdentityKey: jest.fn(),
}));

jest.mock('../identityKeyProbe', () => ({
  probeIdentityKeyPair: jest.fn(),
}));

const mockSetContactVerifiedStatus = jest.fn();
const mockState = { userId: 'me' as string | null, setContactVerifiedStatus: mockSetContactVerifiedStatus };
jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => mockState),
  },
}));

import { requestGroupKeyRewrap } from '../../api/groups';
import {
  ApiError,
  AuthError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../api/errors';
import {
  getIdentityKeyPair,
  refreshAndCompareIdentityKey,
} from '../identityKeyAccess';
import { probeIdentityKeyPair } from '../identityKeyProbe';
import {
  recoverDeadEnvelope,
  resetGroupKeyRecoveryState,
  RECOVERY_COOLDOWN_MS,
  PER_GROUP_DEMOTE_CAP,
  SESSION_DEMOTE_CAP,
} from '../groupKeyRecovery';
import { VerifiedStatus } from '../../../types/database';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENVELOPE = 'AgAAAA-envelope-base64';
const PEER = 'peer-user';

/** 33-byte identity public key, 0x05 || 0x07 * 32 → a stable base64 witness. */
function identityPair(): { privateKey: ArrayBuffer; publicKey: ArrayBuffer } {
  const pub = new Uint8Array(33);
  pub[0] = 0x05;
  pub.fill(0x07, 1);
  return { privateKey: new Uint8Array(32).fill(0x02).buffer, publicKey: pub.buffer };
}

/** base64 of 0x05 || 0x07 * 32 — 33 bytes, so exactly 44 chars and no padding. */
const EXPECTED_PUB_B64 = 'BQcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH';

/** A real uniffi-shaped SignalError, so the reclassifier runs for real. */
function signalError(tag: string, reason: string): Error {
  const err = new Error(`SignalError.${tag}`);
  Object.assign(err, { tag, inner: { reason } });
  return err;
}

const RECIPIENT_MISMATCH_ERR = signalError(
  'InvalidMessage',
  'ecies_open: decryption failed',
);

function refusal(code: string): ConflictError {
  return new ConflictError(
    JSON.stringify({ error: 'REWRAP_REFUSED', message: 'nope', details: { code } }),
  );
}

type Overrides = Partial<Parameters<typeof recoverDeadEnvelope>[0]>;

function input(overrides: Overrides = {}): Parameters<typeof recoverDeadEnvelope>[0] {
  return {
    groupId: 'group-1',
    envelope: ENVELOPE,
    wrappedBy: PEER,
    code: 'recipient_mismatch',
    retryUnwrap: jest.fn(),
    ...overrides,
  };
}

let now = 1_700_000_000_000;

beforeEach(() => {
  jest.clearAllMocks();
  resetGroupKeyRecoveryState();
  mockState.userId = 'me';
  now = 1_700_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  (getIdentityKeyPair as jest.Mock).mockImplementation(() => identityPair());
  (probeIdentityKeyPair as jest.Mock).mockReturnValue('match');
  (requestGroupKeyRewrap as jest.Mock).mockResolvedValue({ success: true });
  (refreshAndCompareIdentityKey as jest.Mock).mockResolvedValue({
    publicKey: new ArrayBuffer(33),
    identityChanged: false,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Step 1 — eligibility short-circuits
// ---------------------------------------------------------------------------

describe('eligibility', () => {
  it('is not_eligible with no authenticated user', async () => {
    mockState.userId = null;

    const r = await recoverDeadEnvelope(input());

    expect(r.outcome).toBe('not_eligible');
    expect(getIdentityKeyPair).not.toHaveBeenCalled();
    expect(requestGroupKeyRewrap).not.toHaveBeenCalled();
  });

  it('is not_eligible when the envelope is unattributed', async () => {
    const r = await recoverDeadEnvelope(input({ wrappedBy: null }));

    expect(r.outcome).toBe('not_eligible');
    expect(requestGroupKeyRewrap).not.toHaveBeenCalled();
  });

  it('is not_eligible when the caller wrapped it themselves', async () => {
    const r = await recoverDeadEnvelope(input({ wrappedBy: 'me' }));

    expect(r.outcome).toBe('not_eligible');
    expect(requestGroupKeyRewrap).not.toHaveBeenCalled();
  });

  it('is not_eligible for an unknown failure code', async () => {
    const r = await recoverDeadEnvelope(input({ code: 'unknown' }));

    expect(r.outcome).toBe('not_eligible');
    expect(probeIdentityKeyPair).not.toHaveBeenCalled();
    expect(requestGroupKeyRewrap).not.toHaveBeenCalled();
  });

  it('heals a corrupt envelope too — only unknown is excluded', async () => {
    const r = await recoverDeadEnvelope(input({ code: 'corrupt' }));

    expect(r.outcome).toBe('requested');
  });

  it('returns the input code unchanged when it does not reclassify', async () => {
    const r = await recoverDeadEnvelope(input({ code: 'corrupt' }));

    expect(r.code).toBe('corrupt');
  });
});

// ---------------------------------------------------------------------------
// Step 3 — gate 1, the local probe
// ---------------------------------------------------------------------------

describe('gate 1 — the local identity-key probe', () => {
  it('runs before the sender refresh, which writes trust state', async () => {
    const order: string[] = [];
    (probeIdentityKeyPair as jest.Mock).mockImplementation(() => {
      order.push('probe');
      return 'match';
    });
    (refreshAndCompareIdentityKey as jest.Mock).mockImplementation(async () => {
      order.push('refresh');
      return { publicKey: new ArrayBuffer(33), identityChanged: false };
    });

    await recoverDeadEnvelope(
      input({
        code: 'sender_mismatch',
        retryUnwrap: jest.fn().mockRejectedValue(RECIPIENT_MISMATCH_ERR),
      }),
    );

    expect(order).toEqual(['probe', 'refresh']);
  });

  it('runs before any network call', async () => {
    await recoverDeadEnvelope(input());

    expect(probeIdentityKeyPair).toHaveBeenCalledTimes(1);
    expect((probeIdentityKeyPair as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (requestGroupKeyRewrap as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it('latches blocked_local_key on a definite mismatch', async () => {
    (probeIdentityKeyPair as jest.Mock).mockReturnValue('mismatch');

    const first = await recoverDeadEnvelope(input());
    expect(first.outcome).toBe('blocked_local_key');
    expect(requestGroupKeyRewrap).not.toHaveBeenCalled();

    // A different group in the same session short-circuits without re-probing.
    (probeIdentityKeyPair as jest.Mock).mockReturnValue('match');
    const second = await recoverDeadEnvelope(input({ groupId: 'group-2' }));

    expect(second.outcome).toBe('blocked_local_key');
    expect(probeIdentityKeyPair).toHaveBeenCalledTimes(1);
    expect(requestGroupKeyRewrap).not.toHaveBeenCalled();
  });

  it('does NOT latch when the probe throws, and a later group stays eligible', async () => {
    (probeIdentityKeyPair as jest.Mock).mockImplementationOnce(() => {
      throw new Error('SignalError.InternalError');
    });

    const first = await recoverDeadEnvelope(input());
    expect(first.outcome).toBe('failed');

    const second = await recoverDeadEnvelope(input({ groupId: 'group-2' }));
    expect(second.outcome).toBe('requested');
  });

  it("does NOT latch when the key pair is unavailable (cold cache)", async () => {
    (getIdentityKeyPair as jest.Mock).mockImplementationOnce(() => {
      throw new Error('Identity key pair not available');
    });

    const first = await recoverDeadEnvelope(input());
    expect(first.outcome).toBe('failed');

    const second = await recoverDeadEnvelope(input({ groupId: 'group-2' }));
    expect(second.outcome).toBe('requested');
  });
});

// ---------------------------------------------------------------------------
// Step 4 — gate 3, stale sender key
// ---------------------------------------------------------------------------

describe('gate 3 — stale sender key', () => {
  it('refreshes and retries for sender_mismatch, and heals without any API call', async () => {
    const retryUnwrap = jest.fn().mockResolvedValue(new Uint8Array(32).fill(9));

    const r = await recoverDeadEnvelope(input({ code: 'sender_mismatch', retryUnwrap }));

    expect(r.outcome).toBe('healed');
    expect(refreshAndCompareIdentityKey).toHaveBeenCalledWith(PEER, 'me');
    expect(retryUnwrap).toHaveBeenCalledTimes(1);
    expect(requestGroupKeyRewrap).not.toHaveBeenCalled();
  });

  it('marks the wrapper unverified when their identity key changed', async () => {
    (refreshAndCompareIdentityKey as jest.Mock).mockResolvedValue({
      publicKey: new ArrayBuffer(33),
      identityChanged: true,
    });
    const retryUnwrap = jest.fn().mockResolvedValue(new Uint8Array(32));

    await recoverDeadEnvelope(input({ code: 'sender_mismatch', retryUnwrap }));

    expect(mockSetContactVerifiedStatus).toHaveBeenCalledWith(
      PEER,
      VerifiedStatus.Unverified,
    );
  });

  it('does not touch verified status when the key is unchanged', async () => {
    const retryUnwrap = jest.fn().mockResolvedValue(new Uint8Array(32));

    await recoverDeadEnvelope(input({ code: 'sender_mismatch', retryUnwrap }));

    expect(mockSetContactVerifiedStatus).not.toHaveBeenCalled();
  });

  it('skips the refresh entirely for recipient_mismatch', async () => {
    const retryUnwrap = jest.fn();

    await recoverDeadEnvelope(input({ code: 'recipient_mismatch', retryUnwrap }));

    expect(refreshAndCompareIdentityKey).not.toHaveBeenCalled();
    expect(retryUnwrap).not.toHaveBeenCalled();
  });

  it('fails the attempt when the refresh itself throws', async () => {
    (refreshAndCompareIdentityKey as jest.Mock).mockRejectedValue(new Error('offline'));
    const retryUnwrap = jest.fn();

    const r = await recoverDeadEnvelope(input({ code: 'sender_mismatch', retryUnwrap }));

    expect(r.outcome).toBe('failed');
    expect(retryUnwrap).not.toHaveBeenCalled();
    expect(requestGroupKeyRewrap).not.toHaveBeenCalled();
  });

  it('reclassifies a still-failing retry and demotes under the new code', async () => {
    const r = await recoverDeadEnvelope(
      input({
        code: 'sender_mismatch',
        retryUnwrap: jest.fn().mockRejectedValue(RECIPIENT_MISMATCH_ERR),
      }),
    );

    expect(r.outcome).toBe('requested');
    expect(r.code).toBe('recipient_mismatch');
    expect(requestGroupKeyRewrap).toHaveBeenCalledTimes(1);
  });

  it('calls retryUnwrap exactly once', async () => {
    const retryUnwrap = jest.fn().mockRejectedValue(RECIPIENT_MISMATCH_ERR);

    await recoverDeadEnvelope(input({ code: 'sender_mismatch', retryUnwrap }));

    expect(retryUnwrap).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a non-SignalError', new Error('database is locked')],
    ['an unrecognised SignalError', signalError('InternalError', 'boom')],
  ])('is not_eligible when the retry fails with %s', async (_label, err) => {
    const r = await recoverDeadEnvelope(
      input({ code: 'sender_mismatch', retryUnwrap: jest.fn().mockRejectedValue(err) }),
    );

    expect(r.outcome).toBe('not_eligible');
    expect(requestGroupKeyRewrap).not.toHaveBeenCalled();
  });

  it('fails when the retry resolves without a key', async () => {
    const r = await recoverDeadEnvelope(
      input({ code: 'sender_mismatch', retryUnwrap: jest.fn().mockResolvedValue(null) }),
    );

    expect(r.outcome).toBe('failed');
    expect(requestGroupKeyRewrap).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Step 5 — the demote and its HTTP outcomes
// ---------------------------------------------------------------------------

describe('demote request', () => {
  it('sends the untouched envelope and the probed public key', async () => {
    const r = await recoverDeadEnvelope(input());

    expect(r.outcome).toBe('requested');
    expect(requestGroupKeyRewrap).toHaveBeenCalledWith(
      'group-1',
      ENVELOPE,
      EXPECTED_PUB_B64,
    );
  });

  it.each([
    ['IDENTITY_MISMATCH', 'identity_mismatch'],
    ['NO_IDENTITY_KEY', 'identity_mismatch'],
    ['SERVER_KEY_UNREADABLE', 'identity_mismatch'],
    ['NO_KEY_HOLDER', 'refused'],
    ['ENVELOPE_CHANGED', 'refused'],
    ['SELF_WRAPPED', 'refused'],
    ['UNATTRIBUTED', 'refused'],
    ['DEMO_ACCOUNT', 'refused'],
  ])('routes the 409 refusal %s to %s and carries the code', async (code, outcome) => {
    (requestGroupKeyRewrap as jest.Mock).mockRejectedValue(refusal(code));

    const r = await recoverDeadEnvelope(input());

    expect(r.outcome).toBe(outcome);
    expect(r.refusalCode).toBe(code);
  });

  it("carries 'unrecognized' for a refusal code this build does not know", async () => {
    (requestGroupKeyRewrap as jest.Mock).mockRejectedValue(refusal('SOME_FUTURE_CODE'));

    const r = await recoverDeadEnvelope(input());

    expect(r.outcome).toBe('refused');
    expect(r.refusalCode).toBe('unrecognized');
  });

  it('refuses without a code on a 409 that carries none', async () => {
    (requestGroupKeyRewrap as jest.Mock).mockRejectedValue(new ConflictError('{}'));

    const r = await recoverDeadEnvelope(input());

    expect(r.outcome).toBe('refused');
    expect(r.refusalCode).toBeUndefined();
  });

  it('routes 403 to refused', async () => {
    (requestGroupKeyRewrap as jest.Mock).mockRejectedValue(new AuthError(403));

    const r = await recoverDeadEnvelope(input());

    expect(r.outcome).toBe('refused');
  });

  it('routes 401 to failed, NOT refused', async () => {
    (requestGroupKeyRewrap as jest.Mock).mockRejectedValue(new AuthError(401));

    const r = await recoverDeadEnvelope(input());

    expect(r.outcome).toBe('failed');
  });

  it('routes 429 to rate_limited', async () => {
    (requestGroupKeyRewrap as jest.Mock).mockRejectedValue(
      new ApiError('Rate limited — try again shortly', 429, 'RATE_LIMITED', true),
    );

    const r = await recoverDeadEnvelope(input());

    expect(r.outcome).toBe('rate_limited');
  });

  it('routes 400 to a terminal not_eligible', async () => {
    (requestGroupKeyRewrap as jest.Mock).mockRejectedValue(new ValidationError(400));

    const r = await recoverDeadEnvelope(input());

    expect(r.outcome).toBe('not_eligible');
  });

  it('routes anything else to failed', async () => {
    (requestGroupKeyRewrap as jest.Mock).mockRejectedValue(new Error('socket hang up'));

    const r = await recoverDeadEnvelope(input());

    expect(r.outcome).toBe('failed');
  });

  it('latches unsupported on a 404 and skips every later group', async () => {
    (requestGroupKeyRewrap as jest.Mock).mockRejectedValue(new NotFoundError());

    const first = await recoverDeadEnvelope(input());
    expect(first.outcome).toBe('unsupported');

    const second = await recoverDeadEnvelope(input({ groupId: 'group-2' }));
    expect(second.outcome).toBe('unsupported');
    expect(requestGroupKeyRewrap).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Step 2 — cooldown and caps
// ---------------------------------------------------------------------------

describe('cooldown', () => {
  it('short-circuits a second attempt on the same group', async () => {
    await recoverDeadEnvelope(input());
    now += 1_000;

    const r = await recoverDeadEnvelope(input());

    expect(r.outcome).toBe('cooldown');
    expect(requestGroupKeyRewrap).toHaveBeenCalledTimes(1);
  });

  it('expires after the window', async () => {
    await recoverDeadEnvelope(input());
    now += RECOVERY_COOLDOWN_MS + 1;

    const r = await recoverDeadEnvelope(input());

    expect(r.outcome).toBe('requested');
  });

  it('is per group, not global', async () => {
    await recoverDeadEnvelope(input());

    const r = await recoverDeadEnvelope(input({ groupId: 'group-2' }));

    expect(r.outcome).toBe('requested');
  });

  it('is stamped by a transient failure too', async () => {
    (requestGroupKeyRewrap as jest.Mock).mockRejectedValueOnce(new Error('socket hang up'));

    const first = await recoverDeadEnvelope(input());
    expect(first.outcome).toBe('failed');

    const second = await recoverDeadEnvelope(input());
    expect(second.outcome).toBe('cooldown');
  });
});

describe('caps', () => {
  /** Walk past the cooldown so only the cap can stop the next attempt. */
  async function attemptAfterCooldown(groupId = 'group-1'): Promise<string> {
    now += RECOVERY_COOLDOWN_MS + 1;
    const r = await recoverDeadEnvelope(input({ groupId }));
    return r.outcome;
  }

  it('spends the per-group cap on committed demotes only', async () => {
    expect((await recoverDeadEnvelope(input())).outcome).toBe('requested');
    expect(await attemptAfterCooldown()).toBe('requested');
    expect(PER_GROUP_DEMOTE_CAP).toBe(2);

    expect(await attemptAfterCooldown()).toBe('exhausted');
  });

  it('does not spend the cap on a transient failure or a 429', async () => {
    (requestGroupKeyRewrap as jest.Mock)
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockRejectedValueOnce(
        new ApiError('Rate limited — try again shortly', 429, 'RATE_LIMITED', true),
      )
      .mockResolvedValue({ success: true });

    expect((await recoverDeadEnvelope(input())).outcome).toBe('failed');
    expect(await attemptAfterCooldown()).toBe('rate_limited');
    // Two attempts spent, zero committed — the cap is untouched.
    expect(await attemptAfterCooldown()).toBe('requested');
    expect(await attemptAfterCooldown()).toBe('requested');
    expect(await attemptAfterCooldown()).toBe('exhausted');
  });

  it('does not spend the cap on a refusal', async () => {
    (requestGroupKeyRewrap as jest.Mock)
      .mockRejectedValueOnce(refusal('NO_KEY_HOLDER'))
      .mockResolvedValue({ success: true });

    expect((await recoverDeadEnvelope(input())).outcome).toBe('refused');
    expect(await attemptAfterCooldown()).toBe('requested');
    expect(await attemptAfterCooldown()).toBe('requested');
    expect(await attemptAfterCooldown()).toBe('exhausted');
  });

  it('enforces the session cap across groups, below the server limiter', async () => {
    expect(SESSION_DEMOTE_CAP).toBe(4);

    for (const groupId of ['g1', 'g2', 'g3', 'g4']) {
      expect((await recoverDeadEnvelope(input({ groupId }))).outcome).toBe('requested');
    }

    const r = await recoverDeadEnvelope(input({ groupId: 'g5' }));
    expect(r.outcome).toBe('exhausted');
    expect(requestGroupKeyRewrap).toHaveBeenCalledTimes(SESSION_DEMOTE_CAP);
  });
});

// ---------------------------------------------------------------------------
// Single-flight and reset
// ---------------------------------------------------------------------------

describe('single-flight', () => {
  it('shares one attempt between concurrent callers on the same group', async () => {
    let release: (v: { success: boolean }) => void = () => {};
    (requestGroupKeyRewrap as jest.Mock).mockReturnValue(
      new Promise<{ success: boolean }>(res => {
        release = res;
      }),
    );

    const a = recoverDeadEnvelope(input());
    const b = recoverDeadEnvelope(input());
    release({ success: true });

    expect((await a).outcome).toBe('requested');
    expect((await b).outcome).toBe('requested');
    expect(requestGroupKeyRewrap).toHaveBeenCalledTimes(1);
    expect(probeIdentityKeyPair).toHaveBeenCalledTimes(1);
  });

  it('releases the slot once settled', async () => {
    await recoverDeadEnvelope(input());
    now += RECOVERY_COOLDOWN_MS + 1;

    const r = await recoverDeadEnvelope(input());

    expect(r.outcome).toBe('requested');
    expect(requestGroupKeyRewrap).toHaveBeenCalledTimes(2);
  });
});

describe('resetGroupKeyRecoveryState', () => {
  it('clears cooldowns, caps and both latches', async () => {
    (probeIdentityKeyPair as jest.Mock).mockReturnValueOnce('mismatch');
    expect((await recoverDeadEnvelope(input())).outcome).toBe('blocked_local_key');

    (requestGroupKeyRewrap as jest.Mock).mockRejectedValueOnce(new NotFoundError());
    resetGroupKeyRecoveryState();
    expect((await recoverDeadEnvelope(input())).outcome).toBe('unsupported');

    resetGroupKeyRecoveryState();
    // No cooldown, no latch, no spent cap.
    expect((await recoverDeadEnvelope(input())).outcome).toBe('requested');
  });
});
