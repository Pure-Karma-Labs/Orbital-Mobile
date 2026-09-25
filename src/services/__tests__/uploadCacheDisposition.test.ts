/**
 * Tests for the shared create-failure classifier (#724b).
 *
 * Both composers route their create-stage failures through this predicate, so
 * a drift here silently changes whether uploaded media is rolled back or kept.
 */

import { mayHaveCommitted } from '../media/uploadCacheDisposition';
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

describe('mayHaveCommitted', () => {
  it('treats a 409 as possibly committed', () => {
    // A create carrying already-attached media ids is near-proof the previous
    // call landed.
    expect(mayHaveCommitted(new ConflictError())).toBe(true);
  });

  it('treats a network failure or timeout as possibly committed', () => {
    expect(mayHaveCommitted(new NetworkError())).toBe(true);
  });

  it('treats a 5xx as possibly committed', () => {
    expect(mayHaveCommitted(new ServerError(500))).toBe(true);
    expect(mayHaveCommitted(new ServerError(503))).toBe(true);
  });

  it('treats pre-commit rejections as definitely not committed', () => {
    expect(mayHaveCommitted(new ValidationError(400))).toBe(false);
    expect(mayHaveCommitted(new ValidationError(422))).toBe(false);
    expect(mayHaveCommitted(new AuthError(401))).toBe(false);
    expect(mayHaveCommitted(new AuthError(403))).toBe(false);
    expect(mayHaveCommitted(new NotFoundError())).toBe(false);
    expect(mayHaveCommitted(new QuotaExceededError())).toBe(false);
  });

  it('treats a bare ApiError and non-API failures as not committed', () => {
    expect(mayHaveCommitted(new ApiError('boom', 418, 'TEAPOT', false))).toBe(false);
    expect(mayHaveCommitted(new Error('local crypto failed'))).toBe(false);
    expect(mayHaveCommitted('not an error')).toBe(false);
    expect(mayHaveCommitted(undefined)).toBe(false);
  });
});
