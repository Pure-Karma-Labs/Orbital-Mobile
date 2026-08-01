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
  ConflictError,
  NetworkError,
  NotFoundError,
  QuotaExceededError,
  ServerError,
  ValidationError,
} from './errors';
import { tokenManager } from './tokenManager';

import { API_BASE_URL } from '../../config/env';

export { API_BASE_URL };

const DEFAULT_TIMEOUT_MS = 15_000;

// ============================================================
// Media transfer deadline
// ============================================================

/**
 * Base allowance for a media body transfer, before any size term.
 *
 * React Native's fetch resolves only after the FULL response body has been
 * read, so `timeout` on a fetch-based media GET is an end-to-end transfer
 * deadline, not a time-to-first-byte one. A flat 60s therefore silently caps
 * throughput: a ~45MB clip needs a sustained ~6 Mbps or it fails
 * deterministically, and the retry restarts from byte 0.
 *
 * NOTE (#578): media DOWNLOADS no longer go through fetch at all — they stream
 * to disk via `downloadMediaToFile` (api/media.ts), whose primary guard is a
 * 30s stall timeout, with this function only supplying the basis for a generous
 * absolute backstop. The end-to-end premise above still holds for the remaining
 * fetch-based media transfers (chunk uploads, avatars).
 */
export const MEDIA_TRANSFER_BASE_TIMEOUT_MS = 60_000;

/** Extra allowance per megabyte — tolerates sustained throughput down to ~4 Mbps. */
export const MEDIA_TRANSFER_MS_PER_MB = 2_000;

/** Hard ceiling. Beyond this a stalled transfer should fail, not hang. */
export const MEDIA_TRANSFER_MAX_TIMEOUT_MS = 600_000;

/**
 * Size-derived deadline for a media body transfer: base + 2s per MB, capped.
 *
 * Deliberately scoped to media GETs (see api/media.ts) — the 15s default stays
 * in force for every JSON endpoint, where a slow response is a real failure.
 *
 * Unknown/zero/invalid sizes fall back to the base allowance.
 */
export function mediaTransferTimeoutMs(fileSizeBytes?: number | null): number {
  if (
    fileSizeBytes == null ||
    !Number.isFinite(fileSizeBytes) ||
    fileSizeBytes <= 0
  ) {
    return MEDIA_TRANSFER_BASE_TIMEOUT_MS;
  }
  const megabytes = Math.ceil(fileSizeBytes / (1024 * 1024));
  return Math.min(
    MEDIA_TRANSFER_BASE_TIMEOUT_MS + megabytes * MEDIA_TRANSFER_MS_PER_MB,
    MEDIA_TRANSFER_MAX_TIMEOUT_MS,
  );
}

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

/**
 * Clear tokens on an authentication failure, deduplicated across concurrent
 * requests.
 *
 * Shared by every transport (fetch-based `_executeRequest` and the RNFS
 * `downloadFile` transport in api/media.ts) so a 401 has exactly one meaning
 * and one side effect regardless of which one saw it.
 *
 * 403 is deliberately NOT included — it means "authenticated but not
 * authorized" (e.g. removed from a group) and must not clear the session.
 *
 * The dedup flag is best-effort: concurrent 401s that arrive while a clear is
 * already in flight are dropped, which is the intent (one clear, not N).
 */
export async function handleUnauthorized(status: number): Promise<void> {
  if (status !== 401) return;
  if (isHandling401) return;
  isHandling401 = true;
  try {
    await tokenManager.clearTokens();
  } finally {
    isHandling401 = false;
  }
}

// ============================================================
// Shared HTTP error mapping
// ============================================================

/**
 * Map an HTTP status + raw error body to the typed error hierarchy.
 *
 * Returns the error rather than throwing so callers can decide (throw, wrap,
 * or inspect). Shared by all transports — the RNFS download transport gets the
 * same MEDIA_EVICTED/EXPIRED discrimination from `rawBody` that fetch does,
 * because RNFS surfaces non-2xx bodies in `result.body` rather than writing
 * them to `toFile`.
 */
export function mapHttpErrorToApiError(status: number, rawBody?: string): ApiError {
  if (status === 401 || status === 403) {
    return new AuthError(status as 401 | 403, rawBody);
  }
  if (status === 404) {
    return new NotFoundError(rawBody);
  }
  if (status === 409) {
    return new ConflictError(rawBody);
  }
  // 413 = quota denial on upload routes (QUOTA_EXCEEDED). Express body-parser can
  // also 413 JSON bodies >10MB (PAYLOAD_TOO_LARGE) but upload routes are multipart,
  // so that case can't occur here; both are non-retryable regardless.
  if (status === 413) {
    return new QuotaExceededError(rawBody);
  }
  if (status === 400 || status === 422) {
    return new ValidationError(status as 400 | 422, rawBody);
  }
  if (status === 429) {
    return new ApiError('Rate limited — try again shortly', 429, 'RATE_LIMITED', true, rawBody);
  }
  if (status >= 500) {
    return new ServerError(status, rawBody);
  }
  return new ApiError('Unexpected server response', status, 'UNKNOWN_ERROR', false, rawBody);
}

// ============================================================
// Shared 429 backoff
// ============================================================

/** Maximum 429 retries before giving up (shared by all transports). */
export const MAX_429_RETRIES = 3;

/**
 * Message for the pre-flight "not authenticated" AuthError, shared by every
 * transport (the fetch path here and the RNFS download path in `media.ts`) so
 * they cannot drift apart.
 */
export const NO_ACCESS_TOKEN_MESSAGE =
  'No access token available — user is not authenticated';

/** Cap retry delay at 10s — a mobile user won't wait minutes. */
const MAX_RETRY_DELAY_MS = 10_000;

/**
 * Wait out a 429 with exponential backoff + jitter, abortable.
 *
 * Rejects immediately if the caller's signal is already aborted (arming a
 * timer we know we'll throw away just delays the failure), and removes the
 * abort listener in `finally` — the previous inline version leaked one
 * listener per retry onto a long-lived caller signal.
 *
 * @param attempt - Zero-based retry attempt number.
 */
export async function delayForRateLimit(
  attempt: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new NetworkError('Request aborted during rate-limit backoff');
  }

  const backoffMs = 1000 * Math.pow(2, attempt) + Math.random() * 500;
  const delayMs = Math.min(backoffMs, MAX_RETRY_DELAY_MS);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, delayMs);
      onAbort = () => {
        clearTimeout(timer);
        reject(new NetworkError('Request aborted during rate-limit backoff'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}

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

  const url = `${API_BASE_URL}${path}`;

  // Build headers
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (!skipAuth) {
    const token = await tokenManager.getAccessToken();
    if (token === null) {
      throw new AuthError(401, NO_ACCESS_TOKEN_MESSAGE);
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
      if (__DEV__) {
        console.warn(`[API] 429 on ${method} ${path} — retry ${attempt + 1}/${MAX_429_RETRIES}`);
      }

      await delayForRateLimit(attempt, callerSignal);

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

    // Clear tokens on authentication failure (expired/invalid JWT), deduped.
    await handleUnauthorized(status);

    throw mapHttpErrorToApiError(status, rawBody);
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
