/**
 * Tests for the core API client — request(), case transforms, error mapping.
 */

// Mock tokenManager before importing client so the module initialises cleanly
jest.mock('../tokenManager', () => ({
  tokenManager: {
    getAccessToken: jest.fn().mockResolvedValue('test-token'),
    clearTokens: jest.fn().mockResolvedValue(undefined),
    setTokens: jest.fn().mockResolvedValue(undefined),
    isConfigured: jest.fn().mockReturnValue(false),
    configure: jest.fn(),
  },
}));

import { request, requestBinary, snakeToCamel, camelToSnake } from '../client';
import {
  AuthError,
  ConflictError,
  NetworkError,
  NotFoundError,
  ServerError,
  ValidationError,
} from '../errors';
import { tokenManager } from '../tokenManager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchOk(body: unknown, status = 200): void {
  (globalThis as Record<string, unknown>).fetch = jest.fn().mockResolvedValue({
    ok: true,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
  });
}

function mockFetchError(status: number, bodyText = ''): void {
  (globalThis as Record<string, unknown>).fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: jest.fn().mockRejectedValue(new Error('not json')),
    text: jest.fn().mockResolvedValue(bodyText),
  });
}

function mockFetchNetworkFailure(message = 'Failed to fetch'): void {
  (globalThis as Record<string, unknown>).fetch = jest.fn().mockRejectedValue(new Error(message));
}

beforeEach(() => {
  jest.clearAllMocks();
  (tokenManager.getAccessToken as jest.Mock).mockResolvedValue('test-token');
});

// ---------------------------------------------------------------------------
// Auth header injection
// ---------------------------------------------------------------------------

