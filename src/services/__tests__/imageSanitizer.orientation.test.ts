/**
 * EXIF orientation tests for imageSanitizer.
 *
 * Two layers:
 *   1. readJpegOrientation -- the pure byte-level TIFF reader, driven by
 *      synthetic APP1 segments in both byte orders plus every malformed shape
 *      the bounds checks are supposed to reject.
 *   2. sanitizeStillImage routing -- proves a rotated JPEG takes the native
 *      re-encode path (which bakes the rotation into the pixels) BEFORE the
 *      strip drops the APP1 that carried the rotation, and that an upright
 *      JPEG still takes the cheap direct-strip path.
 *
 * Regression under test: react-native-image-picker's Android resize writes only
 * the orientation TAG back into its output; stripping the APP1 therefore left
 * portrait photos rendering landscape for every viewer.
 *
 * Run: npm test -- imageSanitizer.orientation
 */

jest.mock('@dr.pogodin/react-native-fs');

import {
  readJpegOrientation,
  sanitizeStillImage,
  hasExif,
} from '../media/imageSanitizer';

// ---------------------------------------------------------------------------
// Byte-level builders
// ---------------------------------------------------------------------------

type ByteOrder = 'II' | 'MM';

function u16(value: number, order: ByteOrder): number[] {
  return order === 'II'
    ? [value & 0xFF, (value >> 8) & 0xFF]
    : [(value >> 8) & 0xFF, value & 0xFF];
}

