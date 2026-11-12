/**
 * Part-token fixtures, and the ONE base64url encoder behind them.
 *
 * Lives in the PACKAGE, not in the app's `__mocks__`, so the package's own
 * tests do not have to reach up into the app root for a fixture — and so there
 * is a single encoder instead of one copy per consumer (there were three:
 * `wrapper.test.ts`'s `btoaUrl`, the mock's `oarBase64url`, and the wrapper's
 * own private `base64UrlEncode`).
 *
 * This is NOT the wrapper's encoder. It is a deliberately independent
 * implementation whose output the real `decodeToken` must accept — the test
 * `the real decoder accepts the MOCK_TOKEN fixture` is what keeps the two
 * agreeing, and would fail if either drifted.
 *
 * ASCII only, which is all the JSON payloads below need. Hermes has no `btoa`
 * and this package pulls in no polyfill. (It DOES have `TextEncoder` — the
 * engine's gap is `TextDecoder`; see `utf8Encode` in `../index`.)
 */

import type { ArchivePartToken } from '../index';

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url, no padding — the same shape the wrapper's own encoder emits. */
export function oarBase64url(ascii: string): string {
  const bytes = Array.from(ascii, (c) => c.charCodeAt(0));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 === undefined) break;
    out += B64URL_ALPHABET[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 === undefined) break;
    out += B64URL_ALPHABET[b2 & 63];
  }
  return out;
}

/**
 * `oar1:` + base64url of whatever payload is given — including payloads the
 * real decoder must REFUSE, which is what the malformed-token cases need (e.g.
 * `oarTokenFromPayload('{"v":2}')`).
 */
export function oarTokenFromPayload(json: string): string {
  return `oar1:${oarBase64url(json)}`;
}

/**
 * A token the real `decodeToken` accepts: `{v:1, p:'ios', ref, persist}`.
 *
 * `p: 'ios'` is arbitrary — nothing in the wrapper rejects a token minted on
 * the other platform; only the ref would be meaningless there.
 */
export function makeOarToken(ref: string, persist = false): ArchivePartToken {
  return oarTokenFromPayload(
    JSON.stringify({ v: 1, p: 'ios', ref, persist }),
  ) as ArchivePartToken;
}

/** A ready-made valid token, for tests that just need one. */
export const MOCK_TOKEN: ArchivePartToken = makeOarToken('mock-archive-ref');
