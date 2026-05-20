/**
 * Tests for the device ID helper.
 */

const mockGetString = jest.fn();
const mockSet = jest.fn();

jest.mock('../../stores/middleware/persistence', () => ({
  getMMKVInstance: () => ({
    getString: mockGetString,
    set: mockSet,
  }),
}));

jest.mock('../../utils/uuid', () => ({
  generateUUID: jest.fn().mockReturnValue('generated-uuid-v4'),
}));

import { getDeviceId } from '../deviceId';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getDeviceId', () => {
  it('returns existing device ID from MMKV if present', () => {
    mockGetString.mockReturnValue('existing-device-id');

    const id = getDeviceId();

    expect(id).toBe('existing-device-id');
    expect(mockGetString).toHaveBeenCalledWith('orbital:device-id');
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('generates and persists a new UUID if no device ID exists', () => {
    mockGetString.mockReturnValue(undefined);

    const id = getDeviceId();

    expect(id).toBe('generated-uuid-v4');
    expect(mockSet).toHaveBeenCalledWith('orbital:device-id', 'generated-uuid-v4');
  });

  it('returns the same ID on subsequent calls (idempotent via MMKV)', () => {
    // First call: no existing ID
    mockGetString.mockReturnValueOnce(undefined);
    const first = getDeviceId();

    // Second call: MMKV now has the ID
    mockGetString.mockReturnValueOnce('generated-uuid-v4');
    const second = getDeviceId();

    expect(first).toBe(second);
    // Only one write
    expect(mockSet).toHaveBeenCalledTimes(1);
  });
});
