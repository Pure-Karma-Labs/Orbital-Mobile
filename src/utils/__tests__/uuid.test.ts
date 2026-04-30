/**
 * Tests for UUID v4 generation utility.
 */

import { generateUUID } from '../uuid';

describe('generateUUID', () => {
  it('returns a string in UUID v4 format', () => {
    const uuid = generateUUID();
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(uuid).toMatch(uuidV4Regex);
  });

  it('generates unique values on consecutive calls', () => {
    const uuid1 = generateUUID();
    const uuid2 = generateUUID();
    expect(uuid1).not.toBe(uuid2);
  });

  it('has version 4 marker at correct position', () => {
    const uuid = generateUUID();
    // Character at index 14 (5th group of the first section, after second hyphen)
    expect(uuid[14]).toBe('4');
  });

  it('has correct variant bits', () => {
    const uuid = generateUUID();
    // Character at index 19 (after third hyphen) must be 8, 9, a, or b
    expect('89ab').toContain(uuid[19]);
  });

  it('generates 36-character strings', () => {
    const uuid = generateUUID();
    expect(uuid).toHaveLength(36);
  });
});
