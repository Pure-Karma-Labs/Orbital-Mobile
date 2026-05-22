import { getItem } from '../../database/repositories/itemRepository';
import { getCachedIdentityPrivateKeyHex } from './keyGenerationService';
import { hexToUint8Array, toArrayBuffer } from './utils';

const IDENTITY_KEY_PUBLIC_ITEM = 'identityKeyPublic';

export function getIdentityKeyPair(): {
  privateKey: ArrayBuffer;
  publicKey: ArrayBuffer;
} {
  const privHex = getCachedIdentityPrivateKeyHex();
  const pubHex = getItem(IDENTITY_KEY_PUBLIC_ITEM);
  if (!privHex || !pubHex) {
    throw new Error('Identity key pair not available');
  }
  return {
    privateKey: toArrayBuffer(hexToUint8Array(privHex)),
    publicKey: toArrayBuffer(hexToUint8Array(pubHex)),
  };
}
