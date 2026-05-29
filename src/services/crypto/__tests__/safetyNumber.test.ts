import { computeSafetyNumber } from '../safetyNumber';

// Mock the Rust sha256Hash binding
jest.mock(
  '../../../../packages/orbital-signal/src/generated/orbital_signal',
  () => ({
    sha256Hash: jest.fn((data: ArrayBuffer) => {
      // Simple deterministic hash mock: XOR fold the input into 32 bytes
      const input = new Uint8Array(data);
      const output = new Uint8Array(32);
      for (let i = 0; i < input.length; i++) {
        output[i % 32] ^= input[i];
      }
      return output.buffer;
    }),
  }),
);

describe('computeSafetyNumber', () => {
  const userA = 'user-aaa-111';
  const userB = 'user-bbb-222';
  const keyA = new Uint8Array(33).fill(0xaa);
  const keyB = new Uint8Array(33).fill(0xbb);

  it('returns a 30-digit string in 6 groups of 5', () => {
    const result = computeSafetyNumber(userA, keyA, userB, keyB);

    // Format: "XXXXX XXXXX XXXXX XXXXX XXXXX XXXXX"
    expect(result).toMatch(/^\d{5}( \d{5}){5}$/);

    // Exactly 30 digits (excluding spaces)
    const digitsOnly = result.replace(/ /g, '');
    expect(digitsOnly).toHaveLength(30);
  });

  it('is symmetric — swapping local/remote produces the same result', () => {
    const forward = computeSafetyNumber(userA, keyA, userB, keyB);
    const reverse = computeSafetyNumber(userB, keyB, userA, keyA);

    expect(forward).toBe(reverse);
  });

  it('is deterministic — same inputs produce the same output', () => {
    const first = computeSafetyNumber(userA, keyA, userB, keyB);
    const second = computeSafetyNumber(userA, keyA, userB, keyB);

    expect(first).toBe(second);
  });

  it('produces different output for different keys', () => {
    const keyC = new Uint8Array(33).fill(0xcc);

    const resultAB = computeSafetyNumber(userA, keyA, userB, keyB);
    const resultAC = computeSafetyNumber(userA, keyA, userB, keyC);

    expect(resultAB).not.toBe(resultAC);
  });

  it('produces different output for different user IDs', () => {
    const userC = 'user-ccc-333';

    const resultAB = computeSafetyNumber(userA, keyA, userB, keyB);
    const resultAC = computeSafetyNumber(userA, keyA, userC, keyB);

    expect(resultAB).not.toBe(resultAC);
  });
});
