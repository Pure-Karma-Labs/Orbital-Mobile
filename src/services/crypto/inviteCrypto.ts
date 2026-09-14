import {inviteEncryptGroupKey, inviteDecryptGroupKey} from 'orbital-signal';
import {
  toArrayBuffer,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  encodeUTF8,
} from './utils';

const CROCKFORD_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Character count of a v2 invite code, dashes stripped. */
export const V2_CODE_LENGTH = 20;

/**
 * Length-only check on a stripped (dash-free) invite code, so a screen can
 * reject a mistyped code before spending a request. It does NOT validate the
 * Crockford base32 alphabet or any checksum, hence the name — a 20-character
 * string of the wrong characters passes here and fails at the server.
 *
 * Provenance: the 20-character rule is enforced by the signup route
 * (`Orbital-Backend/src/routes/auth.js`: "must be a 20-character v2 code").
 * The join route (`src/routes/groups.js:226-229`) only checks that
 * `invite_code` is present, so this guard is strictly a client-side courtesy
 * there, not a mirror of a server rule.
 */
export function hasV2InviteCodeLength(strippedCode: string): boolean {
  return strippedCode.length === V2_CODE_LENGTH;
}

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
