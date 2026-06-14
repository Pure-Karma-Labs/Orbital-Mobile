/**
 * Tests for UUID v4 generation utility.
 */

import { generateUUID, isValidUUIDv4 } from '../uuid';

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

describe('isValidUUIDv4', () => {
  it('accepts a valid v4 UUID', () => {
    expect(isValidUUIDv4('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('accepts uppercase hex', () => {
    expect(isValidUUIDv4('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('accepts UUIDs from generateUUID', () => {
    expect(isValidUUIDv4(generateUUID())).toBe(true);
  });

  it('rejects non-v4 version byte', () => {
    expect(isValidUUIDv4('550e8400-e29b-31d4-a716-446655440000')).toBe(false);
  });

  it('rejects invalid variant bits', () => {
    expect(isValidUUIDv4('550e8400-e29b-41d4-c716-446655440000')).toBe(false);
  });

  it('rejects too-short strings', () => {
    expect(isValidUUIDv4('550e8400-e29b-41d4')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidUUIDv4('')).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidUUIDv4('550e8400-e29b-41d4-a716-44665544zzzz')).toBe(false);
  });

  it('rejects strings without hyphens', () => {
    expect(isValidUUIDv4('550e8400e29b41d4a716446655440000')).toBe(false);
  });
});
