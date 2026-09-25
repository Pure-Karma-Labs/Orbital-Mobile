/**
 * Tests for the shared create-failure classifier (#724b).
 *
 * Both composers route their create-stage failures through this predicate, so
 * a drift here silently changes whether uploaded media is rolled back, whether
 * the discard prompt appears, and which copy the user reads.
 */

import {
  classifyCreateFailure,
  dispositionForCreateFailure,
} from '../media/uploadCacheDisposition';
import {
  ApiError,
  AuthError,
  ConflictError,
  NetworkError,
  NotFoundError,
  QuotaExceededError,
  ServerError,
  ValidationError,
} from '../api/errors';

describe('classifyCreateFailure', () => {
  it('treats a 409 as committed', () => {
    // A create carrying already-attached media ids is near-proof the previous
    // call landed.
    expect(classifyCreateFailure(new ConflictError())).toBe('committed');
  });

  it('treats a network failure or timeout as maybe', () => {
    expect(classifyCreateFailure(new NetworkError())).toBe('maybe');
    expect(classifyCreateFailure(new NetworkError('fetch failed'))).toBe('maybe');
  });

  it('treats a rate-limit-backoff abort as definitely not committed', () => {
    // neverSent: the 429 that forced the backoff wrote nothing and the retry
    // was abandoned before it was issued. Without this the composer would flag
    // media as possibly-attached on a request that never left the device.
    expect(
      classifyCreateFailure(
        new NetworkError('Request aborted during rate-limit backoff', true),
      ),
    ).toBe('no');
  });

  it('treats a 5xx as maybe', () => {
    expect(classifyCreateFailure(new ServerError(500))).toBe('maybe');
    expect(classifyCreateFailure(new ServerError(503))).toBe('maybe');
  });

  it('treats pre-commit rejections as no', () => {
    expect(classifyCreateFailure(new ValidationError(400))).toBe('no');
    expect(classifyCreateFailure(new ValidationError(422))).toBe('no');
    expect(classifyCreateFailure(new AuthError(401))).toBe('no');
    expect(classifyCreateFailure(new AuthError(403))).toBe('no');
    expect(classifyCreateFailure(new NotFoundError())).toBe('no');
    expect(classifyCreateFailure(new QuotaExceededError())).toBe('no');
  });

  it('treats a bare ApiError and non-API failures as no', () => {
    expect(classifyCreateFailure(new ApiError('boom', 418, 'TEAPOT', false))).toBe('no');
    expect(classifyCreateFailure(new Error('local crypto failed'))).toBe('no');
    expect(classifyCreateFailure('not an error')).toBe('no');
    expect(classifyCreateFailure(undefined)).toBe('no');
  });
});

describe('dispositionForCreateFailure', () => {
  it('maps committed to the guard-silencing disposition', () => {
    expect(dispositionForCreateFailure('committed')).toBe('committed');
  });

  it('maps maybe to the disposition that KEEPS the discard prompt', () => {
    expect(dispositionForCreateFailure('maybe')).toBe('maybe-committed');
  });

  it('maps no to null — the cache is left untouched and rollback-eligible', () => {
    expect(dispositionForCreateFailure('no')).toBeNull();
  });
});
