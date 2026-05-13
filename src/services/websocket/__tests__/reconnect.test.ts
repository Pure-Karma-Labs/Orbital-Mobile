import { calculateBackoff, shouldReconnect } from '../reconnect';
import { WS_CLOSE_NORMAL, WS_CLOSE_AUTH_FAILURE } from '../types';

describe('calculateBackoff', () => {
  it('returns ~1000ms for attempt 0', () => {
    // With jitter ±20%, range is [800, 1200]
    const results = Array.from({ length: 50 }, () => calculateBackoff(0));
    for (const delay of results) {
      expect(delay).toBeGreaterThanOrEqual(800);
      expect(delay).toBeLessThanOrEqual(1200);
    }
  });

  it('doubles delay for each attempt', () => {
    const config = { baseDelayMs: 1000, maxDelayMs: 30_000, jitterFactor: 0 };
    expect(calculateBackoff(0, config)).toBe(1000);
    expect(calculateBackoff(1, config)).toBe(2000);
    expect(calculateBackoff(2, config)).toBe(4000);
    expect(calculateBackoff(3, config)).toBe(8000);
  });

  it('caps at maxDelayMs', () => {
    const config = { baseDelayMs: 1000, maxDelayMs: 30_000, jitterFactor: 0 };
    // 2^15 * 1000 = 32_768_000, should be capped at 30_000
    expect(calculateBackoff(15, config)).toBe(30_000);
  });

  it('applies jitter within expected range', () => {
    const config = { baseDelayMs: 1000, maxDelayMs: 30_000, jitterFactor: 0.2 };
    const results = Array.from({ length: 100 }, () => calculateBackoff(0, config));
    const min = Math.min(...results);
    const max = Math.max(...results);
    expect(min).toBeGreaterThanOrEqual(800);
    expect(max).toBeLessThanOrEqual(1200);
    // Ensure there's actually some variation
    expect(max).toBeGreaterThan(min);
  });

  it('returns integer values', () => {
    for (let i = 0; i < 20; i++) {
      expect(Number.isInteger(calculateBackoff(i))).toBe(true);
    }
  });
});

describe('shouldReconnect', () => {
  it('returns false for normal close (1000)', () => {
    expect(shouldReconnect(WS_CLOSE_NORMAL)).toBe(false);
  });

  it('returns false for auth failure (4401)', () => {
    expect(shouldReconnect(WS_CLOSE_AUTH_FAILURE)).toBe(false);
  });

  it('returns true for abnormal close (1006)', () => {
    expect(shouldReconnect(1006)).toBe(true);
  });

  it('returns true for going away (1001)', () => {
    expect(shouldReconnect(1001)).toBe(true);
  });

  it('returns true for server error (1011)', () => {
    expect(shouldReconnect(1011)).toBe(true);
  });

  it('returns true for unknown codes', () => {
    expect(shouldReconnect(4999)).toBe(true);
  });
});
