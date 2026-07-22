import { formatMB } from '../formatBytes';

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
