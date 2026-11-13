/**
 * Typed-error parsing contracts (#926).
 *
 * The parsers under test (`parseRetryAfterMs`, `parseImportRefusal`) are
 * module-private by design — `errors.ts` states that rule and all of its
 * parsers follow it — so they are driven THROUGH their classes:
 * `mapHttpErrorToApiError(429, …)` and `new ConflictError(rawBody)`. No export
 * is added for test convenience.
 */

import { mapHttpErrorToApiError } from '../client';
import {
  ApiError,
  ConflictError,
  RateLimitError,
  ValidationError,
  type HeaderReader,
} from '../errors';

/** A header bag with the given entries, case-insensitive like `Headers`. */
function headers(entries: Record<string, string>): HeaderReader {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) lower[k.toLowerCase()] = v;
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

/** The 429 under test, already narrowed. */
function rateLimited(h?: HeaderReader): RateLimitError {
  const e = mapHttpErrorToApiError(429, undefined, h);
  expect(e).toBeInstanceOf(RateLimitError);
  return e as RateLimitError;
}

// ---------------------------------------------------------------------------
// 429 → RateLimitError + Retry-After
// ---------------------------------------------------------------------------

describe('mapHttpErrorToApiError — 429', () => {
  it('maps to RateLimitError without changing the fields consumers route on', () => {
    const e = rateLimited(headers({ 'Retry-After': '5' }));

    expect(e).toBeInstanceOf(ApiError);
    expect(e.statusCode).toBe(429);
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.isRetryable).toBe(true);
    expect(e.name).toBe('RateLimitError');
    // The seven existing call sites test exactly this pair.
    expect(e instanceof ApiError && e.code === 'RATE_LIMITED').toBe(true);
  });

  it('reads Retry-After as delta-seconds', () => {
    expect(rateLimited(headers({ 'Retry-After': '5' })).retryAfterMs).toBe(5000);
  });

  it('accepts zero as "retry now", not as absent', () => {
    expect(rateLimited(headers({ 'Retry-After': '0' })).retryAfterMs).toBe(0);
  });

  it('rejects a negative delta', () => {
    expect(rateLimited(headers({ 'Retry-After': '-5' })).retryAfterMs).toBeUndefined();
  });

  it('rejects a non-numeric value', () => {
    expect(rateLimited(headers({ 'Retry-After': 'abc' })).retryAfterMs).toBeUndefined();
    expect(rateLimited(headers({ 'Retry-After': '1e3' })).retryAfterMs).toBeUndefined();
    expect(rateLimited(headers({ 'Retry-After': '5s' })).retryAfterMs).toBeUndefined();
  });

  it('does not interpret the HTTP-date form', () => {
    const e = rateLimited(headers({ 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }));
    expect(e.retryAfterMs).toBeUndefined();
  });

  it('clamps anything over 15 minutes', () => {
    expect(rateLimited(headers({ 'Retry-After': '1200' })).retryAfterMs).toBe(900_000);
    expect(rateLimited(headers({ 'Retry-After': '99999999' })).retryAfterMs).toBe(900_000);
  });

  it('falls back to RateLimit-Reset when Retry-After is absent', () => {
    expect(rateLimited(headers({ 'RateLimit-Reset': '12' })).retryAfterMs).toBe(12_000);
  });

  it('is undefined when the header is missing', () => {
    expect(rateLimited(headers({})).retryAfterMs).toBeUndefined();
  });

  it('is undefined when the transport has no headers at all (RNFS path)', () => {
    expect(rateLimited().retryAfterMs).toBeUndefined();
  });

  it('survives a header bag whose get() throws', () => {
    const hostile: HeaderReader = {
      get: () => {
        throw new Error('no headers here');
      },
    };
    expect(rateLimited(hostile).retryAfterMs).toBeUndefined();
  });

  it('never puts the header value in the message', () => {
    const e = rateLimited(headers({ 'Retry-After': '5' }));
    expect(e.message).toBe('Rate limited — try again shortly');
  });
});

// ---------------------------------------------------------------------------
// 409 IMPORT_REFUSED → ConflictError.importRefusal
// ---------------------------------------------------------------------------

function refusalBody(code: string, details: Record<string, unknown> = {}): string {
  return JSON.stringify({ error: 'IMPORT_REFUSED', details: { code, ...details } });
}

const ALLOWANCE = {
  posts_used: 200,
  bytes_used: 1024,
  posts_limit: 1000,
  bytes_limit: 2_147_483_648,
};

