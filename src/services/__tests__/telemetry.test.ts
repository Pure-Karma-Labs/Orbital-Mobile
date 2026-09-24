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
