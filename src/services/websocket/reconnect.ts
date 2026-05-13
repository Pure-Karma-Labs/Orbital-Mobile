/**
 * Reconnection utilities for the WebSocket manager.
 *
 * Provides exponential backoff with jitter for reconnect delay,
 * and a predicate to decide whether a given close code is retryable.
 */

import { WS_CLOSE_NORMAL, WS_CLOSE_AUTH_FAILURE } from './types';

// ============================================================
// Configuration
// ============================================================

export interface ReconnectConfig {
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs: number;
  /** Jitter factor ±percentage (default: 0.2 = ±20%) */
  jitterFactor: number;
}

const DEFAULT_CONFIG: ReconnectConfig = {
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitterFactor: 0.2,
};

// ============================================================
// Backoff calculation
// ============================================================

/**
 * Calculate reconnect delay using exponential backoff with jitter.
 *
 * Formula: min(base * 2^attempt, max) * (1 ± jitter)
 *
 * @param attempt - Zero-based attempt count (0 = first reconnect).
 * @param config  - Optional override for backoff parameters.
 * @returns Delay in milliseconds.
 */
export function calculateBackoff(
  attempt: number,
  config: ReconnectConfig = DEFAULT_CONFIG,
): number {
  const { baseDelayMs, maxDelayMs, jitterFactor } = config;
  const exponentialDelay = Math.min(
    baseDelayMs * Math.pow(2, attempt),
    maxDelayMs,
  );
  const jitterRange = exponentialDelay * jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.round(exponentialDelay + jitter);
}

// ============================================================
// Close code predicate
// ============================================================

/**
 * Determine whether the client should attempt to reconnect after a close event.
 *
 * Returns false for:
 * - 1000: Normal closure (intentional disconnect)
 * - 4401: Auth failure (JWT expired/invalid — need re-login, not reconnect)
 *
 * All other codes are considered transient and reconnectable.
 */
export function shouldReconnect(closeCode: number): boolean {
  return closeCode !== WS_CLOSE_NORMAL && closeCode !== WS_CLOSE_AUTH_FAILURE;
}
