/**
 * Core HTTP client for the Orbital backend API.
 *
 * Uses native fetch — no axios or other HTTP library dependency.
 * All requests go to HTTPS (enforced at initialization).
 * Auth tokens are injected automatically unless skipAuth is true.
 */

import {
  ApiError,
  AuthError,
  NetworkError,
  NotFoundError,
  ServerError,
  ValidationError,
} from './errors';
import { tokenManager } from './tokenManager';

export const API_BASE_URL = 'https://api.orbitl.org';

// Guard: enforce HTTPS at module load time
if (!API_BASE_URL.startsWith('https://')) {
  throw new Error(
    `[ApiClient] Base URL must use HTTPS. Got: ${API_BASE_URL}`,
  );
}

const DEFAULT_TIMEOUT_MS = 15_000;

// ============================================================
// Case transformation utilities
// ============================================================

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof ArrayBuffer) &&
    !(value instanceof Date) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function snakeToCamelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function camelToSnakeKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Recursively transforms object keys from snake_case to camelCase.
 * Handles nested objects and arrays. Skips null, undefined, Date,
 * ArrayBuffer, and non-plain objects.
 */
export function snakeToCamel(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(snakeToCamel);
  }
  if (isPlainObject(value)) {
    const result: PlainObject = {};
    for (const key of Object.keys(value)) {
      result[snakeToCamelKey(key)] = snakeToCamel(value[key]);
    }
    return result;
  }
  return value;
}

/**
 * Recursively transforms object keys from camelCase to snake_case.
 * Handles nested objects and arrays. Skips null, undefined, Date,
 * ArrayBuffer, and non-plain objects.
 */
export function camelToSnake(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(camelToSnake);
  }
  if (isPlainObject(value)) {
    const result: PlainObject = {};
    for (const key of Object.keys(value)) {
      result[camelToSnakeKey(key)] = camelToSnake(value[key]);
    }
    return result;
  }
  return value;
}

// ============================================================
// Query string builder
// ============================================================

/**
 * Build a query string from a params object. Skips undefined values.
 * Returns the leading '?' or empty string if no params.
 */
