/**
 * Typed error hierarchy for the Orbital API client.
 *
 * ApiError.message is always user-friendly — it is safe to display.
 * ApiError.serverMessage holds the raw server response string, only populated
 * in __DEV__ mode to prevent leaking server internals to production.
 */

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly isRetryable: boolean;
  /** Raw server response body — only set in __DEV__, undefined in production. */
  readonly serverMessage: string | undefined;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    isRetryable: boolean,
    serverMessage?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.isRetryable = isRetryable;
    this.serverMessage = __DEV__ ? serverMessage : undefined;
    // Maintain proper prototype chain in transpiled ES5
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Wraps fetch-level failures (no response received) and request timeouts. Retryable. */
export class NetworkError extends ApiError {
  constructor(serverMessage?: string) {
    super(
      'Network error — please check your connection',
      0,
      'NETWORK_ERROR',
      true,
      serverMessage,
    );
    this.name = 'NetworkError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** HTTP 401 or 403 — credentials invalid or insufficient. Not retryable; triggers re-auth. */
export class AuthError extends ApiError {
  constructor(statusCode: 401 | 403, serverMessage?: string) {
    super(
      'Authentication required',
      statusCode,
      'AUTH_ERROR',
      false,
      serverMessage,
    );
    this.name = 'AuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** HTTP 400 or 422 — malformed request or failed validation. Not retryable. */
export class ValidationError extends ApiError {
  constructor(statusCode: 400 | 422, serverMessage?: string) {
    super(
      'Invalid request',
      statusCode,
      'VALIDATION_ERROR',
      false,
      serverMessage,
    );
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** HTTP 5xx — server-side error. Retryable. */
export class ServerError extends ApiError {
  constructor(statusCode: number, serverMessage?: string) {
    super(
      'Server error — please try again',
      statusCode,
      'SERVER_ERROR',
      true,
      serverMessage,
    );
    this.name = 'ServerError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** HTTP 404 — resource does not exist. Not retryable. */
export class NotFoundError extends ApiError {
  constructor(serverMessage?: string) {
    super('Not found', 404, 'NOT_FOUND', false, serverMessage);
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
