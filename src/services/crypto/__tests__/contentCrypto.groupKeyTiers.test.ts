/**
 * Tests for getOrFetchGroupKey's tier ladder and its tier-4 self-heal hook.
 *
 * These are the first tests of the ladder itself, and the ordering is the
 * security property: tiers 1-3 must be tried first, so the self-heal can never
 * demote a server row while this device still holds a usable key. The hook also
 * has to stay invisible to non-key failures — a database error or a bug must
 * come out of here unchanged.
 *
 * `groupKeyRecovery` is mocked so each outcome can be driven directly; its own
 * state machine is covered in groupKeyRecovery.test.ts.
 */

jest.mock('orbital-signal', () => ({
  aesGcmEncrypt: jest.fn(),
  aesGcmDecrypt: jest.fn(),
  eciesSeal: jest.fn(() => new ArrayBuffer(190)),
  eciesOpen: jest.fn(() => new ArrayBuffer(32)),
}));

jest.mock('../../../database/repositories/conversationRepository', () => ({
  getGroupMasterKey: jest.fn(),
  setGroupMasterKey: jest.fn(),
  clearGroupMasterKey: jest.fn(),
}));

jest.mock('../../api/groups', () => ({
  getGroupKey: jest.fn(),
}));

jest.mock('../groupKeyRecovery', () => ({
  recoverDeadEnvelope: jest.fn(),
  resetGroupKeyRecoveryState: jest.fn(),
}));

jest.mock('../identityKeyAccess', () => ({
  getIdentityKeyPair: jest.fn(() => ({
    privateKey: new ArrayBuffer(32),
    publicKey: new ArrayBuffer(33),
  })),
  resolveRemoteIdentityKey: jest.fn(() => Promise.resolve(new ArrayBuffer(33))),
}));

jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: {
    getState: jest.fn(() => ({ userId: 'me' })),
  },
}));

import { eciesOpen } from 'orbital-signal';
import { getGroupMasterKey } from '../../../database/repositories/conversationRepository';
import { getGroupKey } from '../../api/groups';
import { recoverDeadEnvelope, resetGroupKeyRecoveryState } from '../groupKeyRecovery';
import {
  getOrFetchGroupKey,
  clearGroupKeyCache,
  clearContentCryptoInflight,
  setCachedGroupKey,
  persistGroupKey,
  PendingWrapError,
} from '../contentCrypto';
import {
  GroupKeyUnwrapError,
  setGroupKeyFailureReporter,
  isGroupKeyUnwrapError,
  isStalePendingError,
  PENDING_WRAP_BOUND_MS,
} from '../groupKeyErrors';
import {
  notePendingWrap,
  _getPendingWrapMirrorForTesting as pendingWrapMirror,
} from '../pendingWrapClock';
import { setWrapDeliveryDedupClearer } from '../wrapDeliveryHook';
import { arrayBufferToBase64 } from '../utils';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GROUP = 'group-1';
const PEER = 'peer-user';

/** A well-formed ECIES envelope: 190 bytes, version byte 0x02. */
const ENVELOPE = (() => {
  const bytes = new Uint8Array(190);
  bytes[0] = 0x02;
  bytes.fill(0x33, 1);
  return arrayBufferToBase64(bytes.buffer);
})();

const DEAD_ENVELOPE_ERROR = (() => {
  const err = new Error('SignalError.InvalidMessage');
  Object.assign(err, {
    tag: 'InvalidMessage',
    inner: { reason: 'ecies_open: decryption failed' },
  });
  return err;
})();

const reported: Array<{ groupId: string; error: GroupKeyUnwrapError }> = [];
const dedupCleared: string[] = [];

beforeEach(() => {
  clearGroupKeyCache();
  clearContentCryptoInflight();
  jest.clearAllMocks();
  reported.length = 0;
  dedupCleared.length = 0;
  setGroupKeyFailureReporter({
    report: (groupId, error) => {
      reported.push({ groupId, error });
    },
    reset: () => {},
  });
  setWrapDeliveryDedupClearer(groupId => {
    dedupCleared.push(groupId);
  });
  (getGroupMasterKey as jest.Mock).mockReturnValue(null);
  (getGroupKey as jest.Mock).mockResolvedValue({
    wrappedGroupKey: ENVELOPE,
    wrappedBy: PEER,
  });
  (eciesOpen as jest.Mock).mockImplementation(() => {
    throw DEAD_ENVELOPE_ERROR;
  });
});

afterEach(() => {
  setGroupKeyFailureReporter(null);
  setWrapDeliveryDedupClearer(null);
});

