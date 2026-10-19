/**
 * Tests for telemetry.ts (#746) — the only approved capture path.
 *
 * What is pinned here is a privacy boundary, not an API: the object handed to
 * Sentry must never be the object the caller threw.
 */

jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
}));

import * as Sentry from '@sentry/react-native';
import { captureError } from '../telemetry';
import { ApiError, AuthError, QuotaExceededError } from '../api/errors';
import { GroupKeyUnwrapError } from '../crypto/groupKeyErrors';

const mockCapture = Sentry.captureException as unknown as jest.Mock;

/** The Error the module actually handed to Sentry. */
function capturedError(): Error {
  return mockCapture.mock.calls[0][0] as Error;
}

/** The CaptureContext the module attached. */
function capturedContext(): Record<string, unknown> {
  return mockCapture.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('captureError', () => {
  it('never forwards the thrower\'s own object or its custom fields', () => {
    const original = new QuotaExceededError(
      JSON.stringify({ error: 'QUOTA_EXCEEDED', details: { quota: { storage_bytes: 1 } } }),
    );

    captureError(original, { tags: { feature: 'media-upload' } });

    const reported = capturedError();
    expect(reported).not.toBe(original);
    expect((reported as unknown as { quota?: unknown }).quota).toBeUndefined();
    expect((reported as unknown as { serverMessage?: unknown }).serverMessage).toBeUndefined();
  });

  it('keeps the class name and drops serverMessage', () => {
    // serverMessage is populated only under __DEV__, which is where Jest runs
    // — so this is the exact condition under which a raw capture would leak
    // the server body.
    const original = new AuthError(401, 'the raw server internals');
    expect(original.serverMessage).toBe('the raw server internals');

    captureError(original);

    expect(capturedError().name).toBe('AuthError');
    expect(capturedError().message).toBe('Authentication required');
    expect(JSON.stringify(capturedError())).not.toContain('raw server internals');
    // ...and the auto-added ApiError facets still describe the failure.
    expect(capturedContext()).toEqual({ tags: { status: '401', api_code: 'AUTH_ERROR' } });
  });

  it('scrubs the message it reports', () => {
    captureError(new Error('copyFile failed: /var/mobile/tmp/IMG_1.jpg'));
    expect(capturedError().message).toBe('copyFile failed: <path>');
  });

  it('converts a non-Error rejection with String(e)', () => {
    captureError('just a string');
    expect(capturedError().name).toBe('Error');
    expect(capturedError().message).toBe('just a string');
  });

  it('adds status and api_code tags for an ApiError, so no call site has to', () => {
    captureError(new ApiError('Server error', 500, 'SERVER_ERROR', true), {
      tags: { feature: 'orbit-create' },
    });

    expect(capturedContext()).toEqual({
      tags: { feature: 'orbit-create', status: '500', api_code: 'SERVER_ERROR' },
    });
  });

  it('omits level, extra and tags when the caller passed none', () => {
    captureError(new Error('boom'));
    expect(capturedContext()).toEqual({});
  });

  it('passes through level, tags and extra', () => {
    captureError(new Error('boom'), {
      level: 'warning',
      tags: { feature: 'key-recovery' },
      extra: { step: 'local-wipe', attempt: 2 },
    });

    expect(capturedContext()).toEqual({
      level: 'warning',
      tags: { feature: 'key-recovery' },
      extra: { step: 'local-wipe', attempt: 2 },
    });
  });

  it('does not mutate the caller\'s tags object', () => {
    const tags = { feature: 'orbit-join' };
    captureError(new ApiError('nope', 404, 'NOT_FOUND', false), { tags });
    expect(tags).toEqual({ feature: 'orbit-join' });
  });
});

// ---------------------------------------------------------------------------
// Group-key unwrap failures (#912)
// ---------------------------------------------------------------------------

/**
 * `captureError` owns the three `group_key_*` tags so no call site can forget
 * them. What is pinned here is that they are a property of the ERROR CLASS:
 * an ordinary Error and an ApiError must get none of them, or the tags would
 * be describing the mock rather than the error.
 */
describe('captureError — group-key tags', () => {
  const GROUP_KEY_TAGS = ['group_key_code', 'group_key_self_heal', 'group_key_refusal'];

  /** Tag keys actually attached to the one captured event. */
  function capturedTagKeys(): string[] {
    const tags = capturedContext().tags as Record<string, string> | undefined;
    return tags === undefined ? [] : Object.keys(tags);
  }

  it('tags the failure code and the self-heal outcome, and omits the refusal tag', () => {
    captureError(new GroupKeyUnwrapError('recipient_mismatch', 'requested'));

    expect(capturedContext()).toEqual({
      tags: { group_key_code: 'recipient_mismatch', group_key_self_heal: 'requested' },
    });
    expect(capturedTagKeys()).not.toContain('group_key_refusal');
  });

  it('adds group_key_refusal only when the server refused with a coded 409', () => {
    captureError(new GroupKeyUnwrapError('recipient_mismatch', 'refused', 'ENVELOPE_CHANGED'));

    expect(capturedContext()).toEqual({
      tags: {
        group_key_code: 'recipient_mismatch',
        group_key_self_heal: 'refused',
        group_key_refusal: 'ENVELOPE_CHANGED',
      },
    });
  });

  it('keeps the class name and the enum-built message', () => {
    captureError(new GroupKeyUnwrapError('sender_mismatch', 'failed'));

    expect(capturedError().name).toBe('GroupKeyUnwrapError');
    expect(capturedError().message).toBe('Group key unwrap failed: sender_mismatch / failed');
  });

  it('merges the caller\'s own tags without being clobbered by them', () => {
    captureError(new GroupKeyUnwrapError('corrupt', 'not_eligible'), {
      level: 'warning',
      tags: { feature: 'group-key-self-heal' },
    });

    expect(capturedContext()).toEqual({
      level: 'warning',
      tags: {
        feature: 'group-key-self-heal',
        group_key_code: 'corrupt',
        group_key_self_heal: 'not_eligible',
      },
    });
  });

  // Negative control: the tags come from the error class, not from the mock.
  it('attaches none of the group-key tags to an ordinary Error', () => {
    captureError(new Error('boom'), { tags: { feature: 'orbit-create' } });

    expect(capturedContext()).toEqual({ tags: { feature: 'orbit-create' } });
    for (const tag of GROUP_KEY_TAGS) {
      expect(capturedTagKeys()).not.toContain(tag);
    }
  });

  // ...and an ApiError still gets exactly its own two facets, no more.
  it('leaves the ApiError facets alone and adds no group-key tags to one', () => {
    captureError(new ApiError('nope', 409, 'REWRAP_REFUSED', false));

    expect(capturedContext()).toEqual({
      tags: { status: '409', api_code: 'REWRAP_REFUSED' },
    });
    for (const tag of GROUP_KEY_TAGS) {
      expect(capturedTagKeys()).not.toContain(tag);
    }
  });

  // This layer never SEES a groupId — `captureError` takes the error alone —
  // so the assertion is a floor, not the boundary: the load-bearing version,
  // where a real groupId is passed in and must not escape, is
  // `groupKeyTelemetry.test.ts`. Kept here because a future tag added to this
  // block (a conversation id "for context") would trip it.
  it('sends no uuid-shaped identifier anywhere in the event', () => {
    captureError(new GroupKeyUnwrapError('recipient_mismatch', 'identity_mismatch'));

    expect(JSON.stringify(mockCapture.mock.calls)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });
});
