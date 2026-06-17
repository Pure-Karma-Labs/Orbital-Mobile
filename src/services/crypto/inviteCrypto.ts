import {inviteEncryptGroupKey, inviteDecryptGroupKey} from 'orbital-signal';
import {
  toArrayBuffer,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  encodeUTF8,
} from './utils';

const CROCKFORD_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const V2_CODE_LENGTH = 20;

export function generateInviteCode(): string {
  const bytes = new Uint8Array(V2_CODE_LENGTH);
  (
    globalThis as unknown as {crypto: {getRandomValues: (a: Uint8Array) => void}}
  ).crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < V2_CODE_LENGTH; i++) {
    code += CROCKFORD_CHARS[bytes[i] % 32];
  }
  return code;
}

export function formatInviteCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

export function stripInviteCode(formatted: string): string {
  return formatted.replace(/-/g, '').toUpperCase();
}

export function isV2InviteCode(code: string): boolean {
  return stripInviteCode(code).length === V2_CODE_LENGTH;
}

export function encryptGroupKeyForInvite(
  groupKey: Uint8Array,
  inviteCode: string,
  groupId: string,
): string {
  const codeBytes = toArrayBuffer(encodeUTF8(inviteCode));
  const groupIdBytes = toArrayBuffer(encodeUTF8(groupId));
  const blob = inviteEncryptGroupKey(
    toArrayBuffer(groupKey),
    codeBytes,
    groupIdBytes,
  );
  return arrayBufferToBase64(blob);
}

export function decryptGroupKeyFromInvite(
  encryptedGroupKeyBase64: string,
  inviteCode: string,
  groupId: string,
): Uint8Array {
  const blob = base64ToArrayBuffer(encryptedGroupKeyBase64);
  const codeBytes = toArrayBuffer(encodeUTF8(inviteCode));
  const groupIdBytes = toArrayBuffer(encodeUTF8(groupId));
  const plaintext = inviteDecryptGroupKey(blob, codeBytes, groupIdBytes);
  return new Uint8Array(plaintext);
}
