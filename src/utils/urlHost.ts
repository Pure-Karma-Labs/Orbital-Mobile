/**
 * The ONE definition of "the host of this URL", for display (#927 §7).
 *
 * ## Why not `new URL()`
 *
 * React Native's `URL` is a shim, not Node's WHATWG implementation, and the
 * two differ in exactly the places this function is used: the RN shim does no
 * IDNA/percent normalisation, and historically returned the whole authority
 * (userinfo and port included) from `hostname` on some versions. Jest runs
 * under Node, so a `URL`-based host would be tested against an implementation
 * the app does not ship — the test would pass and the row would read
 * `user@evil.example.com:8443`. A regex has the same behaviour in both.
 *
 * It is deliberately a DISPLAY helper: it never decides what to open, fetch or
 * trust. `EmojiText`'s link handler still re-checks the scheme on the raw URL
 * before `Linking.openURL`.
 *
 * Callers: `LinkPreviewCard` (the domain line) and `threadHeadline` (a body
 * that is nothing but a link). They had two different definitions before this.
 */

import { stripFormatChars } from './urlPattern';

/**
 * `scheme://authority`, capturing the authority — everything up to the first
 * `/`, `?` or `#`. An input with no scheme separator matches nothing, which is
 * what makes a bare `example.com` (or a sentence) return null rather than a
 * made-up host.
 */
const AUTHORITY_RE = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;

/**
 * Characters that cannot appear in a host. A match means the input was not a
 * URL we can name a host for, so the caller gets null instead of a fragment of
 * one. (The brackets are stripped from an IPv6 literal before this test.)
 *
 * `%` is in the set because this function does NOT percent-decode, and a host
 * that needs decoding is a spoof: `https://paypal.com%2Eevil.test/` is served
 * by `evil.test` but would otherwise be shown as the whole run, which reads as
 * `paypal.com` followed by noise. Returning null makes the caller fall back to
 * "Link". An IPv6 zone id (`[fe80::1%25eth0]`) is the only legitimate host
 * with a percent in it, and it is not something a shared post carries.
 */
const NOT_A_HOST_RE = /[\s/?#@[\]:%]/;

/**
 * The host of `url`, lowercased, or `null` when it has none.
 *
 * Normalisation, in order: Unicode format characters removed (a bidi override
 * in a host is a spoof, never a legitimate host); userinfo dropped up to the
 * LAST `@`, because `https://example.com@evil.test/` is served by evil.test;
 * port dropped; trailing root dots dropped; a leading `www.` dropped; the
 * result lowercased.
 *
 * Total: it never throws, for any string.
 *
 * @example
 *   extractUrlHost('https://www.Example.com:8443/a?b#c') // 'example.com'
 *   extractUrlHost('https://user:pw@a@evil.test/')       // 'evil.test'
 *   extractUrlHost('https://[::1]:8080/')                // '::1'
 *   extractUrlHost('example.com')                        // null
 */
export function extractUrlHost(url: string): string | null {
  if (typeof url !== 'string') return null;

  const match = AUTHORITY_RE.exec(stripFormatChars(url).trim());
  if (match === null) return null;

  let authority = match[1];

  // Userinfo: up to the LAST '@'. A URL may legitimately carry only one, but
  // a hostile one carries two, and the host is always what follows the last.
  const at = authority.lastIndexOf('@');
  if (at !== -1) authority = authority.slice(at + 1);

  let host: string;
  if (authority.startsWith('[')) {
    // IPv6 literal: the brackets delimit the host, and the colons inside it
    // are part of the address rather than a port separator.
    const close = authority.indexOf(']');
    if (close === -1) return null;
    host = authority.slice(1, close);
    // The brackets may hold an IPv6 address and nothing else: hex groups and
    // colons, an optional embedded dotted quad, and an optional zone id
    // (`%25eth0`). Anything else — a name, a percent-encoded dot — is not a
    // host this function will display, however it is wrapped.
    if (!/^[0-9a-f:.]+(?:%25[0-9a-z_.~-]+)?$/i.test(host) || !host.includes(':')) return null;
    return host.toLowerCase();
  }

  const colon = authority.indexOf(':');
  host = colon === -1 ? authority : authority.slice(0, colon);

  // Trailing root dots ("example.com." is the same host, fully qualified).
  host = host.replace(/\.+$/, '');

  if (host === '' || NOT_A_HOST_RE.test(host)) return null;

  host = host.toLowerCase();

  // One leading 'www.', and only when something is left of the host after it —
  // the same rule LinkPreviewCard applied before this module existed.
  if (host.startsWith('www.') && host.length > 4) host = host.slice(4);

  return host;
}
