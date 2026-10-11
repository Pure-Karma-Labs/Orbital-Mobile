/**
 * Tests for the export routing + filename sanitizer (#878).
 *
 * Both halves exist because `content_type` and `file_name` are PEER-SUPPLIED:
 * our composer only posts photos and videos, so every other content type on a
 * row came from another client, and the name is a string that ends up in the
 * user's photo library or Files.
 */

import {
  DOCUMENT_EXTENSIONS,
  EXPORT_EXTENSIONS,
  PHOTO_LIBRARY_EXTENSIONS,
  buildExportFileName,
  fallbackExportStem,
  reconcileExportLabel,
  resolveExportRoute,
} from '../exportFileName';

describe('resolveExportRoute — photo library allowlist', () => {
  it.each(Object.entries(PHOTO_LIBRARY_EXTENSIONS))(
    'routes %s to the photo library as .%s',
    (contentType, extension) => {
      expect(resolveExportRoute(contentType)).toEqual({ kind: 'photo', extension });
    },
  );

  it('ignores content-type parameters and case', () => {
    expect(resolveExportRoute('IMAGE/JPEG; charset=binary')).toEqual({
      kind: 'photo',
      extension: 'jpg',
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(resolveExportRoute('  video/mp4  ')).toEqual({ kind: 'photo', extension: 'mp4' });
  });
});

describe('resolveExportRoute — document allowlist', () => {
  it.each(Object.entries(DOCUMENT_EXTENSIONS))(
    'routes %s to the document route as .%s',
    (contentType, extension) => {
      expect(resolveExportRoute(contentType)).toEqual({ kind: 'document', extension });
    },
  );

  it('sends image and video types outside the photo list to documents', () => {
    // A gallery that cannot display them is a worse destination than the
    // filesystem — these are not refusals.
    expect(resolveExportRoute('image/tiff').kind).toBe('document');
    expect(resolveExportRoute('video/webm').kind).toBe('document');
  });
});

describe('resolveExportRoute — refusals', () => {
  // Only a peer-crafted row can carry any of these.
  it.each([
    ['text/html', 'a saved page that runs script when opened'],
    ['image/svg+xml', 'XML with script'],
    ['application/x-apple-aspen-config', 'an iOS configuration profile'],
    ['application/vnd.android.package-archive', 'an apk'],
    ['application/x-dex', 'a dex'],
    ['application/java-archive', 'a jar'],
    ['application/x-msdownload', 'an exe'],
    ['application/x-sh', 'a shell script'],
    ['application/octet-stream', 'an unknown blob'],
    ['', 'an empty content type'],
    ['not-a-mime-type', 'a malformed content type'],
  ])('refuses %s (%s)', (contentType) => {
    expect(resolveExportRoute(contentType)).toEqual({ kind: 'refused' });
  });

  it('refuses null and undefined', () => {
    expect(resolveExportRoute(null)).toEqual({ kind: 'refused' });
    expect(resolveExportRoute(undefined)).toEqual({ kind: 'refused' });
  });

  it('refuses prototype-chain property names', () => {
    // `in` would have resolved these to Object.prototype functions; the maps
    // are read with hasOwnProperty for exactly this reason.
    expect(resolveExportRoute('constructor')).toEqual({ kind: 'refused' });
    expect(resolveExportRoute('toString')).toEqual({ kind: 'refused' });
    expect(resolveExportRoute('__proto__')).toEqual({ kind: 'refused' });
  });
});

describe('EXPORT_EXTENSIONS', () => {
  it('is the union of both maps, de-duplicated', () => {
    const union = new Set([
      ...Object.values(PHOTO_LIBRARY_EXTENSIONS),
      ...Object.values(DOCUMENT_EXTENSIONS),
    ]);
    expect(new Set(EXPORT_EXTENSIONS)).toEqual(union);
    expect(EXPORT_EXTENSIONS.length).toBe(union.size);
  });
});

describe('buildExportFileName', () => {
  const AT = Date.UTC(2026, 9, 9, 12, 0, 0);

  it.each([
    // [label, input, expected]
    ['a plain name keeps its stem', 'Beach day.jpg', 'Beach day.jpg'],
    ['the extension comes from the map, not the name', 'photo.exe', 'photo.jpg'],
    ['a slash is replaced, never treated as a path', 'a/b/c.jpg', 'a-b-c.jpg'],
    ['a backslash is replaced', 'a\\b.jpg', 'a-b.jpg'],
    // `..` -> `-` per segment, dot runs collapse, leading dots are trimmed.
    ['traversal dots collapse', '../../etc/passwd', '-.-etc-passwd.jpg'],
    ['a leading dot is trimmed (no hidden files)', '.tmp', 'tmp.jpg'],
    ['dot-only names fall back', '...', 'Orbital-20261009-120000.jpg'],
    ['reserved characters are replaced', 'a:b*c?d"e<f>g|h.jpg', 'a-b-c-d-e-f-g-h.jpg'],
    ['trailing spaces and dots go', 'report.  . ', 'report.jpg'],
    ['whitespace runs collapse', 'a     b.jpg', 'a b.jpg'],
  ])('%s', (_label, input, expected) => {
    // AT is pinned so the fallback row is deterministic. The fallback uses
    // LOCAL time, so build the expectation the same way when it is used.
    const result = buildExportFileName(input, 'jpg', AT);
    if (expected.startsWith('Orbital-')) {
      expect(result).toBe(`${fallbackExportStem(AT)}.jpg`);
    } else {
      expect(result).toBe(expected);
    }
  });

  it('strips bidi overrides that disguise the extension', () => {
    // evil.txt<RLO>gpj.exe renders as "evil.txtexe.jpg" in a file browser.
    const name = `evil.txt\u202Egpj.exe`;
    const out = buildExportFileName(name, 'txt', AT);
    expect(out).not.toContain('\u202E');
    expect(out.endsWith('.txt')).toBe(true);
  });

  it('strips control characters', () => {
    const out = buildExportFileName('a\u0000b\u001Fc\u007F.jpg', 'jpg', AT);
    expect(out).toBe('abc.jpg');
  });

  it('strips zero-width characters', () => {
    const out = buildExportFileName('a\u200Bb\uFEFFc.jpg', 'jpg', AT);
    expect(out).toBe('abc.jpg');
  });

  it('falls back for an empty name', () => {
    expect(buildExportFileName('', 'png', AT)).toBe(`${fallbackExportStem(AT)}.png`);
  });

  it('falls back for null and undefined', () => {
    expect(buildExportFileName(null, 'png', AT)).toBe(`${fallbackExportStem(AT)}.png`);
    expect(buildExportFileName(undefined, 'png', AT)).toBe(`${fallbackExportStem(AT)}.png`);
  });

  it('caps the TOTAL length at 100 characters', () => {
    const out = buildExportFileName('x'.repeat(400), 'jpeg', AT);
    expect(out.length).toBe(100);
    expect(out.endsWith('.jpeg')).toBe(true);
  });

  it('never ends the capped stem on a dot or space', () => {
    const out = buildExportFileName(`${'a'.repeat(94)}. b.jpg`, 'jpg', AT);
    expect(out.endsWith('.jpg')).toBe(true);
    expect(out.replace(/\.jpg$/, '')).not.toMatch(/[.\s]$/);
  });

  it('NFC-normalizes so the cap counts what the filesystem will', () => {
    // "é" decomposed (e + combining acute) vs composed.
    const out = buildExportFileName('cafe\u0301.jpg', 'jpg', AT);
    expect(out).toBe('caf\u00E9.jpg');
  });

  it('keeps a version-like trailing segment that is not an extension', () => {
    expect(buildExportFileName('Report v1.2', 'pdf', AT)).toBe('Report v1.2.pdf');
  });

  describe('the invariants the native layer re-validates', () => {
    const HOSTILE = [
      '',
      '.',
      '..',
      '../../etc/passwd',
      '/absolute/path.jpg',
      'C:\\windows\\system32.jpg',
      '.hidden',
      '\u202Eexe.gpj',
      '\u0000',
      ' ',
      'x'.repeat(500),
      'a/b\\c:d*e?f"g<h>i|j',
    ];

    it.each(HOSTILE)('%j produces a safe basename', (input) => {
      const out = buildExportFileName(input, 'jpg', AT);
      expect(out.length).toBeGreaterThan(0);
      expect(out.length).toBeLessThanOrEqual(100);
      expect(out.startsWith('.')).toBe(false);
      expect(out.startsWith('/')).toBe(false);
      expect(out).not.toContain('/');
      expect(out).not.toContain('\\');
      expect(out.split('/')).not.toContain('..');
      expect(out).not.toMatch(/\.\./);
      expect(out.endsWith('.jpg')).toBe(true);
    });
  });
});

describe('fallbackExportStem', () => {
  it('formats as Orbital-YYYYMMDD-HHmmss in local time', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(fallbackExportStem(at)).toBe('Orbital-20260102-030405');
  });

  it('uses now for a missing or nonsense timestamp', () => {
    expect(fallbackExportStem(0)).toMatch(/^Orbital-\d{8}-\d{6}$/);
    expect(fallbackExportStem(Number.NaN)).toMatch(/^Orbital-\d{8}-\d{6}$/);
  });
});

describe('resolveExportRoute — audited aliases (#880)', () => {
  // react-native-image-picker labels every JPEG it hands back on iOS
  // `image/jpg`, so before the alias existed save-to-device refused EVERY
  // iOS-posted photo.
  it('routes image/jpg as a JPEG', () => {
    expect(resolveExportRoute('image/jpg')).toEqual({ kind: 'photo', extension: 'jpg' });
  });

  it('aliases through case and parameters', () => {
    expect(resolveExportRoute('IMAGE/JPG; q=1')).toEqual({ kind: 'photo', extension: 'jpg' });
  });

  it('gives an image/jpg row a .jpg name', () => {
    const route = resolveExportRoute('image/jpg');
    if (route.kind === 'refused') {
      throw new Error('image/jpg must alias to image/jpeg');
    }
    expect(
      buildExportFileName('iOS photo.jpg', route.extension, Date.UTC(2026, 9, 9, 12, 0, 0)),
    ).toBe('iOS photo.jpg');
  });

  it('still refuses image/pjpeg', () => {
    // Deliberately NOT an alias: the bar for one is "a real client emits this
    // on the wire", and nothing in our pipeline does.
    expect(resolveExportRoute('image/pjpeg')).toEqual({ kind: 'refused' });
  });
});

describe('reconcileExportLabel', () => {
  it.each([
    // [declared, sniffed, contentType, extension]
    // The bytes are the only honest description of a file: the upload pipeline
    // re-encodes stills, so an `image/heic` row routinely names JPEG bytes.
    ['image/heic', 'image/jpeg', 'image/jpeg', 'jpg'],
    // The sniff is advisory — null leaves the declared type, which has already
    // been through the allowlist.
    ['image/heic', null, 'image/heic', 'heic'],
    ['image/jpg', null, 'image/jpeg', 'jpg'],
    ['application/pdf', 'image/png', 'image/png', 'png'],
    ['video/mp4', 'video/quicktime', 'video/quicktime', 'mov'],
    // A refused sniff never wins: text/html is exactly what a hostile peer
    // would want written to disk, and the declared type is already safe.
    ['image/heic', 'text/html', 'image/heic', 'heic'],
    // HEIC and HEIF are one container with different brands and one
    // destination; the brands in a short head are not enough to rename a
    // user's file over, so the declared spelling is kept BOTH ways.
    ['image/heic', 'image/heif', 'image/heic', 'heic'],
    ['image/heif', 'image/heic', 'image/heif', 'heif'],
    // ...and the family rule needs BOTH sides in the family, so a JPEG row
    // whose bytes are really HEIC is still corrected.
    ['image/jpeg', 'image/heic', 'image/heic', 'heic'],
  ] as [string, string | null, string, string][])(
    'labels a %s row sniffed as %s with %s/.%s',
    (declared, sniffed, contentType, extension) => {
      expect(reconcileExportLabel(declared, sniffed)).toEqual({ contentType, extension });
    },
  );

  it.each([['text/html'], ['constructor']])(
    'throws for the refused declared type %s',
    (declared) => {
      // Refusal happens before the download and before the disclosure, so
      // reaching here with a refused type means a caller skipped that gate —
      // which must be loud, not silently relabelled into something saveable.
      expect(() => reconcileExportLabel(declared, 'image/jpeg')).toThrow();
    },
  );

  describe('never returns a refused label', () => {
    const DECLARED = [
      ...Object.keys(PHOTO_LIBRARY_EXTENSIONS),
      ...Object.keys(DOCUMENT_EXTENSIONS),
    ];
    const SNIFFED: (string | null)[] = [null, 'image/jpeg', 'text/html', 'who-knows/what'];

    const ROWS: [string, string | null][] = DECLARED.flatMap((declared) =>
      SNIFFED.map((sniffed): [string, string | null] => [declared, sniffed]),
    );

    it.each(ROWS)('%s sniffed as %s stays saveable', (declared, sniffed) => {
      const result = reconcileExportLabel(declared, sniffed);
      const route = resolveExportRoute(result.contentType);
      expect(route.kind).not.toBe('refused');
      if (route.kind === 'refused') return;
      // The pair comes from ONE route lookup, so it can never disagree.
      expect(result.extension).toBe(route.extension);
    });
  });
});