describe('ConflictError.importRefusal', () => {
  it('carries IMPORT_IN_PROGRESS with the session to resume', () => {
    const id = '5c2e4bd2-7c4f-4071-8d2f-0b1a2c3d4e5f';
    const e = new ConflictError(refusalBody('IMPORT_IN_PROGRESS', { import_id: id }));
    expect(e.importRefusal).toEqual({ code: 'IMPORT_IN_PROGRESS', importId: id });
  });

  it('carries IMPORT_IN_PROGRESS with no id (the 23505 insert race)', () => {
    const e = new ConflictError(refusalBody('IMPORT_IN_PROGRESS'));
    expect(e.importRefusal).toEqual({ code: 'IMPORT_IN_PROGRESS' });
  });

  it('carries IMPORT_ALLOWANCE_EXCEEDED with the allowance, camelCased', () => {
    const e = new ConflictError(refusalBody('IMPORT_ALLOWANCE_EXCEEDED', { allowance: ALLOWANCE }));
    expect(e.importRefusal).toEqual({
      code: 'IMPORT_ALLOWANCE_EXCEEDED',
      allowance: {
        postsUsed: 200,
        bytesUsed: 1024,
        postsLimit: 1000,
        bytesLimit: 2_147_483_648,
      },
    });
  });

  it('carries the chunk-route-only staged/projected bytes', () => {
    const e = new ConflictError(
      refusalBody('IMPORT_ALLOWANCE_EXCEEDED', {
        allowance: ALLOWANCE,
        staged_bytes: 10,
        projected_bytes: 20,
      }),
    );
    expect(e.importRefusal?.stagedBytes).toBe(10);
    expect(e.importRefusal?.projectedBytes).toBe(20);
  });

  it('carries IMPORT_QUOTA_EXCEEDED in both of its shapes', () => {
    const atStart = new ConflictError(
      refusalBody('IMPORT_QUOTA_EXCEEDED', { available_bytes: 5, declared_bytes: 9 }),
    );
    expect(atStart.importRefusal).toEqual({
      code: 'IMPORT_QUOTA_EXCEEDED',
      availableBytes: 5,
      declaredBytes: 9,
    });

    const atMediaComplete = new ConflictError(
      refusalBody('IMPORT_QUOTA_EXCEEDED', { available_bytes: 5, size_bytes: 7 }),
    );
    expect(atMediaComplete.importRefusal).toEqual({
      code: 'IMPORT_QUOTA_EXCEEDED',
      availableBytes: 5,
      sizeBytes: 7,
    });
  });

  it('carries IMPORT_CLOSED with each of the three statuses', () => {
    for (const status of ['closed', 'abandoned', 'completed'] as const) {
      const e = new ConflictError(refusalBody('IMPORT_CLOSED', { status }));
      expect(e.importRefusal).toEqual({ code: 'IMPORT_CLOSED', closedStatus: status });
    }
  });

  it('reports an unknown code as the client sentinel, never the server string', () => {
    const e = new ConflictError(refusalBody('IMPORT_SOMETHING_NEW'));
    expect(e.importRefusal).toEqual({ code: 'unrecognized' });
    expect(JSON.stringify(e.importRefusal)).not.toContain('IMPORT_SOMETHING_NEW');
  });

  it('reports an unknown closed status as the client sentinel', () => {
    const e = new ConflictError(refusalBody('IMPORT_CLOSED', { status: 'evaporated' }));
    expect(e.importRefusal).toEqual({ code: 'IMPORT_CLOSED', closedStatus: 'unrecognized' });
  });

  it('refuses prototype keys in the code position', () => {
    for (const code of ['__proto__', 'constructor', 'toString']) {
      const e = new ConflictError(refusalBody(code));
      expect(e.importRefusal).toEqual({ code: 'unrecognized' });
    }
  });

  it('refuses prototype keys in the status position', () => {
    for (const status of ['__proto__', 'constructor', 'toString']) {
      const e = new ConflictError(refusalBody('IMPORT_CLOSED', { status }));
      expect(e.importRefusal).toEqual({ code: 'IMPORT_CLOSED', closedStatus: 'unrecognized' });
    }
  });

  it('is undefined when the body carries no code', () => {
    const e = new ConflictError(JSON.stringify({ error: 'IMPORT_REFUSED', details: {} }));
    expect(e.importRefusal).toBeUndefined();
  });

  it('is undefined on malformed JSON and on an empty body', () => {
    expect(new ConflictError('not json at all').importRefusal).toBeUndefined();
    expect(new ConflictError('').importRefusal).toBeUndefined();
    expect(new ConflictError().importRefusal).toBeUndefined();
  });

  it('keeps the two 409 parsers mutually exclusive', () => {
    const rewrap = new ConflictError(
      JSON.stringify({ error: 'REWRAP_REFUSED', details: { code: 'IDENTITY_MISMATCH' } }),
    );
    expect(rewrap.refusalCode).toBe('IDENTITY_MISMATCH');
    expect(rewrap.importRefusal).toBeUndefined();

    const imported = new ConflictError(refusalBody('IMPORT_CLOSED', { status: 'closed' }));
    expect(imported.importRefusal?.code).toBe('IMPORT_CLOSED');
    expect(imported.refusalCode).toBeUndefined();
  });

  it('drops a partial allowance rather than reporting half of one', () => {
    const e = new ConflictError(
      refusalBody('IMPORT_ALLOWANCE_EXCEEDED', {
        allowance: { posts_used: 1, bytes_used: 2, posts_limit: 3 },
      }),
    );
    expect(e.importRefusal).toEqual({ code: 'IMPORT_ALLOWANCE_EXCEEDED' });
  });

  it('drops non-finite and non-numeric allowance values', () => {
    const e = new ConflictError(
      refusalBody('IMPORT_ALLOWANCE_EXCEEDED', {
        allowance: { ...ALLOWANCE, bytes_limit: 'lots' },
        staged_bytes: 'many',
      }),
    );
    expect(e.importRefusal).toEqual({ code: 'IMPORT_ALLOWANCE_EXCEEDED' });
  });

  it('drops an import_id that is not a canonical lowercase UUIDv4', () => {
    for (const id of [
      'not-a-uuid',
      '5C2E4BD2-7C4F-4071-8D2F-0B1A2C3D4E5F',
      '5c2e4bd2-7c4f-1071-8d2f-0b1a2c3d4e5f',
      42,
    ]) {
      const e = new ConflictError(refusalBody('IMPORT_IN_PROGRESS', { import_id: id }));
      expect(e.importRefusal).toEqual({ code: 'IMPORT_IN_PROGRESS' });
    }
  });

  it('never lets the server message become the user-facing one', () => {
    const e = new ConflictError(
      JSON.stringify({
        error: 'IMPORT_REFUSED',
        message: 'import_sessions_pkey violated at line 42',
        details: { code: 'IMPORT_CLOSED', status: 'closed' },
      }),
    );
    expect(e.message).toBe('Conflict — action cannot be completed');
  });

  describe('in a release build', () => {
    const globals = globalThis as unknown as { __DEV__: boolean };
    const original = globals.__DEV__;
    afterEach(() => {
      globals.__DEV__ = original;
    });

    it('retains the refusal but not the raw body', () => {
      globals.__DEV__ = false;
      const e = new ConflictError(
        refusalBody('IMPORT_ALLOWANCE_EXCEEDED', { allowance: ALLOWANCE }),
      );
      expect(e.importRefusal?.code).toBe('IMPORT_ALLOWANCE_EXCEEDED');
      expect(e.importRefusal?.allowance?.postsLimit).toBe(1000);
      expect(e.serverMessage).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Validation reasons — two registries (§2.3)
// ---------------------------------------------------------------------------

function validationBody(code: string): string {
  return JSON.stringify({ error: 'VALIDATION_ERROR', details: { code } });
}

describe('ValidationError reasons', () => {
  it('shows curated copy for a copied reason', () => {
    const e = new ValidationError(400, validationBody('MEDIA_IMPORT_RESERVED'));
    expect(e.reason).toBe('MEDIA_IMPORT_RESERVED');
    expect(e.message).toBe("Those photos can't be attached — select them again.");
  });

  it('retains a silent reason but shows the generic message', () => {
    for (const code of [
      'IMPORT_BATCH_TOO_LARGE',
      'IMPORT_DECLARED_INVALID',
      'IMPORT_MEDIA_TYPE_UNSUPPORTED',
    ]) {
      const e = new ValidationError(400, validationBody(code));
      expect(e.reason).toBe(code);
      expect(e.message).toBe('Invalid request');
    }
  });

  it('leaves per-item codes out of both registries', () => {
    // These arrive inside a 200 as per-item results, never as a 400.
    for (const code of ['IMPORT_ITEM_INVALID', 'IMPORT_DATE_INVALID', 'IMPORT_MEDIA_NOT_OWNED']) {
      const e = new ValidationError(400, validationBody(code));
      expect(e.reason).toBeUndefined();
      expect(e.message).toBe('Invalid request');
    }
  });

  it('still refuses prototype keys', () => {
    for (const code of ['__proto__', 'constructor', 'toString']) {
      const e = new ValidationError(400, validationBody(code));
      expect(e.reason).toBeUndefined();
      expect(e.message).toBe('Invalid request');
    }
  });
});