export function buildQueryString(
  params: Record<string, string | number | undefined>,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      parts.push(`${key}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

// ============================================================
// 401 deduplication guard
// ============================================================

let isHandling401 = false;

// ============================================================
// Request interface
// ============================================================

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  /** When true, no Authorization header is added. Default: false (auth injected). */
  skipAuth?: boolean;
  /** Request timeout in milliseconds. Default: 15000. */
  timeout?: number;
  /** AbortSignal for caller-driven cancellation (e.g., on navigation away). */
  signal?: AbortSignal;
}

// ============================================================
// Shared request executor (private)
// ============================================================

/**
 * Execute an HTTP request against the Orbital backend and return the raw
 * Response object after error handling.
 *
 * This is the shared implementation used by both `request<T>()` (JSON) and
 * `requestBinary()` (ArrayBuffer). It handles:
 * - URL construction
 * - Auth header injection (unless skipAuth)
 * - Body serialisation (JSON with camelToSnake, or passthrough for FormData)
 * - Timeout via AbortController (merged with caller signal)
 * - Error response mapping to typed ApiError subclasses
 *
 * On success (2xx), returns the raw Response — callers decide how to read the body.
 */
async function _executeRequest(options: RequestOptions): Promise<Response> {
  const {
    method,
    path,
    body,
    skipAuth = false,
    timeout = DEFAULT_TIMEOUT_MS,
    signal: callerSignal,
  } = options;

  const MAX_429_RETRIES = 3;
  const url = `${API_BASE_URL}${path}`;

  // Build headers
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (!skipAuth) {
    const token = await tokenManager.getAccessToken();
    if (token === null) {
      throw new AuthError(401, 'No access token available — user is not authenticated');
    }
    headers.Authorization = `Bearer ${token}`;
  }

  let serializedBody: string | FormData | undefined;
  if (body !== undefined) {
    if (body instanceof FormData) {
      // Let fetch set Content-Type with multipart boundary automatically
      serializedBody = body;
    } else {
      headers['Content-Type'] = 'application/json';
      serializedBody = JSON.stringify(camelToSnake(body));
    }
  }

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    // Timeout via AbortController, merged with caller's signal
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(
      () => timeoutController.abort(),
      timeout,
    );

    // Combine caller signal + timeout signal.
    // AbortSignal.any() combines multiple signals into one (Node 20+, modern browsers).
    // Cast through unknown to avoid lib mismatch — AbortSignal.any is available at runtime
    // in the Hermes / Node environments this app targets.
    type AbortSignalWithAny = typeof AbortSignal & {
      any?: (signals: AbortSignal[]) => AbortSignal;
    };
    const AbortSignalAny = (AbortSignal as AbortSignalWithAny).any;
    const combinedSignal: AbortSignal =
      callerSignal !== undefined && AbortSignalAny !== undefined
        ? AbortSignalAny([callerSignal, timeoutController.signal])
        : timeoutController.signal;

    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers,
        body: serializedBody,
        signal: combinedSignal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      // fetch throws on network failure or abort
      const message =
        err instanceof Error ? err.message : 'Unknown network error';
      throw new NetworkError(message);
    } finally {
      clearTimeout(timeoutId);
    }

    // 429 retry with exponential backoff
    if (response.status === 429 && attempt < MAX_429_RETRIES) {
      // Cap retry delay at 10s — a mobile user won't wait minutes
      const MAX_RETRY_DELAY_MS = 10_000;
      const backoffMs = 1000 * Math.pow(2, attempt) + Math.random() * 500;
      const delayMs = Math.min(backoffMs, MAX_RETRY_DELAY_MS);

      if (__DEV__) {
        console.warn(`[API] 429 on ${method} ${path} — retry ${attempt + 1}/${MAX_429_RETRIES} in ${Math.round(delayMs)}ms`);
      }

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        callerSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new NetworkError('Request aborted during rate-limit backoff'));
        }, { once: true });
      });

      continue;
    }

    // Handle success
    if (response.ok) return response;

    // Handle error responses — always read text for error parsing
    let rawBody: string | undefined;
    try {
      rawBody = await response.text();
    } catch {
      rawBody = undefined;
    }

    const status = response.status;

    if (status === 401) {
      // Clear tokens on authentication failure (expired/invalid JWT).
      // 403 is NOT included — it means "authenticated but not authorized"
      // (e.g., removed from a group) and should not clear the session.
      if (!isHandling401) {
        isHandling401 = true;
        try {
          await tokenManager.clearTokens();
        } finally {
          isHandling401 = false;
        }
      }
    }

    if (status === 401 || status === 403) {
      throw new AuthError(status as 401 | 403, rawBody);
    }

    if (status === 404) {
      throw new NotFoundError(rawBody);
    }

    if (status === 400 || status === 422) {
      throw new ValidationError(status as 400 | 422, rawBody);
    }

    if (status >= 500) {
      throw new ServerError(status, rawBody);
    }

    if (status === 429) {
      throw new ApiError(
        'Rate limited — try again shortly',
        429,
        'RATE_LIMITED',
        true,
        rawBody,
      );
    }

    // Unexpected status
    throw new ApiError(
      'Unexpected server response',
      status,
      'UNKNOWN_ERROR',
      false,
      rawBody,
    );
  }

  // Should not be reachable, but TypeScript requires a return
  throw new ApiError('Rate limited — retries exhausted', 429, 'RATE_LIMITED', true);
}

// ============================================================
// Core request function (JSON)
// ============================================================

/**
 * Execute a typed HTTP request against the Orbital backend.
 *
 * Pipeline:
 * 1. Build URL from base + path
 * 2. Inject Authorization header (unless skipAuth)
 * 3. Serialize body as snake_case JSON
 * 4. Apply timeout via AbortController (merged with caller signal)
 * 5. Execute fetch
 * 6. Map error responses to typed ApiError subclasses
 * 7. Parse JSON response and transform keys to camelCase
 */
export async function request<T>(options: RequestOptions): Promise<T> {
  const response = await _executeRequest(options);

  // 204 No Content has no body — return undefined without parsing
  if (response.status === 204) {
    return undefined as T;
  }

  // Parse JSON and transform keys to camelCase
  let json: unknown;
  try {
    json = await response.json();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid JSON';
    throw new ApiError(
      'Server returned invalid response',
      response.status,
      'PARSE_ERROR',
      false,
      message,
    );
  }

  return snakeToCamel(json) as T;
}

// ============================================================
// Binary request function (ArrayBuffer)
// ============================================================

/**
 * Execute an HTTP request and return the response as an ArrayBuffer with headers.
 *
 * Uses the same auth injection, timeout, and error handling as `request<T>()`,
 * but reads the successful response body as an ArrayBuffer (no JSON parsing,
 * no case transforms). Returns both the binary data and response headers
 * so callers can extract custom headers (e.g., X-Encryption-IV, X-Expires-At).
 *
 * Error responses (4xx/5xx) are still parsed as text for error mapping —
 * binary reading only applies to success responses.
 */
export async function requestBinary(
  options: RequestOptions,
): Promise<{ data: ArrayBuffer; headers: Headers }> {
  const response = await _executeRequest(options);

  let data: ArrayBuffer;
  try {
    data = await response.arrayBuffer();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Invalid binary response';
    throw new ApiError(
      'Server returned invalid response',
      response.status,
      'PARSE_ERROR',
      false,
      message,
    );
  }

  return { data, headers: response.headers };
}