function u32(value: number, order: ByteOrder): number[] {
  return order === 'II'
    ? [value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, (value >>> 24) & 0xFF]
    : [(value >>> 24) & 0xFF, (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF];
}

interface TiffOpts {
  order?: ByteOrder;
  /** Orientation tag value; omit (undefined) to leave the tag out entirely. */
  orientation?: number;
  /** Field type for the orientation entry: 3 = SHORT (default), 4 = LONG. */
  orientationType?: number;
  /** Emit an unrelated Make tag before Orientation (entry-walk coverage). */
  includeMakeTag?: boolean;
  /** Override the IFD0 offset written into the TIFF header. */
  ifd0Offset?: number;
  /** Override the entry count written into IFD0 (does not change real entries). */
  entryCount?: number;
  /** Override the TIFF magic number (real value is 42). */
  magic?: number;
}

/** TIFF structure as it appears inside an Exif APP1, starting at the "II"/"MM". */
function buildTiff(opts: TiffOpts = {}): number[] {
  const {
    order = 'II',
    orientation,
    orientationType = 3,
    includeMakeTag = false,
    ifd0Offset = 8,
    entryCount,
    magic = 42,
  } = opts;

  const entries: number[][] = [];

  if (includeMakeTag) {
    // Make (0x010F), ASCII, count 4, value "Cam\0" stored inline.
    entries.push([
      ...u16(0x010F, order),
      ...u16(2, order),
      ...u32(4, order),
      0x43, 0x61, 0x6D, 0x00,
    ]);
  }

  if (orientation !== undefined) {
    // A single SHORT lives in the first 2 bytes of the 4-byte value field;
    // a LONG fills all 4.
    const valueField = orientationType === 4
      ? u32(orientation, order)
      : [...u16(orientation, order), 0x00, 0x00];
    entries.push([
      ...u16(0x0112, order),
      ...u16(orientationType, order),
      ...u32(1, order),
      ...valueField,
    ]);
  }

  const bom = order === 'II' ? [0x49, 0x49] : [0x4D, 0x4D];

  return [
    ...bom,
    ...u16(magic, order),
    ...u32(ifd0Offset, order),
    ...u16(entryCount ?? entries.length, order),
    ...entries.flat(),
    ...u32(0, order), // next IFD = 0
  ];
}

interface JpegOpts extends TiffOpts {
  /** Emit an XMP APP1 before the Exif APP1 (multi-APP1 walk coverage). */
  includeXmpApp1?: boolean;
  /** Skip the Exif APP1 entirely. */
  omitExifApp1?: boolean;
  /** Override the APP1 payload byte count written into the length field. */
  declaredPayloadBytes?: number;
}

/** Minimal structurally valid JPEG carrying an Exif APP1. */
function buildJpegWithExif(opts: JpegOpts = {}): Uint8Array {
  const parts: number[] = [];

  // SOI
  parts.push(0xFF, 0xD8);

  // APP0 JFIF -- kept by the stripper, skipped by the orientation walk.
  const jfif = [0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  parts.push(0xFF, 0xE0, ...u16(jfif.length + 2, 'MM'), ...jfif);

  if (opts.includeXmpApp1) {
    const xmp = Array.from(
      new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'),
    );
    parts.push(0xFF, 0xE1, ...u16(xmp.length + 2, 'MM'), ...xmp);
  }

  if (!opts.omitExifApp1) {
    const payload = [
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
      ...buildTiff(opts),
    ];
    const declared = opts.declaredPayloadBytes ?? payload.length;
    parts.push(0xFF, 0xE1, ...u16(declared + 2, 'MM'), ...payload);
  }

  // SOF0
  const sof = [0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  parts.push(0xFF, 0xC0, ...u16(sof.length + 2, 'MM'), ...sof);

  // SOS + entropy-coded data + EOI
  const sos = [0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00];
  parts.push(0xFF, 0xDA, ...u16(sos.length + 2, 'MM'), ...sos);
  parts.push(0xAA, 0xBB, 0xCC);
  parts.push(0xFF, 0xD9);

  return new Uint8Array(parts);
}

// ---------------------------------------------------------------------------
// readJpegOrientation
// ---------------------------------------------------------------------------

describe('readJpegOrientation', () => {
  describe('byte orders and values', () => {
    for (const order of ['II', 'MM'] as ByteOrder[]) {
      for (const orientation of [1, 3, 6, 8]) {
        it(`reads orientation ${orientation} from a ${order} TIFF`, () => {
          const jpeg = buildJpegWithExif({ order, orientation });
          expect(readJpegOrientation(jpeg)).toBe(orientation);
        });
      }
    }

    it('reads orientation stored as a LONG rather than a SHORT', () => {
      const jpeg = buildJpegWithExif({ order: 'MM', orientation: 6, orientationType: 4 });
      expect(readJpegOrientation(jpeg)).toBe(6);
    });

    it('walks past unrelated IFD0 entries to find the orientation tag', () => {
      const jpeg = buildJpegWithExif({ order: 'II', orientation: 8, includeMakeTag: true });
      expect(readJpegOrientation(jpeg)).toBe(8);
    });

    it('walks past an XMP APP1 to reach the Exif APP1', () => {
      const jpeg = buildJpegWithExif({ orientation: 6, includeXmpApp1: true });
      expect(readJpegOrientation(jpeg)).toBe(6);
    });
  });

  describe('absent or unreadable', () => {
    it('returns null when the Exif APP1 has no orientation tag', () => {
      const jpeg = buildJpegWithExif({ includeMakeTag: true });
      // The segment is real Exif -- just without the tag we care about.
      expect(hasExif(jpeg)).toBe(true);
      expect(readJpegOrientation(jpeg)).toBeNull();
    });

    it('returns null when there is no Exif APP1 at all', () => {
      const jpeg = buildJpegWithExif({ omitExifApp1: true });
      expect(readJpegOrientation(jpeg)).toBeNull();
    });

    it('returns null when only an XMP APP1 is present', () => {
      const jpeg = buildJpegWithExif({ omitExifApp1: true, includeXmpApp1: true });
      expect(readJpegOrientation(jpeg)).toBeNull();
    });

    it('returns null for a PNG', () => {
      const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
      expect(readJpegOrientation(png)).toBeNull();
    });

    it('returns null for empty and undersized input', () => {
      expect(readJpegOrientation(new Uint8Array([]))).toBeNull();
      expect(readJpegOrientation(new Uint8Array([0xFF, 0xD8]))).toBeNull();
    });
  });

  describe('bounds enforcement', () => {
    it('returns null when IFD0 sits past the declared segment length', () => {
      // Entries exist in the buffer, but the length field declares the segment
      // ends right after the IFD0 entry count -- the walk must not read past it.
      const jpeg = buildJpegWithExif({ orientation: 6, declaredPayloadBytes: 6 + 10 });
      expect(readJpegOrientation(jpeg)).toBeNull();
    });

    it('returns null when the IFD0 offset points beyond the segment', () => {
      const jpeg = buildJpegWithExif({ orientation: 6, ifd0Offset: 0x7FFF });
      expect(readJpegOrientation(jpeg)).toBeNull();
    });

    it('returns null when the IFD0 offset overlaps the TIFF header', () => {
      const jpeg = buildJpegWithExif({ orientation: 6, ifd0Offset: 4 });
      expect(readJpegOrientation(jpeg)).toBeNull();
    });

    it('returns null on an absurd IFD0 entry count', () => {
      const jpeg = buildJpegWithExif({ orientation: 6, entryCount: 60000 });
      expect(readJpegOrientation(jpeg)).toBeNull();
    });

    it('returns null on a zero-entry IFD0', () => {
      const jpeg = buildJpegWithExif({ orientation: 6, entryCount: 0 });
      expect(readJpegOrientation(jpeg)).toBeNull();
    });

    it('returns null on a bad TIFF magic number', () => {
      const jpeg = buildJpegWithExif({ orientation: 6, magic: 43 });
      expect(readJpegOrientation(jpeg)).toBeNull();
    });

    it('returns null on a bad byte-order mark', () => {
      const jpeg = buildJpegWithExif({ orientation: 6 });
      // Overwrite the "II"/"MM" bytes inside the Exif payload.
      const bomIndex = indexOfExifSignature(jpeg) + 6;
      jpeg[bomIndex] = 0x58;
      jpeg[bomIndex + 1] = 0x58;
      expect(readJpegOrientation(jpeg)).toBeNull();
    });

    it('returns null on a TIFF truncated mid-header', () => {
      const jpeg = buildJpegWithExif({ orientation: 6 });
      const truncated = jpeg.slice(0, indexOfExifSignature(jpeg) + 10);
      expect(readJpegOrientation(truncated)).toBeNull();
    });

    it('returns null on a TIFF truncated mid-IFD', () => {
      const jpeg = buildJpegWithExif({ orientation: 6, includeMakeTag: true });
      const truncated = jpeg.slice(0, indexOfExifSignature(jpeg) + 20);
      expect(readJpegOrientation(truncated)).toBeNull();
    });

    it('returns null on an out-of-range orientation value', () => {
      const jpeg = buildJpegWithExif({ orientation: 9 });
      expect(readJpegOrientation(jpeg)).toBeNull();
    });

    it('returns null on a zero-length segment field', () => {
      const jpeg = buildJpegWithExif({ orientation: 6 });
      // Corrupt the APP0 length so the segment walk cannot advance.
      jpeg[4] = 0x00;
      jpeg[5] = 0x00;
      expect(readJpegOrientation(jpeg)).toBeNull();
    });
  });
});

/** Offset of the "Exif\0\0" signature (start of the APP1 payload). */
function indexOfExifSignature(data: Uint8Array): number {
  for (let i = 0; i + 5 < data.length; i++) {
    if (
      data[i] === 0x45 && data[i + 1] === 0x78 && data[i + 2] === 0x69 &&
      data[i + 3] === 0x66 && data[i + 4] === 0x00 && data[i + 5] === 0x00
    ) {
      return i;
    }
  }
  throw new Error('fixture has no Exif signature');
}

// ---------------------------------------------------------------------------
// sanitizeStillImage routing
// ---------------------------------------------------------------------------

describe('sanitizeStillImage orientation routing', () => {
  const SOURCE = '/tmp/photo.jpg';
  const OUT = '/tmp/out/photo-sanitized.jpg';
  // Mirrors the helper inside imageSanitizer: Caches + basename(outPath).
  const PREENCODE = '/tmp/test-cache/photo-sanitized.jpg.pre-staging.bin';

  const rnfs = require('@dr.pogodin/react-native-fs');
  const { reencodeImage } = require('orbital-media-transcoder');

  function toBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
  }

  function fromBase64(b64: string): Uint8Array {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  /**
   * Wire the RNFS mock to a virtual filesystem: `files` maps path -> bytes, and
   * writeFile records what sanitizeStillImage produced so the fail-closed
   * verify re-read sees it.
   */
  function mockFs(files: Record<string, Uint8Array>, sizeBytes: number) {
    rnfs.stat.mockResolvedValue({ size: sizeBytes });
    rnfs.read.mockImplementation(async (p: string, len: number, pos: number) => {
      const bytes = files[p];
      if (!bytes) throw new Error(`ENOENT ${p}`);
      return toBase64(bytes.slice(pos, pos + len));
    });
    rnfs.readFile.mockImplementation(async (p: string) => {
      const bytes = files[p];
      if (!bytes) throw new Error(`ENOENT ${p}`);
      return toBase64(bytes);
    });
    rnfs.writeFile.mockImplementation(async (p: string, b64: string) => {
      files[p] = fromBase64(b64);
    });
    rnfs.unlink.mockResolvedValue(undefined);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('pre-encodes a rotated JPEG, then strips the re-encoded output', async () => {
    const rotated = buildJpegWithExif({ order: 'II', orientation: 6 });
    // What the native re-encode produces: rotation baked into pixels, no APP1.
    const baked = buildJpegWithExif({ omitExifApp1: true });
    const files: Record<string, Uint8Array> = { [SOURCE]: rotated, [PREENCODE]: baked };
    mockFs(files, 1024);

    await sanitizeStillImage(SOURCE, 'image/jpeg', OUT);

    expect(reencodeImage).toHaveBeenCalledTimes(1);
    expect(reencodeImage).toHaveBeenCalledWith(SOURCE, PREENCODE, {
      maxDimension: 2048,
      quality: 0.9,
      format: 'jpeg',
    });
    // The strip ran on the re-encoded file, not the original.
    expect(rnfs.readFile).toHaveBeenCalledWith(PREENCODE, 'base64');
    expect(rnfs.readFile).not.toHaveBeenCalledWith(SOURCE, 'base64');
    // Output is written and clean.
    expect(rnfs.writeFile).toHaveBeenCalledWith(OUT, expect.any(String), 'base64');
    expect(hasExif(files[OUT])).toBe(false);
    // Staging file is cleaned up.
    expect(rnfs.unlink).toHaveBeenCalledWith(PREENCODE);
  });

  it('reads only the file head for the orientation probe', async () => {
    const rotated = buildJpegWithExif({ orientation: 3 });
    const files: Record<string, Uint8Array> = {
      [SOURCE]: rotated,
      [PREENCODE]: buildJpegWithExif({ omitExifApp1: true }),
    };
    mockFs(files, 1024);

    await sanitizeStillImage(SOURCE, 'image/jpeg', OUT);

    expect(rnfs.read).toHaveBeenCalledTimes(1);
    expect(rnfs.read).toHaveBeenCalledWith(SOURCE, 128 * 1024, 0, 'base64');
  });

  it('strips an upright JPEG directly, without a re-encode', async () => {
    const upright = buildJpegWithExif({ order: 'MM', orientation: 1 });
    const files: Record<string, Uint8Array> = { [SOURCE]: upright };
    mockFs(files, 1024);

    await sanitizeStillImage(SOURCE, 'image/jpeg', OUT);

    expect(reencodeImage).not.toHaveBeenCalled();
    expect(rnfs.readFile).toHaveBeenCalledWith(SOURCE, 'base64');
    expect(hasExif(files[OUT])).toBe(false);
  });

  it('strips a JPEG with no orientation tag directly', async () => {
    const noTag = buildJpegWithExif({ includeMakeTag: true });
    const files: Record<string, Uint8Array> = { [SOURCE]: noTag };
    mockFs(files, 1024);

    await sanitizeStillImage(SOURCE, 'image/jpeg', OUT);

    expect(reencodeImage).not.toHaveBeenCalled();
    expect(hasExif(files[OUT])).toBe(false);
  });

  it('re-encodes a rotated JPEG over 8MB exactly once', async () => {
    const rotated = buildJpegWithExif({ orientation: 6 });
    const files: Record<string, Uint8Array> = {
      [SOURCE]: rotated,
      [PREENCODE]: buildJpegWithExif({ omitExifApp1: true }),
    };
    mockFs(files, 9 * 1024 * 1024);

    await sanitizeStillImage(SOURCE, 'image/jpeg', OUT);

    expect(reencodeImage).toHaveBeenCalledTimes(1);
    // The size check already routed to the pre-encode, so the orientation probe
    // is short-circuited -- no head read at all.
    expect(rnfs.read).not.toHaveBeenCalled();
  });

  it('does not probe orientation for PNG sources', async () => {
    const png = buildPngFixture();
    const files: Record<string, Uint8Array> = { [SOURCE]: png };
    mockFs(files, 1024);

    await sanitizeStillImage(SOURCE, 'image/png', OUT);

    expect(rnfs.read).not.toHaveBeenCalled();
    expect(reencodeImage).not.toHaveBeenCalled();
  });

  it('falls back to a direct strip when the head read fails', async () => {
    const upright = buildJpegWithExif({ orientation: 6 });
    const files: Record<string, Uint8Array> = { [SOURCE]: upright };
    mockFs(files, 1024);
    rnfs.read.mockRejectedValue(new Error('EIO'));

    await sanitizeStillImage(SOURCE, 'image/jpeg', OUT);

    expect(reencodeImage).not.toHaveBeenCalled();
    expect(hasExif(files[OUT])).toBe(false);
  });
});

/** Minimal PNG: signature + IHDR + IDAT + IEND, no metadata chunks. */
function buildPngFixture(): Uint8Array {
  const parts: number[] = [137, 80, 78, 71, 13, 10, 26, 10];

  function writeChunk(type: string, data: number[]) {
    const len = data.length;
    parts.push((len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF);
    parts.push(...Array.from(new TextEncoder().encode(type)));
    parts.push(...data);
    parts.push(0, 0, 0, 0); // CRC placeholder -- not validated by the stripper
  }

  writeChunk('IHDR', [0, 0, 0, 16, 0, 0, 0, 16, 8, 2, 0, 0, 0]);
  writeChunk('IDAT', [0x08, 0x99, 0x01, 0x00]);
  writeChunk('IEND', []);

  return new Uint8Array(parts);
}
