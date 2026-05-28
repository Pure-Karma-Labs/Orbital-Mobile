jest.mock('orbital-signal', () => ({
  groupEncrypt: jest.fn(),
  groupDecrypt: jest.fn(),
  createSenderKeyDistributionMessage: jest.fn(),
  processSenderKeyDistributionMessage: jest.fn(),
}));

jest.mock('../../../database/repositories/signalSenderKeyRepository', () => ({
  getSenderKey: jest.fn(),
  saveSenderKey: jest.fn(),
}));

jest.mock('../../../database/connection', () => ({
  getDatabase: jest.fn(),
}));

const mockGetState = jest.fn(() => ({ userId: 'local-user-id' }));
jest.mock('../../../stores/useAppStore', () => ({
  useAppStore: {
    getState: () => mockGetState(),
  },
}));

import {
  groupEncrypt,
  groupDecrypt,
  createSenderKeyDistributionMessage,
  processSenderKeyDistributionMessage,
} from 'orbital-signal';
import {
  getSenderKey,
  saveSenderKey,
} from '../../../database/repositories/signalSenderKeyRepository';
import { getDatabase } from '../../../database/connection';

import {
  encryptGroup,
  decryptGroup,
  createSenderKeyDistribution,
  processSenderKeyDistribution,
} from '../cryptoService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArrayBuffer(size: number, fill = 0xab): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  new Uint8Array(buf).fill(fill);
  return buf;
}

function makeUint8Array(size: number, fill = 0xab): Uint8Array {
  const arr = new Uint8Array(size);
  arr.fill(fill);
  return arr;
}

const mockDb = { executeSync: jest.fn() };

const mockAddress = { name: 'recipient-uuid', deviceId: 1 };