// ---------------------------------------------------------------------------
// Tiers 1-3 come first
// ---------------------------------------------------------------------------

describe('tier precedence', () => {
  it('returns the in-memory key without touching the network', async () => {
    const cached = new Uint8Array(32).fill(1);
    setCachedGroupKey(GROUP, cached);

    await expect(getOrFetchGroupKey(GROUP)).resolves.toBe(cached);
    expect(getGroupKey).not.toHaveBeenCalled();
    expect(recoverDeadEnvelope).not.toHaveBeenCalled();
  });

  it('a persisted key wins over the API, and no recovery runs', async () => {
    const persisted = new Uint8Array(32).fill(2);
    (getGroupMasterKey as jest.Mock).mockReturnValue(persisted);

    await expect(getOrFetchGroupKey(GROUP)).resolves.toEqual(persisted);
    expect(getGroupKey).not.toHaveBeenCalled();
    expect(recoverDeadEnvelope).not.toHaveBeenCalled();
    expect(reported).toHaveLength(0);
  });

  it('a null server key is a pending wrap, not a dead envelope', async () => {
    (getGroupKey as jest.Mock).mockResolvedValue({
      wrappedGroupKey: null,
      wrappedBy: null,
    });

    await expect(getOrFetchGroupKey(GROUP)).rejects.toBeInstanceOf(PendingWrapError);
    expect(recoverDeadEnvelope).not.toHaveBeenCalled();
    expect(reported).toHaveLength(0);
  });

  it('keeps the unattributed-envelope branch out of recovery', async () => {
    (getGroupKey as jest.Mock).mockResolvedValue({
      wrappedGroupKey: ENVELOPE,
      wrappedBy: null,
    });

    await expect(getOrFetchGroupKey(GROUP)).rejects.toThrow(
      'ECIES envelope requires sender identity',
    );
    expect(recoverDeadEnvelope).not.toHaveBeenCalled();

    // And it still marks the group pending for the TTL.
    await expect(getOrFetchGroupKey(GROUP)).rejects.toBeInstanceOf(PendingWrapError);
  });
});

// ---------------------------------------------------------------------------
// Tier 4 — the self-heal hook
// ---------------------------------------------------------------------------

describe('tier 4 — hook inputs', () => {
  it('passes the classified code and the untouched envelope', async () => {
    (recoverDeadEnvelope as jest.Mock).mockResolvedValue({
      outcome: 'failed',
      code: 'recipient_mismatch',
    });

    await expect(getOrFetchGroupKey(GROUP)).rejects.toBeTruthy();

    expect(recoverDeadEnvelope).toHaveBeenCalledTimes(1);
    const arg = (recoverDeadEnvelope as jest.Mock).mock.calls[0][0];
    expect(arg.groupId).toBe(GROUP);
    expect(arg.envelope).toBe(ENVELOPE);
    expect(arg.wrappedBy).toBe(PEER);
    expect(arg.code).toBe('recipient_mismatch');
    expect(typeof arg.retryUnwrap).toBe('function');
  });

  /**
   * The rule the module header states twice: `retryUnwrap` MUST close over
   * `processReceivedGroupKey`, never `getOrFetchGroupKey`. Recovery runs INSIDE
   * the in-flight promise that `getOrFetchGroupKey` is holding, so re-entering
   * it self-awaits and hangs forever — the one bug in this path that no outcome
   * test can see, because it manifests as a promise that never settles.
   *
   * So the real captured closure is invoked here rather than asserted about.
   * `getGroupKey` is the discriminator: a re-entrant implementation falls
   * through tiers 1-3 (nothing is cached — the unwrap failed) and fetches
   * again, while the correct one only re-unwraps the envelope it was handed.
   */
  it('hands recovery a retryUnwrap that re-unwraps without re-entering getOrFetchGroupKey', async () => {
    let captured: (() => Promise<Uint8Array | null>) | null = null;
    (recoverDeadEnvelope as jest.Mock).mockImplementation(
      async (arg: { retryUnwrap: () => Promise<Uint8Array | null> }) => {
        captured = arg.retryUnwrap;
        return { outcome: 'failed', code: 'recipient_mismatch' };
      },
    );

    await getOrFetchGroupKey(GROUP).catch(() => {});
    expect(typeof captured).toBe('function');

    // Now let the unwrap succeed, as it would after a sender-key refresh.
    const recovered = new Uint8Array(32).fill(4);
    (getGroupKey as jest.Mock).mockClear();
    (eciesOpen as jest.Mock).mockClear();
    (eciesOpen as jest.Mock).mockImplementation(() => recovered.buffer);

    const key = await (captured as unknown as () => Promise<Uint8Array | null>)();

    expect(key).toEqual(recovered);
    // processReceivedGroupKey ran exactly once (its only ECIES call)…
    expect(eciesOpen).toHaveBeenCalledTimes(1);
    // …and getOrFetchGroupKey did not: no second fetch, no re-entry.
    expect(getGroupKey).not.toHaveBeenCalled();
  });

  it('rethrows a non-SignalError untouched', async () => {
    const bug = new Error('database is locked');
    (eciesOpen as jest.Mock).mockImplementation(() => {
      throw bug;
    });

    await expect(getOrFetchGroupKey(GROUP)).rejects.toBe(bug);
    expect(recoverDeadEnvelope).not.toHaveBeenCalled();
    expect(reported).toHaveLength(0);
  });
});

