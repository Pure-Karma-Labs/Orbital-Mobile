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

/**
 * HTTP 409 — conflict. The request cannot be completed due to a conflict
 * with the current state of the resource.
 *
 * For account deletion, the backend returns blocking_orbits in the response body
 * that prevent deletion. This field is prod-retained (not __DEV__-gated) because
 * it contains only the user's own orbit ids + encrypted names, not server internals.
 */
export interface BlockingOrbit {
  id: string;
  encryptedName: string;
}

export class ConflictError extends ApiError {
  /** Orbits blocking account deletion — always available (prod-retained). */
  readonly blockingOrbits: BlockingOrbit[];

  constructor(rawBody?: string) {
    super('Conflict — action cannot be completed', 409, 'CONFLICT', false, rawBody);
    this.name = 'ConflictError';

    // Parse blocking_orbits from the raw 409 response body (snake_case from server)
    let orbits: BlockingOrbit[] = [];
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody);
        const raw = parsed?.details?.blocking_orbits;
        if (Array.isArray(raw)) {
          orbits = raw.map((o: Record<string, unknown>) => ({
            id: typeof o.id === 'string' ? o.id : '',
            encryptedName: typeof o.encrypted_name === 'string' ? o.encrypted_name : '',
          }));
        }
      } catch {
        // Parse failure — default to empty array
      }
    }
    this.blockingOrbits = orbits;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