describe('auth header injection', () => {
  it('injects Authorization header when token is present', async () => {
    mockFetchOk({ ok: true });

    await request({ method: 'GET', path: '/api/test' });

    const [, init] = ((globalThis as Record<string, unknown>).fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-token',
    );
  });

  it('omits Authorization header when skipAuth is true', async () => {
    mockFetchOk({ ok: true });

    await request({ method: 'GET', path: '/api/test', skipAuth: true });

    const [, init] = ((globalThis as Record<string, unknown>).fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('throws AuthError when no token available and skipAuth is false', async () => {
    const { AuthError: AuthErrorClass } = require('../errors');
    (tokenManager.getAccessToken as jest.Mock).mockResolvedValue(null);

    await expect(
      request({ method: 'GET', path: '/api/test' }),
    ).rejects.toBeInstanceOf(AuthErrorClass);
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('error mapping', () => {
  it('maps 400 to ValidationError', async () => {
    mockFetchError(400, 'bad request');
    await expect(request({ method: 'GET', path: '/api/test' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('maps 422 to ValidationError', async () => {
    mockFetchError(422, 'unprocessable');
    await expect(request({ method: 'GET', path: '/api/test' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('maps 401 to AuthError', async () => {
    mockFetchError(401, 'unauthorized');
    await expect(request({ method: 'GET', path: '/api/test' })).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it('maps 403 to AuthError', async () => {
    mockFetchError(403, 'forbidden');
    await expect(request({ method: 'GET', path: '/api/test' })).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it('maps 404 to NotFoundError', async () => {
    mockFetchError(404, 'not found');
    await expect(request({ method: 'GET', path: '/api/test' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('maps 500 to ServerError', async () => {
    mockFetchError(500, 'internal error');
    await expect(request({ method: 'GET', path: '/api/test' })).rejects.toBeInstanceOf(
      ServerError,
    );
  });

  it('maps 503 to ServerError', async () => {
    mockFetchError(503, 'service unavailable');
    await expect(request({ method: 'GET', path: '/api/test' })).rejects.toBeInstanceOf(
      ServerError,
    );
  });

  it('maps fetch throw to NetworkError', async () => {
    mockFetchNetworkFailure('Failed to fetch');
    await expect(request({ method: 'GET', path: '/api/test' })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it('NetworkError is retryable', async () => {
    mockFetchNetworkFailure();
    const err = await request({ method: 'GET', path: '/api/test' }).catch(
      (e: unknown) => e,
    );
    expect((err as NetworkError).isRetryable).toBe(true);
  });

  it('AuthError is not retryable', async () => {
    mockFetchError(401);
    const err = await request({ method: 'GET', path: '/api/test' }).catch(
      (e: unknown) => e,
    );
    expect((err as AuthError).isRetryable).toBe(false);
  });

  it('ServerError is retryable', async () => {
    mockFetchError(500);
    const err = await request({ method: 'GET', path: '/api/test' }).catch(
      (e: unknown) => e,
    );
    expect((err as ServerError).isRetryable).toBe(true);
  });

  it('ValidationError has user-friendly message', async () => {
    mockFetchError(400, 'some server detail');
    const err = await request({ method: 'GET', path: '/api/test' }).catch(
      (e: unknown) => e,
    );
    expect((err as ValidationError).message).toBe('Invalid request');
  });

  it('calls tokenManager.clearTokens() on 401', async () => {
    mockFetchError(401);
    await request({ method: 'GET', path: '/api/test' }).catch(() => {});
    expect(tokenManager.clearTokens).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('timeout', () => {
  it('creates an AbortController for timeout and passes signal to fetch', async () => {
    // Rather than fighting fake timers + abort plumbing in jsdom, verify that:
    // 1. fetch is called with a signal
    // 2. a timeout-driven abort would fire NetworkError (covered by network failure test)
    mockFetchOk({ ok: true });

    await request({ method: 'GET', path: '/api/test', timeout: 5_000 });

    const [, init] = ((globalThis as Record<string, unknown>).fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(init.signal).toBeDefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws NetworkError when fetch is aborted', async () => {
    // Simulate an aborted fetch (what happens when timeout fires)
    (globalThis as Record<string, unknown>).fetch = jest.fn().mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    );

    await expect(
      request({ method: 'GET', path: '/api/test', timeout: 100 }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// Case transform — response (snake_case → camelCase)
// ---------------------------------------------------------------------------

describe('response case transform', () => {
  it('converts snake_case keys to camelCase', async () => {
    mockFetchOk({ user_id: 'u1', display_name: 'Alice' });

    const result = await request<{ userId: string; displayName: string }>({
      method: 'GET',
      path: '/api/test',
    });

    expect(result).toEqual({ userId: 'u1', displayName: 'Alice' });
  });

  it('handles nested objects', async () => {
    mockFetchOk({ outer_field: { inner_key: 'value' } });

    const result = await request<{ outerField: { innerKey: string } }>({
      method: 'GET',
      path: '/api/test',
    });

    expect(result).toEqual({ outerField: { innerKey: 'value' } });
  });

  it('handles arrays of objects', async () => {
    mockFetchOk([{ user_id: '1' }, { user_id: '2' }]);

    const result = await request<Array<{ userId: string }>>({
      method: 'GET',
      path: '/api/test',
    });

    expect(result).toEqual([{ userId: '1' }, { userId: '2' }]);
  });
});

// ---------------------------------------------------------------------------
// Case transform — request body (camelCase → snake_case)
// ---------------------------------------------------------------------------

describe('request body case transform', () => {
  it('converts camelCase body keys to snake_case', async () => {
    mockFetchOk({ ok: true });

    await request({
      method: 'POST',
      path: '/api/test',
      body: { encryptedBody: 'abc', parentReplyId: null },
    });

    const [, init] = ((globalThis as Record<string, unknown>).fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ encrypted_body: 'abc', parent_reply_id: null });
  });

  it('handles nested objects in body', async () => {
    mockFetchOk({ ok: true });

    await request({
      method: 'POST',
      path: '/api/test',
      body: { outerField: { innerKey: 'v' } },
    });

    const [, init] = ((globalThis as Record<string, unknown>).fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ outer_field: { inner_key: 'v' } });
  });
});

// ---------------------------------------------------------------------------
// HTTPS enforcement
// ---------------------------------------------------------------------------

describe('snakeToCamel edge cases', () => {
  it('passes null through unchanged', () => {
    expect(snakeToCamel(null)).toBeNull();
  });

  it('passes undefined through unchanged', () => {
    expect(snakeToCamel(undefined)).toBeUndefined();
  });

  it('passes primitive strings unchanged', () => {
    expect(snakeToCamel('hello_world')).toBe('hello_world');
  });

  it('does not recurse into Date objects', () => {
    const d = new Date('2024-01-01');
    expect(snakeToCamel(d)).toBe(d);
  });

  it('does not recurse into ArrayBuffer', () => {
    const buf = new ArrayBuffer(4);
    expect(snakeToCamel(buf)).toBe(buf);
  });

  it('handles arrays with null elements', () => {
    expect(snakeToCamel([null, { user_id: 'u1' }])).toEqual([
      null,
      { userId: 'u1' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// requestBinary
// ---------------------------------------------------------------------------

describe('requestBinary', () => {
  function mockFetchBinaryOk(
    buffer: ArrayBuffer,
    headers: Record<string, string> = {},
  ): void {
    const mockHeaders = {
      get: jest.fn((name: string) => headers[name.toLowerCase()] ?? null),
      has: jest.fn((name: string) => name.toLowerCase() in headers),
    };
    (globalThis as Record<string, unknown>).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: jest.fn().mockResolvedValue(buffer),
      text: jest.fn().mockResolvedValue(''),
      headers: mockHeaders,
    });
  }

  it('returns ArrayBuffer and headers on success', async () => {
    const buffer = new ArrayBuffer(16);
    mockFetchBinaryOk(buffer, {
      'x-encryption-iv': 'test-iv',
      'x-expires-at': '2026-12-31',
    });

    const result = await requestBinary({ method: 'GET', path: '/api/test' });

    expect(result.data).toBe(buffer);
    expect(result.headers.get('x-encryption-iv')).toBe('test-iv');
    expect(result.headers.get('x-expires-at')).toBe('2026-12-31');
  });

  it('injects Authorization header', async () => {
    mockFetchBinaryOk(new ArrayBuffer(4));

    await requestBinary({ method: 'GET', path: '/api/test' });

    const [, init] = ((globalThis as Record<string, unknown>).fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-token',
    );
  });

  it('maps error responses through the same error handling as request()', async () => {
    mockFetchError(500, 'server error');

    await expect(
      requestBinary({ method: 'GET', path: '/api/test' }),
    ).rejects.toBeInstanceOf(ServerError);
  });

  it('does not apply snake_case to camelCase transforms', async () => {
    // requestBinary returns raw ArrayBuffer, no JSON parsing
    const buffer = new ArrayBuffer(8);
    mockFetchBinaryOk(buffer);

    const result = await requestBinary({ method: 'GET', path: '/api/test' });
    expect(result.data).toBeInstanceOf(ArrayBuffer);
    expect(result.data.byteLength).toBe(8);
  });
});

describe('camelToSnake edge cases', () => {
  it('passes null through unchanged', () => {
    expect(camelToSnake(null)).toBeNull();
  });

  it('handles arrays', () => {
    expect(camelToSnake([{ userId: 'u1' }])).toEqual([{ user_id: 'u1' }]);
  });

  it('handles nested objects', () => {
    expect(camelToSnake({ outerKey: { innerValue: 1 } })).toEqual({
      outer_key: { inner_value: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// ConflictError (409) — mapping and parsing
// ---------------------------------------------------------------------------

describe('ConflictError', () => {
  it('maps 409 to ConflictError', async () => {
    mockFetchError(409, JSON.stringify({ error: 'Conflict' }));
    await expect(request({ method: 'DELETE', path: '/api/test' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('parses blocking_orbits from 409 response body', async () => {
    const body = JSON.stringify({
      error: 'Cannot delete',
      details: {
        blocking_orbits: [
          { id: 'orbit-1', encrypted_name: 'enc-name-1' },
          { id: 'orbit-2', encrypted_name: 'enc-name-2' },
        ],
      },
    });
    mockFetchError(409, body);

    const err = await request({ method: 'DELETE', path: '/api/test' }).catch(
      (e: unknown) => e,
    ) as ConflictError;

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.blockingOrbits).toEqual([
      { id: 'orbit-1', encryptedName: 'enc-name-1' },
      { id: 'orbit-2', encryptedName: 'enc-name-2' },
    ]);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CONFLICT');
    expect(err.isRetryable).toBe(false);
  });

  it('defaults to empty blockingOrbits on bad/missing body', async () => {
    mockFetchError(409, 'not json at all');

    const err = await request({ method: 'DELETE', path: '/api/test' }).catch(
      (e: unknown) => e,
    ) as ConflictError;

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.blockingOrbits).toEqual([]);
  });

  it('defaults to empty blockingOrbits when details.blocking_orbits is missing', async () => {
    mockFetchError(409, JSON.stringify({ error: 'Conflict', details: {} }));

    const err = await request({ method: 'DELETE', path: '/api/test' }).catch(
      (e: unknown) => e,
    ) as ConflictError;

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.blockingOrbits).toEqual([]);
  });
});
