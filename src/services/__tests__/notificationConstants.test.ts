import { resolveAnchor, dedupKeyForPayload, NOTIFICATION_TITLES, ANDROID_CHANNEL_ID, ANDROID_CHANNEL_NAME } from '../notificationConstants';

// ---------------------------------------------------------------------------
// resolveAnchor
// ---------------------------------------------------------------------------

describe('resolveAnchor', () => {
  it('resolves new_thread with tid', () => {
    expect(resolveAnchor({ t: 'new_thread', gid: 'g1', tid: 't1', v: '1' }))
      .toEqual({ type: 'thread', threadId: 't1' });
  });

  it('resolves new_reply with tid and rid', () => {
    expect(resolveAnchor({ t: 'new_reply', gid: 'g1', tid: 't1', rid: 'r1', v: '1' }))
      .toEqual({ type: 'thread', threadId: 't1', targetReplyId: 'r1' });
  });

  it('resolves new_reply without rid (scroll to thread, no highlight)', () => {
    const result = resolveAnchor({ t: 'new_reply', gid: 'g1', tid: 't1', v: '1' });
    expect(result).toEqual({ type: 'thread', threadId: 't1', targetReplyId: undefined });
  });

  it('resolves new_dm with gid', () => {
    expect(resolveAnchor({ t: 'new_dm', gid: 'g1', v: '1' }))
      .toEqual({ type: 'chat', conversationId: 'g1' });
  });

  it('resolves orbit_invite with code', () => {
    expect(resolveAnchor({ t: 'orbit_invite', code: 'abc123', v: '1' }))
      .toEqual({ type: 'joinOrbit', code: 'abc123' });
  });

  it('resolves member_joined to threadsList', () => {
    expect(resolveAnchor({ t: 'member_joined', gid: 'g1', v: '1' }))
      .toEqual({ type: 'threadsList' });
  });

  it('resolves identity_key_reset to settings', () => {
    expect(resolveAnchor({ t: 'identity_key_reset', v: '1' }))
      .toEqual({ type: 'settings' });
  });

  it('returns null for missing type field', () => {
    expect(resolveAnchor({ gid: 'g1' })).toBeNull();
  });

  it('returns null for empty tid on new_thread', () => {
    expect(resolveAnchor({ t: 'new_thread', tid: '' })).toBeNull();
  });

  it('returns null for unknown type', () => {
    expect(resolveAnchor({ t: 'unknown_type' })).toBeNull();
  });

  it('returns null for new_thread missing tid entirely', () => {
    expect(resolveAnchor({ t: 'new_thread', gid: 'g1' })).toBeNull();
  });

  it('returns null for new_dm missing gid', () => {
    expect(resolveAnchor({ t: 'new_dm' })).toBeNull();
  });

  it('returns null for orbit_invite missing code', () => {
    expect(resolveAnchor({ t: 'orbit_invite' })).toBeNull();
  });

  it('returns null for new_reply missing tid', () => {
    expect(resolveAnchor({ t: 'new_reply', rid: 'r1' })).toBeNull();
  });

  it('returns null for tid exceeding 255 chars', () => {
    const longId = 'x'.repeat(256);
    expect(resolveAnchor({ t: 'new_thread', tid: longId })).toBeNull();
  });

  it('returns null for gid exceeding 255 chars on new_dm', () => {
    const longId = 'x'.repeat(256);
    expect(resolveAnchor({ t: 'new_dm', gid: longId })).toBeNull();
  });

  it('returns null for code exceeding 255 chars on orbit_invite', () => {
    const longCode = 'x'.repeat(256);
    expect(resolveAnchor({ t: 'orbit_invite', code: longCode })).toBeNull();
  });

  it('ignores rid exceeding 255 chars on new_reply (still resolves thread)', () => {
    const longRid = 'x'.repeat(256);
    const result = resolveAnchor({ t: 'new_reply', tid: 't1', rid: longRid });
    expect(result).toEqual({ type: 'thread', threadId: 't1', targetReplyId: undefined });
  });
});

// ---------------------------------------------------------------------------
// dedupKeyForPayload
// ---------------------------------------------------------------------------

describe('dedupKeyForPayload', () => {
  it('generates thread key for new_thread', () => {
    expect(dedupKeyForPayload({ t: 'new_thread', tid: 't1' })).toBe('thread:t1');
  });

  it('generates reply key for new_reply', () => {
    expect(dedupKeyForPayload({ t: 'new_reply', rid: 'r1', tid: 't1' })).toBe('reply:r1');
  });

  it('skips dedup for new_dm (would collapse sequential DMs)', () => {
    expect(dedupKeyForPayload({ t: 'new_dm', gid: 'g1' })).toBeNull();
  });

  it('generates invite key for orbit_invite', () => {
    expect(dedupKeyForPayload({ t: 'orbit_invite', code: 'abc' })).toBe('invite:abc');
  });

  it('returns null for member_joined (no unique event ID)', () => {
    expect(dedupKeyForPayload({ t: 'member_joined', gid: 'g1' })).toBeNull();
  });

  it('returns null for new_thread missing tid', () => {
    expect(dedupKeyForPayload({ t: 'new_thread' })).toBeNull();
  });

  it('returns null for new_reply missing rid', () => {
    expect(dedupKeyForPayload({ t: 'new_reply', tid: 't1' })).toBeNull();
  });

  it('returns null for unknown type', () => {
    expect(dedupKeyForPayload({ t: 'foobar' })).toBeNull();
  });

  it('returns null for identity_key_reset (no unique event ID)', () => {
    expect(dedupKeyForPayload({ t: 'identity_key_reset', v: '1' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('shared constants', () => {
  it('exports all expected notification titles', () => {
    expect(NOTIFICATION_TITLES).toHaveProperty('new_thread');
    expect(NOTIFICATION_TITLES).toHaveProperty('new_reply');
    expect(NOTIFICATION_TITLES).toHaveProperty('new_dm');
    expect(NOTIFICATION_TITLES).toHaveProperty('orbit_invite');
    expect(NOTIFICATION_TITLES).toHaveProperty('member_joined');
    expect(NOTIFICATION_TITLES).toHaveProperty('identity_key_reset', 'Security alert');
    expect(Object.keys(NOTIFICATION_TITLES)).toHaveLength(6);
  });

  it('exports Android channel constants', () => {
    expect(ANDROID_CHANNEL_ID).toBe('orbital-default');
    expect(ANDROID_CHANNEL_NAME).toBe('Orbital');
  });
});
