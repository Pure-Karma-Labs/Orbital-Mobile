import type {
  OrbitalSenderKeyStore,
  ProtocolAddressData,
} from 'orbital-signal';
import {
  getSenderKey,
  saveSenderKey,
} from '../../database/repositories/signalSenderKeyRepository';
import { toArrayBuffer } from './utils';

export class SenderKeyStoreImpl implements OrbitalSenderKeyStore {
  private readonly localServiceId: string;

  constructor(localServiceId: string) {
    this.localServiceId = localServiceId;
  }

  storeSenderKey(
    sender: ProtocolAddressData,
    distributionId: string,
    record: ArrayBuffer,
  ): void {
    saveSenderKey({
      our_service_id: this.localServiceId,
      sender_id: sender.name,
      distribution_id: distributionId,
      record: new Uint8Array(record),
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  loadSenderKey(
    sender: ProtocolAddressData,
    distributionId: string,
  ): ArrayBuffer | undefined {
    const row = getSenderKey(
      this.localServiceId,
      sender.name,
      distributionId,
    );
    if (row === null) {
      return undefined;
    }
    return toArrayBuffer(row.record);
  }
}