describe('tier 4 — requested', () => {
  beforeEach(() => {
    (recoverDeadEnvelope as jest.Mock).mockResolvedValue({
      outcome: 'requested',
      code: 'recipient_mismatch',
    });
  });

  it('throws PendingWrapError, not the unwrap error', async () => {
    await expect(getOrFetchGroupKey(GROUP)).rejects.toBeInstanceOf(PendingWrapError);
  });

  it('reports the outcome once, with no envelope or id in the error', async () => {
    await getOrFetchGroupKey(GROUP).catch(() => {});

    expect(reported).toHaveLength(1);
    expect(reported[0].groupId).toBe(GROUP);
    expect(reported[0].error.code).toBe('recipient_mismatch');
    expect(reported[0].error.selfHeal).toBe('requested');
    expect(reported[0].error.message).toBe(
      'Group key unwrap failed: recipient_mismatch / requested',
    );
  });

  it('clears the WS delivery dedup so the re-wrap event is processed', async () => {
    await getOrFetchGroupKey(GROUP).catch(() => {});

    expect(dedupCleared).toEqual([GROUP]);
  });

  it('short-circuits the next call without refetching or re-recovering', async () => {
    await getOrFetchGroupKey(GROUP).catch(() => {});

    await expect(getOrFetchGroupKey(GROUP)).rejects.toBeInstanceOf(PendingWrapError);
    expect(getGroupKey).toHaveBeenCalledTimes(1);
    expect(recoverDeadEnvelope).toHaveBeenCalledTimes(1);
    expect(reported).toHaveLength(1);
  });
});

describe('tier 4 — not healed', () => {
  it('throws a GroupKeyUnwrapError carrying the outcome and refusal code', async () => {
    (recoverDeadEnvelope as jest.Mock).mockResolvedValue({
      outcome: 'refused',
      code: 'recipient_mismatch',
      refusalCode: 'NO_KEY_HOLDER',
    });

    const err = await getOrFetchGroupKey(GROUP).catch((e: unknown) => e);

    expect(isGroupKeyUnwrapError(err)).toBe(true);
    const failure = err as GroupKeyUnwrapError;
    expect(failure.selfHeal).toBe('refused');
    expect(failure.code).toBe('recipient_mismatch');
    expect(failure.refusalCode).toBe('NO_KEY_HOLDER');
    expect(reported).toHaveLength(1);
    expect(reported[0].error).toBe(failure);
  });

  it('does not clear the delivery dedup when nothing was requested', async () => {
    (recoverDeadEnvelope as jest.Mock).mockResolvedValue({
      outcome: 'exhausted',
      code: 'recipient_mismatch',
    });

    await getOrFetchGroupKey(GROUP).catch(() => {});

    expect(dedupCleared).toEqual([]);
  });

  it('reports a reclassified code rather than the original', async () => {
    (recoverDeadEnvelope as jest.Mock).mockResolvedValue({
      outcome: 'failed',
      code: 'sender_mismatch',
    });

    await getOrFetchGroupKey(GROUP).catch(() => {});

    expect(reported[0].error.code).toBe('sender_mismatch');
  });

  it('does not mark the group pending, so a later retry is allowed', async () => {
    (recoverDeadEnvelope as jest.Mock).mockResolvedValue({
      outcome: 'failed',
      code: 'recipient_mismatch',
    });

    await getOrFetchGroupKey(GROUP).catch(() => {});
    await getOrFetchGroupKey(GROUP).catch(() => {});

    expect(getGroupKey).toHaveBeenCalledTimes(2);
  });
});

