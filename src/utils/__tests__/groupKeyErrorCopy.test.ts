import { GroupKeyUnwrapError, type SelfHealOutcome } from '../../services/crypto/groupKeyErrors';
import { groupKeyFailureCopy, isGroupKeyPending } from '../groupKeyErrorCopy';

// Copy is pinned as literals, never imported from errorMessages.ts, so a
// wording change shows up here as a diff (the inviteCreateErrors precedent).
const RESENDING =
  "This conversation's encryption key is being re-sent by another member. Please try again in a moment.";
const RETRY_LATER =
  "Couldn't recover this conversation's encryption key right now. Please try again in a few minutes.";
const UNREADABLE =
  "This device can't open this conversation's encryption key. Another member needs to open Orbital to re-send it.";
const DEVICE_KEY =
  "This device's encryption keys need to be restored before this conversation can be opened.";

const PENDING_TITLE = 'Not Sent Yet';
const NOT_SENT_TITLE = 'Not Sent';
const DEVICE_KEY_TITLE = 'Device Key Problem';

/**
 * Mirrors contentCrypto's class: only the `name` is load-bearing. Built by hand
 * rather than imported, because importing contentCrypto would drag
 * orbital-signal + MMKV/nitro into this suite — the very reason the selector
 * matches by name.
 */
function pendingWrap(): Error {
  const e = new Error('Group key wrap pending');
  e.name = 'PendingWrapError';
  return e;
}

/**
 * Every value of the SelfHealOutcome union. TRIPWIRE: this array is typed
 * `SelfHealOutcome[]`, and the last test asserts the it.each table below covers
 * exactly this set — so adding a value to the union without adding it here (or
 * to the table) fails, and a value that no longer exists fails to compile.
 */
const ALL_OUTCOMES: SelfHealOutcome[] = [
  'requested',
  'cooldown',
  'exhausted',
  'session_exhausted',
  'refused',
  'identity_mismatch',
  'unsupported',
  'rate_limited',
  'blocked_local_key',
  'not_eligible',
  'failed',
  'stale_pending',
];

/** [outcome, expected title, expected message] */
type OutcomeRow = [SelfHealOutcome, string, string];

const OUTCOME_TABLE: OutcomeRow[] = [
  ['rate_limited', NOT_SENT_TITLE, RETRY_LATER],
  ['failed', NOT_SENT_TITLE, RETRY_LATER],
  ['cooldown', NOT_SENT_TITLE, RETRY_LATER],
  // The SESSION budget is spent and this group was never demoted, so no peer
  // has been asked: UNREADABLE would blame someone who was never told. The caps
  // are per-session, so "in a few minutes" is true — a relaunch frees them.
  ['session_exhausted', NOT_SENT_TITLE, RETRY_LATER],
  ['identity_mismatch', DEVICE_KEY_TITLE, DEVICE_KEY],
  ['blocked_local_key', DEVICE_KEY_TITLE, DEVICE_KEY],
  ['refused', NOT_SENT_TITLE, UNREADABLE],
  ['unsupported', NOT_SENT_TITLE, UNREADABLE],
  // Per-group cap: a peer HAS been asked and has not delivered.
  ['exhausted', NOT_SENT_TITLE, UNREADABLE],
  ['not_eligible', NOT_SENT_TITLE, UNREADABLE],
  // Production never routes `requested` through this branch — contentCrypto
  // throws PendingWrapError for it — so the default UNREADABLE copy is correct.
  ['requested', NOT_SENT_TITLE, UNREADABLE],
  // `stale_pending` (#937): the 24h deadline passed without a wrap delivery.
  // The pending banner is gone (isGroupKeyPending returns false), and the copy
  // falls to UNREADABLE — blame goes to a peer who was asked but did not deliver.
  ['stale_pending', NOT_SENT_TITLE, UNREADABLE],
];

describe('isGroupKeyPending', () => {
  it('matches an Error whose name is exactly PendingWrapError', () => {
    expect(isGroupKeyPending(pendingWrap())).toBe(true);
  });

  it.each([
    ['a near-miss name', Object.assign(new Error('x'), { name: 'PendingWrap' })],
    ['a non-Error with the name', { name: 'PendingWrapError' }],
    ['null', null],
    ['undefined', undefined],
    ['a GroupKeyUnwrapError', new GroupKeyUnwrapError('recipient_mismatch', 'refused')],
    // `stale_pending` demotes the banner — the UI must NOT show "pending" for it.
    [
      'a stale_pending GroupKeyUnwrapError',
      new GroupKeyUnwrapError('recipient_mismatch', 'stale_pending'),
    ],
  ])('rejects %s', (_label, value) => {
    expect(isGroupKeyPending(value)).toBe(false);
  });
});

describe('groupKeyFailureCopy', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a plain Error', new Error('boom')],
    ['a TypeError', new TypeError('boom')],
    ['an object with no name', { selfHeal: 'refused', message: 'boom' }],
    ['a string', 'boom'],
  ])('returns null for %s', (_label, value) => {
    expect(groupKeyFailureCopy(value)).toBeNull();
  });

  it('maps PendingWrapError to the resending copy', () => {
    expect(groupKeyFailureCopy(pendingWrap())).toEqual({
      title: PENDING_TITLE,
      message: RESENDING,
    });
  });

  // toEqual on the whole object: an unexpected extra field fails here.
  it.each(OUTCOME_TABLE)('maps selfHeal %s to %s', (outcome, title, message) => {
    expect(groupKeyFailureCopy(new GroupKeyUnwrapError('recipient_mismatch', outcome))).toEqual({
      title,
      message,
    });
  });

  it.each([
    ['an outcome this build has never heard of', 'something-new'],
    ['no outcome at all', undefined],
    ['healed, which must never reach a screen', 'healed'],
  ])('falls back to the unreadable copy for %s', (_label, selfHeal) => {
    const err = {
      name: 'GroupKeyUnwrapError',
      message: 'Group key unwrap failed',
      selfHeal,
    } as unknown as GroupKeyUnwrapError;
    expect(groupKeyFailureCopy(err)).toEqual({
      title: NOT_SENT_TITLE,
      message: UNREADABLE,
    });
  });

  it('matches by name, not by class, so a factory-mocked shape still gets copy', () => {
    const mocked = {
      name: 'GroupKeyUnwrapError',
      selfHeal: 'refused',
      message: 'x',
    } as unknown as GroupKeyUnwrapError;
    expect(mocked).not.toBeInstanceOf(GroupKeyUnwrapError);
    expect(groupKeyFailureCopy(mocked)).toEqual({
      title: NOT_SENT_TITLE,
      message: UNREADABLE,
    });
  });

  it('covers every value of the SelfHealOutcome union', () => {
    // The union itself is the tripwire: ALL_OUTCOMES is typed SelfHealOutcome[],
    // so a value added to the union and not to this table fails this assertion,
    // and a value removed from the union stops ALL_OUTCOMES compiling.
    expect([...OUTCOME_TABLE.map(([outcome]) => outcome)].sort()).toEqual([...ALL_OUTCOMES].sort());
    expect(ALL_OUTCOMES).toHaveLength(12);
  });
});
