import {
  ApiError,
  AuthError,
  NetworkError,
  NotFoundError,
  ServerError,
  ValidationError,
} from '../../services/api/errors';
import { routeInviteCreateError } from '../inviteCreateErrors';

// Copy is pinned as literals, never imported from the module under test, so a
// wording change shows up here as a diff.
const GENERIC = 'Failed to generate invite code. Please try again.';
const NOT_ALLOWED = "You can't create invites for this orbit";
const ORBIT_GONE = 'This orbit no longer exists';
const RATE_LIMITED = 'Too many attempts — please wait a few minutes and try again';
const BAD_EMAIL = 'Please enter a valid email address';
// #912: every group-key failure is routed through `groupKeyFailureCopy`, so
// this route shows the composers' wording for the actual outcome. Pinned here
// as literals too, never imported from errorMessages.
const RESENDING =
  "This conversation's encryption key is being re-sent by another member. Please try again in a moment.";
const UNREADABLE =
  "This device can't open this conversation's encryption key. Another member needs to open Orbital to re-send it.";
const RETRY_LATER =
  "Couldn't recover this conversation's encryption key right now. Please try again in a few minutes.";
const DEVICE_KEY =
  "This device's encryption keys need to be restored before this conversation can be opened.";

function coded(code: string): ValidationError {
  return new ValidationError(
    400,
    JSON.stringify({ error: 'VALIDATION_ERROR', message: 'server text', details: { code } }),
  );
}

/** Mirrors contentCrypto's class: only the `name` is load-bearing here. */
function pendingWrap(): Error {
  const e = new Error('Group key wrap pending');
  e.name = 'PendingWrapError';
  return e;
}

/**
 * Mirrors `crypto/groupKeyErrors.GroupKeyUnwrapError` — built by hand for the
 * same reason the routing matches by name: importing the class would drag the
 * crypto module graph into this suite.
 */
function unwrapFailure(selfHeal: string): Error {
  const e = new Error(`Group key unwrap failed: recipient_mismatch / ${selfHeal}`);
  e.name = 'GroupKeyUnwrapError';
  (e as unknown as { selfHeal: string }).selfHeal = selfHeal;
  return e;
}

describe('routeInviteCreateError', () => {
  it.each([
    ['NetworkError → banner with its own message', new NetworkError(), { bannerError: 'Network error — please check your connection' }],
    ['RATE_LIMITED → banner', new ApiError('Too many requests', 429, 'RATE_LIMITED', false), { bannerError: RATE_LIMITED }],
    ['coded EMAIL_FORMAT → field error', coded('EMAIL_FORMAT'), { fieldError: BAD_EMAIL }],
    ['403 → permanent banner, no capture', new AuthError(403), { bannerError: NOT_ALLOWED }],
    ['404 → permanent banner, no capture', new NotFoundError(), { bannerError: ORBIT_GONE }],
    ['PendingWrapError → RESENDING banner, no capture', pendingWrap(), { bannerError: RESENDING }],
    // Each used to fall through to the generic banner WITH a capture: a second
    // Sentry event for a failure `groupKeyTelemetry` already reported, under
    // copy that invited a retry nothing would change (#912 PR review).
    ['a refused unwrap → UNREADABLE banner, no capture', unwrapFailure('refused'), { bannerError: UNREADABLE }],
    ['a failed unwrap → RETRY_LATER banner, no capture', unwrapFailure('failed'), { bannerError: RETRY_LATER }],
    ['an identity_mismatch unwrap → DEVICE_KEY banner, no capture', unwrapFailure('identity_mismatch'), { bannerError: DEVICE_KEY }],
  ])('%s', (_label, err, expected) => {
    // toEqual on the whole route: an unexpected captureTags (or a second slot)
    // fails here, which is what proves the "no capture" half of each row.
    expect(routeInviteCreateError(err)).toEqual(expected);
  });

  it('captures an uncoded 400 with the feature tag only', () => {
    expect(routeInviteCreateError(new ValidationError(400, 'not json'))).toEqual({
      bannerError: GENERIC,
      captureTags: { feature: 'orbit-invite-create' },
    });
  });

  it('flags an allowlisted reason this route does not route', () => {
    expect(routeInviteCreateError(coded('GROUP_FULL'))).toEqual({
      bannerError: GENERIC,
      captureTags: { feature: 'orbit-invite-create', validation_reason_routed: 'false' },
    });
  });

  it('does not flag a code the client allowlist does not know (parsed as no reason)', () => {
    expect(routeInviteCreateError(coded('SOME_FUTURE_CODE'))).toEqual({
      bannerError: GENERIC,
      captureTags: { feature: 'orbit-invite-create' },
    });
  });

  it.each([
    ['401', new AuthError(401)],
    ['5xx', new ServerError(503)],
    ['a local fault', new Error('identity key missing')],
    ['a non-Error throw', 'boom'],
  ])('captures %s on the generic banner', (_label, err) => {
    expect(routeInviteCreateError(err)).toEqual({
      bannerError: GENERIC,
      captureTags: { feature: 'orbit-invite-create' },
    });
  });

  it('never routes server text into either slot', () => {
    const route = routeInviteCreateError(coded('EMAIL_FORMAT'));
    expect(JSON.stringify(route)).not.toContain('server text');
  });
});

describe('the PendingWrapError contract', () => {
  it('routes by NAME, so a factory-mocked contentCrypto still gets the copy', () => {
    expect(routeInviteCreateError(pendingWrap())).toEqual({ bannerError: RESENDING });
  });

  it('stays in step with the producer: contentCrypto still assigns that exact name', () => {
    // Importing the class would drag MMKV/nitro into this suite (the reason the
    // predicate matches by name), so pin the producer side by source instead:
    // renaming the class's `name` without updating the predicate fails here.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../services/crypto/contentCrypto.ts'),
      'utf8',
    );
    expect(src).toMatch(/class PendingWrapError[\s\S]*?this\.name = 'PendingWrapError';/);
  });

  // A near miss must NOT reach the group-key copy: it falls through to the
  // generic banner, with the capture that goes with an unattributable failure.
  it.each([
    ['a plain Error', new Error('x')],
    ['a near-miss name', Object.assign(new Error('x'), { name: 'PendingWrap' })],
    ['a non-Error with the name', { name: 'PendingWrapError' }],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(routeInviteCreateError(value)).toEqual({
      bannerError: GENERIC,
      captureTags: { feature: 'orbit-invite-create' },
    });
  });
});
