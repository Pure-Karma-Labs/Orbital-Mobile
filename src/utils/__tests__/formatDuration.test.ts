import { formatDurationMs, formatDurationSeconds } from '../formatDuration';

describe('formatDurationMs', () => {
  it('formats 0 ms as "0:00"', () => {
    expect(formatDurationMs(0)).toBe('0:00');
  });

  it('formats 59_999 ms as "0:59"', () => {
    expect(formatDurationMs(59_999)).toBe('0:59');
  });

  it('formats 60_000 ms as "1:00"', () => {
    expect(formatDurationMs(60_000)).toBe('1:00');
  });

  it('formats 605_000 ms as "10:05"', () => {
    expect(formatDurationMs(605_000)).toBe('10:05');
  });

  it('formats 3_599_999 ms as "59:59"', () => {
    expect(formatDurationMs(3_599_999)).toBe('59:59');
  });

  it('formats 3_600_000 ms as "1:00:00"', () => {
    expect(formatDurationMs(3_600_000)).toBe('1:00:00');
  });

  it('formats 3_661_000 ms as "1:01:01"', () => {
    expect(formatDurationMs(3_661_000)).toBe('1:01:01');
  });

  it('returns "0:00" for negative values', () => {
    expect(formatDurationMs(-1)).toBe('0:00');
    expect(formatDurationMs(-1000)).toBe('0:00');
  });

  it('returns "0:00" for NaN', () => {
    expect(formatDurationMs(NaN)).toBe('0:00');
  });

  it('returns "0:00" for Infinity', () => {
    expect(formatDurationMs(Infinity)).toBe('0:00');
    expect(formatDurationMs(-Infinity)).toBe('0:00');
  });
});

describe('formatDurationSeconds', () => {
  it('formats 90 seconds as "1:30"', () => {
    expect(formatDurationSeconds(90)).toBe('1:30');
  });

  it('formats 3700 seconds as "1:01:40"', () => {
    expect(formatDurationSeconds(3700)).toBe('1:01:40');
  });

  it('formats 0 seconds as "0:00"', () => {
    expect(formatDurationSeconds(0)).toBe('0:00');
  });
});
