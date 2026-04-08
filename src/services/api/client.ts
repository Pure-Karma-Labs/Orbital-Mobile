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

const API_BASE_URL = 'https://api.orbitl.org';

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
  return key.replace(/([A-Z])/g, (letter: string) => `_${letter.toLowerCase()}`);
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
  /**
   * When true, skip JSON parsing and case transform — returns raw ArrayBuffer.
   * Use for binary media downloads.
   */
  rawResponse?: boolean;
}

// ============================================================
// Core request function
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
  const {
    method,
    path,
    body,
    skipAuth = false,
    timeout = DEFAULT_TIMEOUT_MS,
    signal: callerSignal,
    rawResponse = false,
  } = options;

  const url = `${API_BASE_URL}${path}`;

  // Build headers
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (!skipAuth) {
    const token = await tokenManager.getAccessToken();
    if (token !== null) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  let serializedBody: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    serializedBody = JSON.stringify(camelToSnake(body));
  }

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

  // Handle error responses
  if (!response.ok) {
    let rawBody: string | undefined;
    try {
      rawBody = await response.text();
    } catch {
      rawBody = undefined;
    }

    const status = response.status;

    if (status === 401 || status === 403) {
      // Deduplicate concurrent 401 handling
      if (!isHandling401) {
        isHandling401 = true;
        try {
          await tokenManager.clearTokens();
        } finally {
          isHandling401 = false;
        }
      }
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

    // Unexpected status
    throw new ApiError(
      'Unexpected server response',
      status,
      'UNKNOWN_ERROR',
      false,
      rawBody,
    );
  }

  // Handle raw binary responses (media download)
  if (rawResponse) {
    const buffer = await response.arrayBuffer();
    return buffer as unknown as T;
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