function setupDefaultMocks(): void {
  mockGetState.mockReturnValue({ userId: 'local-user-id' });
  (getDatabase as jest.Mock).mockReturnValue(mockDb);
  mockDb.executeSync.mockReturnValue(undefined);

  (groupEncrypt as jest.Mock).mockResolvedValue({
    ciphertext: makeArrayBuffer(64, 0x50),
    updatedSenderKeyRecord: makeArrayBuffer(128, 0x51),
  });

  (groupDecrypt as jest.Mock).mockResolvedValue({
    plaintext: makeArrayBuffer(16, 0x60),
    updatedSenderKeyRecord: makeArrayBuffer(128, 0x61),
  });

  (createSenderKeyDistributionMessage as jest.Mock).mockResolvedValue({
    distributionMessage: makeArrayBuffer(64, 0x70),
    updatedSenderKeyRecord: makeArrayBuffer(128, 0x71),
  });

  (processSenderKeyDistributionMessage as jest.Mock).mockResolvedValue({
    updatedSenderKeyRecord: makeArrayBuffer(128, 0x81),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  setupDefaultMocks();
});

// ---------------------------------------------------------------------------
// Group operations
// ---------------------------------------------------------------------------

describe('encryptGroup', () => {
  it('encrypts and saves updated sender key', async () => {
    (getSenderKey as jest.Mock).mockReturnValue({
      record: makeUint8Array(128, 0x50),
    });

    const ciphertext = await encryptGroup(
      'dist-uuid',
      mockAddress,
      makeUint8Array(16),
    );

    expect(groupEncrypt).toHaveBeenCalledTimes(1);
    expect(ciphertext).toBeInstanceOf(Uint8Array);
    expect(saveSenderKey).toHaveBeenCalledTimes(1);
    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('COMMIT');
  });
});

describe('decryptGroup', () => {
  it('decrypts and saves updated sender key', async () => {
    (getSenderKey as jest.Mock).mockReturnValue({
      record: makeUint8Array(128, 0x60),
    });

    const plaintext = await decryptGroup(
      mockAddress,
      'dist-uuid',
      makeUint8Array(64),
    );

    expect(groupDecrypt).toHaveBeenCalledTimes(1);
    expect(plaintext).toBeInstanceOf(Uint8Array);
    expect(saveSenderKey).toHaveBeenCalledTimes(1);
  });
});

describe('createSenderKeyDistribution', () => {
  it('creates SKDM and saves sender key', async () => {
    (getSenderKey as jest.Mock).mockReturnValue(null);

    const msg = await createSenderKeyDistribution('dist-uuid', mockAddress);

    expect(createSenderKeyDistributionMessage).toHaveBeenCalledTimes(1);
    expect(msg).toBeInstanceOf(Uint8Array);
    expect(saveSenderKey).toHaveBeenCalledTimes(1);
  });
});

describe('processSenderKeyDistribution', () => {
  it('processes SKDM and saves sender key', async () => {
    (getSenderKey as jest.Mock).mockReturnValue(null);

    await processSenderKeyDistribution(
      mockAddress,
      'dist-uuid',
      makeUint8Array(64),
    );

    expect(processSenderKeyDistributionMessage).toHaveBeenCalledTimes(1);
    expect(saveSenderKey).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Group operations — null sender key
// ---------------------------------------------------------------------------

describe('group operations — null sender key', () => {
  it('encryptGroup passes undefined senderKeyRecord when getSenderKey returns null', async () => {
    (getSenderKey as jest.Mock).mockReturnValue(null);

    await encryptGroup('dist-uuid', mockAddress, makeUint8Array(16));

    expect(groupEncrypt).toHaveBeenCalledTimes(1);
    const input = (groupEncrypt as jest.Mock).mock.calls[0][0];
    expect(input.senderKeyRecord).toBeUndefined();
    expect(saveSenderKey).toHaveBeenCalledTimes(1);
  });

  it('decryptGroup passes undefined senderKeyRecord when getSenderKey returns null', async () => {
    (getSenderKey as jest.Mock).mockReturnValue(null);

    await decryptGroup(mockAddress, 'dist-uuid', makeUint8Array(64));

    expect(groupDecrypt).toHaveBeenCalledTimes(1);
    const input = (groupDecrypt as jest.Mock).mock.calls[0][0];
    expect(input.senderKeyRecord).toBeUndefined();
    expect(saveSenderKey).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Transaction safety
// ---------------------------------------------------------------------------

describe('transaction safety', () => {
  it('rolls back when saveSenderKey throws during encryptGroup', async () => {
    (getSenderKey as jest.Mock).mockReturnValue({
      record: makeUint8Array(128, 0x50),
    });
    (saveSenderKey as jest.Mock).mockImplementation(() => {
      throw new Error('sender key write failure');
    });

    await expect(
      encryptGroup('dist-uuid', mockAddress, makeUint8Array(16)),
    ).rejects.toThrow('sender key write failure');

    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('ROLLBACK');
    expect(mockDb.executeSync).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back when saveSenderKey throws during createSenderKeyDistribution', async () => {
    (getSenderKey as jest.Mock).mockReturnValue(null);
    (saveSenderKey as jest.Mock).mockImplementation(() => {
      throw new Error('sender key write failure');
    });

    await expect(
      createSenderKeyDistribution('dist-uuid', mockAddress),
    ).rejects.toThrow('sender key write failure');

    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('ROLLBACK');
    expect(mockDb.executeSync).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rolls back when saveSenderKey throws during processSenderKeyDistribution', async () => {
    (getSenderKey as jest.Mock).mockReturnValue(null);
    (saveSenderKey as jest.Mock).mockImplementation(() => {
      throw new Error('sender key write failure');
    });

    await expect(
      processSenderKeyDistribution(mockAddress, 'dist-uuid', makeUint8Array(64)),
    ).rejects.toThrow('sender key write failure');

    expect(mockDb.executeSync).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockDb.executeSync).toHaveBeenCalledWith('ROLLBACK');
    expect(mockDb.executeSync).not.toHaveBeenCalledWith('COMMIT');
  });
});

// ---------------------------------------------------------------------------
// getLocalServiceId
// ---------------------------------------------------------------------------

describe('getLocalServiceId', () => {
  it('throws when userId is null', async () => {
    mockGetState.mockReturnValue({ userId: null as unknown as string });

    await expect(
      encryptGroup('dist-uuid', mockAddress, makeUint8Array(16)),
    ).rejects.toThrow('Not authenticated — userId not available');
  });
});