describe('tier 4 — healed', () => {
  it('resolves the ORIGINAL in-flight promise from the recovered key', async () => {
    const recovered = new Uint8Array(32).fill(7);
    (recoverDeadEnvelope as jest.Mock).mockImplementation(async () => {
      // Stands in for the recovery's own retryUnwrap, which populates the
      // cache through processReceivedGroupKey.
      setCachedGroupKey(GROUP, recovered);
      return { outcome: 'healed', code: 'sender_mismatch' };
    });

    await expect(getOrFetchGroupKey(GROUP)).resolves.toBe(recovered);
    expect(getGroupKey).toHaveBeenCalledTimes(1);
    expect(reported).toHaveLength(0);
    expect(dedupCleared).toEqual([]);
  });

  it('still fails loudly if a healed recovery left no key behind', async () => {
    (recoverDeadEnvelope as jest.Mock).mockResolvedValue({
      outcome: 'healed',
      code: 'sender_mismatch',
    });

    await expect(getOrFetchGroupKey(GROUP)).rejects.toThrow(
      'Group key not available after processing',
    );
  });
});

describe('tier 4 — concurrency and teardown', () => {
  it('coalesces concurrent callers onto one fetch and one recovery', async () => {
    (recoverDeadEnvelope as jest.Mock).mockResolvedValue({
      outcome: 'requested',
      code: 'recipient_mismatch',
    });

    const results = await Promise.allSettled([
      getOrFetchGroupKey(GROUP),
      getOrFetchGroupKey(GROUP),
      getOrFetchGroupKey(GROUP),
    ]);

    expect(results.every(r => r.status === 'rejected')).toBe(true);
    expect(getGroupKey).toHaveBeenCalledTimes(1);
    expect(recoverDeadEnvelope).toHaveBeenCalledTimes(1);
    expect(reported).toHaveLength(1);
  });

  it('clearContentCryptoInflight resets the recovery state too', () => {
    clearContentCryptoInflight();

    expect(resetGroupKeyRecoveryState).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The 24h pending-wrap bound (#937)
// ---------------------------------------------------------------------------

/**
 * The bound is read through the real `pendingWrapClock`, not a mock: the thing
 * worth pinning is that the clock is STARTED and READ at the same three throw
 * sites, and a mocked clock would let those drift apart. MMKV is unreachable in
 * this suite (its Nitro host is absent), so the clock runs memory-only — which
 * is itself the degraded path the module is built for.
 */
describe('pending-wrap bound', () => {
  const T0 = Date.UTC(2026, 5, 1);
  let now = T0;

  beforeEach(() => {
    now = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A valid 32-byte key, base64 — what the API hands `persistGroupKey`. */
  const KEY_B64 = arrayBufferToBase64(new Uint8Array(32).fill(5).buffer);

  describe('throw sites', () => {
    it('bounds the 30-second short-circuit', async () => {
      (getGroupKey as jest.Mock).mockResolvedValue({
        wrappedGroupKey: null,
        wrappedBy: null,
      });

      // The clock starts here.
      await expect(getOrFetchGroupKey(GROUP)).rejects.toBeInstanceOf(PendingWrapError);
      // Just inside the bound: still hopeful, and the TTL is re-stamped…
      now = T0 + PENDING_WRAP_BOUND_MS - 10_000;
      await expect(getOrFetchGroupKey(GROUP)).rejects.toBeInstanceOf(PendingWrapError);

      // …so this read is inside the TTL and past the bound: it never reaches
      // the network, and the short-circuit itself has to report the verdict.
      now = T0 + PENDING_WRAP_BOUND_MS;
      const err = await getOrFetchGroupKey(GROUP).catch((e: unknown) => e);

      expect(isStalePendingError(err)).toBe(true);
      expect((err as GroupKeyUnwrapError).code).toBe('no_envelope');
      expect(getGroupKey).toHaveBeenCalledTimes(2);
    });

    it('re-raises the stamping cause, not a hard-coded one', async () => {
      // The TTL stamped by the self-heal's `requested` carries the CLASSIFIED
      // code, so the short-circuit must not report `no_envelope` for it.
      (recoverDeadEnvelope as jest.Mock).mockResolvedValue({
        outcome: 'requested',
        code: 'sender_mismatch',
      });

      await getOrFetchGroupKey(GROUP).catch(() => {});
      now = T0 + PENDING_WRAP_BOUND_MS - 10_000;
      await getOrFetchGroupKey(GROUP).catch(() => {});

      // Inside the re-stamped TTL and past the bound: the short-circuit answers.
      now = T0 + PENDING_WRAP_BOUND_MS;
      const err = await getOrFetchGroupKey(GROUP).catch((e: unknown) => e);

      expect(isStalePendingError(err)).toBe(true);
      expect((err as GroupKeyUnwrapError).code).toBe('sender_mismatch');
      expect(getGroupKey).toHaveBeenCalledTimes(2);
    });

    it('bounds a null server envelope', async () => {
      (getGroupKey as jest.Mock).mockResolvedValue({
        wrappedGroupKey: null,
        wrappedBy: null,
      });

      await expect(getOrFetchGroupKey(GROUP)).rejects.toBeInstanceOf(PendingWrapError);

      now = T0 + PENDING_WRAP_BOUND_MS;
      const err = await getOrFetchGroupKey(GROUP).catch((e: unknown) => e);

      expect(isStalePendingError(err)).toBe(true);
      expect((err as GroupKeyUnwrapError).code).toBe('no_envelope');
      // The server is still asked on every call — the bound only changes which
      // error comes back, so a key that does arrive is still picked up.
      expect(getGroupKey).toHaveBeenCalledTimes(2);
    });

    it('bounds a successful demote request, carrying the classified code', async () => {
      (recoverDeadEnvelope as jest.Mock).mockResolvedValue({
        outcome: 'requested',
        code: 'recipient_mismatch',
      });

      await expect(getOrFetchGroupKey(GROUP)).rejects.toBeInstanceOf(PendingWrapError);

      now = T0 + PENDING_WRAP_BOUND_MS;
      const err = await getOrFetchGroupKey(GROUP).catch((e: unknown) => e);

      expect(isStalePendingError(err)).toBe(true);
      expect((err as GroupKeyUnwrapError).code).toBe('recipient_mismatch');
    });

    it('still stamps the cache and clears the dedup past the bound', async () => {
      (recoverDeadEnvelope as jest.Mock).mockResolvedValue({
        outcome: 'requested',
        code: 'recipient_mismatch',
      });

      await getOrFetchGroupKey(GROUP).catch(() => {});
      now = T0 + PENDING_WRAP_BOUND_MS;
      await getOrFetchGroupKey(GROUP).catch(() => {});

      // The demote DID happen, so the delivery path stays open…
      expect(dedupCleared).toEqual([GROUP, GROUP]);
      // …and the 30s short-circuit is stamped, so the next read is cheap.
      await getOrFetchGroupKey(GROUP).catch(() => {});
      expect(getGroupKey).toHaveBeenCalledTimes(2);
    });

    it('emits ONE event per read: the stale verdict replaces the requested one', async () => {
      (recoverDeadEnvelope as jest.Mock).mockResolvedValue({
        outcome: 'requested',
        code: 'recipient_mismatch',
      });

      await getOrFetchGroupKey(GROUP).catch(() => {});
      now = T0 + PENDING_WRAP_BOUND_MS;
      await getOrFetchGroupKey(GROUP).catch(() => {});

      expect(reported.map(r => r.error.selfHeal)).toEqual(['requested', 'stale_pending']);
    });
  });

  describe('the invariant: a group with a usable key has no entry', () => {
    it('is restored by persistGroupKey (the invite-join path)', () => {
      notePendingWrap(GROUP, now);

      persistGroupKey(GROUP, KEY_B64);

      expect(pendingWrapMirror()).toEqual({});
    });

    it('is restored by setCachedGroupKey (the self-wrap path)', () => {
      notePendingWrap(GROUP, now);

      setCachedGroupKey(GROUP, new Uint8Array(32).fill(6));

      expect(pendingWrapMirror()).toEqual({});
    });

    it('is restored by the tier-2 population', async () => {
      notePendingWrap(GROUP, now);
      (getGroupMasterKey as jest.Mock).mockReturnValue(new Uint8Array(32).fill(7));

      await expect(getOrFetchGroupKey(GROUP)).resolves.toBeTruthy();

      expect(pendingWrapMirror()).toEqual({});
    });

    it('is not disturbed for OTHER groups', () => {
      notePendingWrap(GROUP, now);
      notePendingWrap('group-2', now);

      setCachedGroupKey(GROUP, new Uint8Array(32).fill(6));

      expect(pendingWrapMirror()).toEqual({ 'group-2': now });
    });
  });

  it('clearContentCryptoInflight drops every clock', () => {
    notePendingWrap(GROUP, now);
    notePendingWrap('group-2', now);

    clearContentCryptoInflight();

    expect(pendingWrapMirror()).toEqual({});
  });
});
