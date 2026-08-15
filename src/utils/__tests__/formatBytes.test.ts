import { formatMB, formatMBPair } from '../formatBytes';

describe('formatMB', () => {
  it('returns "<1 MB" for sizes below 1 MB', () => {
    expect(formatMB(0)).toBe('<1 MB');
    expect(formatMB(512)).toBe('<1 MB');
    expect(formatMB(1024 * 1024 - 1)).toBe('<1 MB');
  });

  it('rounds to nearest MB for sizes in MB range', () => {
    expect(formatMB(1024 * 1024)).toBe('1 MB');
    expect(formatMB(24 * 1024 * 1024)).toBe('24 MB');
    expect(formatMB(1.5 * 1024 * 1024)).toBe('2 MB');
    expect(formatMB(100 * 1024 * 1024)).toBe('100 MB');
  });

  it('switches to GB at 1024 MB threshold', () => {
    expect(formatMB(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(formatMB(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
    expect(formatMB(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });
});

describe('formatMBPair', () => {
  const MB = 1024 * 1024;
  const GB = 1024 * MB;

  it('picks the unit from the TOTAL — both sides render in MB when total is below 1 GB', () => {
    expect(formatMBPair(5 * MB, 24 * MB)).toBe('5 MB / 24 MB');
    // A "sent" value that would independently cross the GB threshold still
    // renders in MB, because the unit is derived from `total` alone, not from
    // whichever side is larger.
    expect(formatMBPair(1.5 * GB, 900 * MB)).toBe('1536 MB / 900 MB');
  });

  it('switches both sides to GB (1 decimal) once total reaches 1 GB — never mixes MB with GB', () => {
    expect(formatMBPair(0.3 * GB, 1.4 * GB)).toBe('0.3 GB / 1.4 GB');
    expect(formatMBPair(0, GB)).toBe('0.0 GB / 1.0 GB');
  });

  it('floors sent at 0 for a negative value', () => {
    expect(formatMBPair(-5 * MB, 10 * MB)).toBe('0 MB / 10 MB');
  });

  it('renders a non-finite sent or total as 0 rather than NaN', () => {
    expect(formatMBPair(Number.NaN, 10 * MB)).toBe('0 MB / 10 MB');
    expect(formatMBPair(5 * MB, Number.POSITIVE_INFINITY)).toBe('5 MB / 0 MB');
  });
});
