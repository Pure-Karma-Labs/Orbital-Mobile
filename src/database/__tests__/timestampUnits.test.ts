import { SECONDS_CEILING, toMillis } from '../timestampUnits';

describe('timestampUnits.toMillis', () => {
  it('scales a legacy epoch-seconds value to ms', () => {
    // 1758800000 s = 2025-09-25T...Z
    expect(toMillis(1758800000)).toBe(1758800000000);
  });

  it('leaves an epoch-ms value unchanged', () => {
    expect(toMillis(1758800000123)).toBe(1758800000123);
  });

  it('treats exactly SECONDS_CEILING as ms', () => {
    expect(SECONDS_CEILING).toBe(1e11);
    expect(toMillis(SECONDS_CEILING)).toBe(1e11);
  });

  it('treats SECONDS_CEILING - 1 as seconds', () => {
    expect(toMillis(SECONDS_CEILING - 1)).toBe((SECONDS_CEILING - 1) * 1000);
  });

  it('maps non-finite and non-number input to 0', () => {
    expect(toMillis(NaN)).toBe(0);
    expect(toMillis(Infinity)).toBe(0);
    expect(toMillis(-Infinity)).toBe(0);
    // Defensive runtime guard: SQLite can hand back a non-number for a
    // malformed column, which TypeScript cannot rule out at the row boundary.
    expect(toMillis(undefined as unknown as number)).toBe(0);
    expect(toMillis('1758800000' as unknown as number)).toBe(0);
  });
});
