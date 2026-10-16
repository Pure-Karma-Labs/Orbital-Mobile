/**
 * Tests for blockedUserLabel — the one place a blocked user id becomes a label
 * (#908, extracted from BlockedUsersScreen's private `useBlockedUserRows`).
 *
 * These cases are deliberate PARITY cases with the private helper that used to
 * live in the screen: contacts beat `blockedUserProfiles`, profiles beat the
 * caller's fallback username, and an unresolvable id degrades to
 * `user-<first 8>` with NO `@` prefix (the #896 invariant — an id-derived label
 * must never be mistakable for a real handle). The non-string guard is kept
 * because the Blocked Users screen is the only way to undo a block.
 */

import { blockedUserLabel } from '../blockedUserLabel';
import type { Contact } from '../../types/store';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'u-1',
    username: 'alice',
    displayName: null,
    avatarPath: null,
    conversationIds: [],
    ...overrides,
  };
}

const userId = 'abcdef0123456789';

describe('blockedUserLabel — lookup order', () => {
  it('prefers the contacts entry over blockedUserProfiles and the fallback', () => {
    expect(
      blockedUserLabel(
        userId,
        { [userId]: makeContact({ id: userId, username: 'fromcontacts' }) },
        { [userId]: 'fromprofiles' },
        'fromfallback',
      ),
    ).toEqual({ label: '@fromcontacts', resolved: true });
  });

  it('prefers blockedUserProfiles over the fallback when there is no contact', () => {
    expect(blockedUserLabel(userId, {}, { [userId]: 'fromprofiles' }, 'fromfallback')).toEqual({
      label: '@fromprofiles',
      resolved: true,
    });
  });

  it('falls back to the caller-supplied username last', () => {
    expect(blockedUserLabel(userId, {}, {}, 'fromfallback')).toEqual({
      label: '@fromfallback',
      resolved: true,
    });
  });

  it('ignores a contact row whose username is null and keeps looking', () => {
    expect(
      blockedUserLabel(
        userId,
        { [userId]: makeContact({ id: userId, username: null }) },
        { [userId]: 'fromprofiles' },
      ),
    ).toEqual({ label: '@fromprofiles', resolved: true });
  });

  it('only resolves against the matching id, not any other blocked user', () => {
    expect(
      blockedUserLabel(
        userId,
        { 'other-id': makeContact({ id: 'other-id', username: 'someoneelse' }) },
        { 'other-id': 'someoneelse' },
      ),
    ).toEqual({ label: 'user-abcdef01', resolved: false });
  });

  it('tolerates undefined contacts and profiles maps (partial mocks)', () => {
    expect(blockedUserLabel(userId, undefined, undefined, 'fromfallback')).toEqual({
      label: '@fromfallback',
      resolved: true,
    });
  });
});

describe('blockedUserLabel — the @-prefix invariant (#896)', () => {
  it('renders an unresolvable id as user-<first 8> with no @ prefix', () => {
    const result = blockedUserLabel(userId, {}, {});
    expect(result).toEqual({ label: 'user-abcdef01', resolved: false });
    expect(result.label.startsWith('@')).toBe(false);
  });

  it('applies the @ itself when resolved, so callers never compose one', () => {
    const result = blockedUserLabel(userId, {}, { [userId]: 'alice' });
    expect(result.label).toBe('@alice');
    expect(result.resolved).toBe(true);
  });

  it('does not pad an id shorter than 8 characters', () => {
    expect(blockedUserLabel('abc', {}, {})).toEqual({
      label: 'user-abc',
      resolved: false,
    });
  });
});

describe('blockedUserLabel — absent fallbacks', () => {
  it('treats an empty-string fallback as absent', () => {
    expect(blockedUserLabel(userId, {}, {}, '')).toEqual({
      label: 'user-abcdef01',
      resolved: false,
    });
  });

  it('treats a null fallback as absent', () => {
    expect(blockedUserLabel(userId, {}, {}, null)).toEqual({
      label: 'user-abcdef01',
      resolved: false,
    });
  });

  it('treats an omitted fallback as absent', () => {
    expect(blockedUserLabel(userId, {}, {})).toEqual({
      label: 'user-abcdef01',
      resolved: false,
    });
  });
});

describe('blockedUserLabel — corrupt persisted entries', () => {
  it('returns "Unknown user" for a non-string id instead of throwing in .slice', () => {
    // A corrupt persisted blockedUserIds entry: the store's type says string,
    // so the guard is only reachable through a deliberate cast.
    const corrupt = 12345 as unknown as string;
    expect(() => blockedUserLabel(corrupt, {}, {})).not.toThrow();
    expect(blockedUserLabel(corrupt, {}, {})).toEqual({
      label: 'Unknown user',
      resolved: false,
    });
  });

  it('guards a non-string id even when a fallback username is supplied', () => {
    const corrupt = { nope: true } as unknown as string;
    expect(blockedUserLabel(corrupt, {}, {}, 'fromfallback')).toEqual({
      label: 'Unknown user',
      resolved: false,
    });
  });

  it('guards null and undefined ids', () => {
    const nullId = null as unknown as string;
    const undefinedId = undefined as unknown as string;
    expect(blockedUserLabel(nullId, {}, {})).toEqual({
      label: 'Unknown user',
      resolved: false,
    });
    expect(blockedUserLabel(undefinedId, {}, {})).toEqual({
      label: 'Unknown user',
      resolved: false,
    });
  });
});
