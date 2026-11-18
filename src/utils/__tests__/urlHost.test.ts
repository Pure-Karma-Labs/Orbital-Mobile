/**
 * Tests for extractUrlHost (#927 §7).
 *
 * The suite is written against the SHIPPED behaviour, not against Node's
 * `URL`: the point of the module is that it behaves the same under Hermes and
 * under Jest, so nothing here compares it to `new URL(...)`.
 */

import { extractUrlHost } from '../urlHost';

describe('extractUrlHost', () => {
  it('returns the host of an ordinary http and https URL', () => {
    expect(extractUrlHost('https://example.com')).toBe('example.com');
    expect(extractUrlHost('http://example.com')).toBe('example.com');
    expect(extractUrlHost('https://news.example.co.uk/a/b')).toBe('news.example.co.uk');
  });

  it('ignores the path, query and fragment', () => {
    expect(extractUrlHost('https://example.com/path/to?x=1&y=2#frag')).toBe('example.com');
    expect(extractUrlHost('https://example.com?x=1')).toBe('example.com');
    expect(extractUrlHost('https://example.com#frag')).toBe('example.com');
    expect(extractUrlHost('https://example.com/')).toBe('example.com');
  });

  it('drops a leading www. but keeps any other subdomain', () => {
    expect(extractUrlHost('https://www.example.com/x')).toBe('example.com');
    expect(extractUrlHost('https://www2.example.com/x')).toBe('www2.example.com');
    expect(extractUrlHost('https://shop.www.example.com')).toBe('shop.www.example.com');
    // Only the first one: a host that is *about* www keeps the rest.
    expect(extractUrlHost('https://www.www.example.com')).toBe('www.example.com');
  });

  it('lowercases the host', () => {
    expect(extractUrlHost('https://WWW.Example.COM/Path')).toBe('example.com');
    // The PATH's case is irrelevant — it is not part of the answer.
    expect(extractUrlHost('https://example.com/CaseSensitivePath')).toBe('example.com');
  });

  it('drops the port', () => {
    expect(extractUrlHost('https://example.com:8443/x')).toBe('example.com');
    expect(extractUrlHost('http://localhost:8081')).toBe('localhost');
  });

  it('drops a trailing root dot', () => {
    expect(extractUrlHost('https://example.com./x')).toBe('example.com');
    expect(extractUrlHost('https://www.example.com.')).toBe('example.com');
  });

  // The spoof this function exists for: everything before the LAST '@' is
  // userinfo, so the host of `https://example.com@evil.test/` is evil.test.
  it('drops userinfo, up to the last @', () => {
    expect(extractUrlHost('https://user@example.com/x')).toBe('example.com');
    expect(extractUrlHost('https://user:password@example.com/x')).toBe('example.com');
    expect(extractUrlHost('https://example.com@evil.test/x')).toBe('evil.test');
    expect(extractUrlHost('https://a@b@evil.test/x')).toBe('evil.test');
    expect(extractUrlHost('https://user:pw@evil.test:8443/x')).toBe('evil.test');
  });

  it('strips invisible format characters rather than showing them', () => {
    // U+202E (RTL override) inside a host is a display spoof, never a host.
    expect(extractUrlHost('https://exa\u202Emple.com/x')).toBe('example.com');
    expect(extractUrlHost('https://example\u200B.com/x')).toBe('example.com');
  });

  it('handles an IPv6 literal, brackets and all', () => {
    expect(extractUrlHost('https://[::1]:8080/x')).toBe('::1');
    expect(extractUrlHost('https://[2001:DB8::1]/x')).toBe('2001:db8::1');
    // An unterminated literal is not a host.
    expect(extractUrlHost('https://[::1/x')).toBeNull();
  });

  it('accepts any scheme, because the caller decides what may be opened', () => {
    expect(extractUrlHost('ftp://files.example.com/x')).toBe('files.example.com');
    expect(extractUrlHost('orbital-app://example.com/x')).toBe('example.com');
  });

  it('returns null when there is no host to name', () => {
    expect(extractUrlHost('')).toBeNull();
    expect(extractUrlHost('example.com')).toBeNull();
    expect(extractUrlHost('just some words')).toBeNull();
    expect(extractUrlHost('https://')).toBeNull();
    expect(extractUrlHost('https:///path')).toBeNull();
    expect(extractUrlHost('https://@/x')).toBeNull();
    expect(extractUrlHost('https://.../x')).toBeNull();
    expect(extractUrlHost('//example.com/x')).toBeNull();
    expect(extractUrlHost('mailto:someone@example.com')).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(extractUrlHost('  https://example.com/x  ')).toBe('example.com');
    expect(extractUrlHost('\nhttps://example.com\n')).toBe('example.com');
  });

  it('never throws, for any input', () => {
    const hostile: readonly unknown[] = [
      null,
      undefined,
      42,
      {},
      [],
      'https://' + 'a'.repeat(5000) + '.com/x',
      'https://\u{1F600}.example.com',
    ];
    for (const value of hostile) {
      expect(() => extractUrlHost(value as string)).not.toThrow();
    }
    expect(extractUrlHost(null as unknown as string)).toBeNull();
    expect(extractUrlHost(undefined as unknown as string)).toBeNull();
    expect(extractUrlHost(42 as unknown as string)).toBeNull();
  });
});
