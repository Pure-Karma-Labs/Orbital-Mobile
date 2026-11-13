/**
 * `sanitizeStillImage`'s fourth argument (#918): the Meta-import options bag.
 *
 * Three claims, and nothing else:
 *   1. OMISSION IS FREE. Three arguments, four arguments with `{}`, and four
 *      arguments with `undefined` are the same call -- same native options
 *      object, same output bytes, same returned format. That is the AC for
 *      "the three existing callers are untouched", proved here rather than
 *      asserted in a plan.
 *   2. THE IMPORT PATH ALWAYS DECODES, UNDER A CEILING. `forceReencode` (and
 *      `maxPixelCount` on its own) takes the native route even for the one
 *      input that would otherwise skip it -- an in-size, upright JPEG -- and
 *      the ceiling rides along on that one call.
 *   3. THE REFUSAL IS THIS MODULE'S OWN. A native `EPIXELS`/`EIMAGEFORMAT`
 *      becomes an `ImageSanitizeError` with a closed-union `reason` and a
 *      sentence from a frozen table; anything else is re-thrown untouched.
 *
 * WHAT THIS SUITE CANNOT PROVE: the ceiling is enforced by the platform
 * decoder, and Jest mocks the native module. The dimension-aware fake below
 * reproduces the CONTRACT (header dimensions in, `EPIXELS` out, nothing read
 * from the source), not the memory behaviour. That the native side refuses
 * before it allocates is verified only by the on-device checks in the PR's
 * test plan.
 *
 * Run: npm test -- imageSanitizer.options
 */

jest.mock('@dr.pogodin/react-native-fs');

import {
  IMPORT_MAX_DIMENSION,
  IMPORT_MAX_PIXELS,
  ImageSanitizeError,
  hasExif,
  sanitizeStillImage,
} from '../media/imageSanitizer';
import { EXIF_TRAILER_BARE, buildJpeg, buildPng } from '../testUtils/imageFixtures';

const SOURCE = '/tmp/photo.jpg';
const OUT = '/tmp/out/photo-sanitized.jpg';
// Mirrors the helper inside imageSanitizer: Caches + basename(outPath).
const PREENCODE = '/tmp/test-cache/photo-sanitized.jpg.pre-staging.bin';

const rnfs = require('@dr.pogodin/react-native-fs');
const { reencodeImage, MediaTranscoderError } = require('orbital-media-transcoder');

/** The whole import options bag, exactly as mediaUploadService passes it. */
const IMPORT_OPTIONS = {
  forceReencode: true,
  maxDimension: IMPORT_MAX_DIMENSION,
  maxPixelCount: IMPORT_MAX_PIXELS,
} as const;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Wire the RNFS mock to a virtual filesystem, as the orientation suite does:
 * `files` maps path -> bytes, and writeFile records the output so the
 * fail-closed verify re-read sees it.
 */
function mockFs(files: Record<string, Uint8Array>, sizeBytes = 1024): void {
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

/** A clean, upright, in-size JPEG: the ONE input that skips the native call. */
function uprightJpeg(): Uint8Array {
  return buildJpeg();
}

/** What the native re-encode hands back: no metadata of any kind. */
function reencodedJpeg(): Uint8Array {
  return buildJpeg();
}

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks wipes call records, not implementations -- but case 7 and
  // the rejection cases install their own, so restore the package default
  // (resolves the OUTPUT dimensions, #918 D13) before every test.
  reencodeImage.mockResolvedValue({ width: 2048, height: 1536 });
});

// ---------------------------------------------------------------------------
// 1. Omission is free
// ---------------------------------------------------------------------------

describe('omitting the options bag', () => {
  /** Run one variant and collect everything three calls must agree on. */
  async function runVariant(
    extraArgs: unknown[],
  ): Promise<{ format: string; call: unknown[]; out: Uint8Array }> {
    jest.clearAllMocks();
    reencodeImage.mockResolvedValue({ width: 2048, height: 1536 });
    const files: Record<string, Uint8Array> = {
      // A HEIC head: not directly strippable, so this variant actually
      // REACHES reencodeImage and the recorded call means something.
      [SOURCE]: new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
      [PREENCODE]: reencodedJpeg(),
    };
    mockFs(files);

    const result = await (sanitizeStillImage as (...a: unknown[]) => Promise<{ format: string }>)(
      SOURCE,
      'image/heic',
      OUT,
      ...extraArgs,
    );

    return {
      format: result.format,
      call: reencodeImage.mock.calls[0],
      out: files[OUT],
    };
  }

  it('three arguments, {} and undefined produce one identical call', async () => {
    const threeArg = await runVariant([]);
    const emptyBag = await runVariant([{}]);
    const explicitUndefined = await runVariant([undefined]);

    // The native options object, including the ABSENCE of maxPixelCount: the
    // omitted case must hand the native layer the very object today's three
    // callers hand it, not one with an extra key set to a sentinel.
    expect(threeArg.call).toEqual([
      SOURCE,
      PREENCODE,
      { maxDimension: 2048, quality: 0.9, format: 'jpeg' },
    ]);
    expect(emptyBag.call).toEqual(threeArg.call);
    expect(explicitUndefined.call).toEqual(threeArg.call);

    expect(emptyBag.format).toBe(threeArg.format);
    expect(explicitUndefined.format).toBe(threeArg.format);

    expect(Array.from(emptyBag.out)).toEqual(Array.from(threeArg.out));
    expect(Array.from(explicitUndefined.out)).toEqual(Array.from(threeArg.out));
  });

  it('leaves the strip-only path strip-only when the bag is empty', async () => {
    const files: Record<string, Uint8Array> = { [SOURCE]: uprightJpeg() };
    mockFs(files);

    await sanitizeStillImage(SOURCE, 'image/jpeg', OUT, {});

    expect(reencodeImage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2-5. Routing under the import options
// ---------------------------------------------------------------------------

describe('forceReencode routing', () => {
  it('re-encodes an in-size, upright JPEG that would otherwise strip directly', async () => {
    const files: Record<string, Uint8Array> = {
      [SOURCE]: uprightJpeg(),
      [PREENCODE]: reencodedJpeg(),
    };
    mockFs(files);

    await sanitizeStillImage(SOURCE, 'image/jpeg', OUT, IMPORT_OPTIONS);

    expect(reencodeImage).toHaveBeenCalledTimes(1);
    expect(reencodeImage).toHaveBeenCalledWith(SOURCE, PREENCODE, {
      maxDimension: 2048,
      quality: 0.9,
      format: 'jpeg',
      maxPixelCount: 32_000_000,
    });
    // Both probes the strip-only route needs are skipped outright: the
    // decision was already made, so neither the size stat nor the 128 KiB
    // orientation head read happens.
    expect(rnfs.stat).not.toHaveBeenCalled();
    expect(rnfs.read).not.toHaveBeenCalled();
  });

  it('re-encodes a >8MiB JPEG exactly once, never twice', async () => {
    const files: Record<string, Uint8Array> = {
      [SOURCE]: uprightJpeg(),
      [PREENCODE]: reencodedJpeg(),
    };
    mockFs(files, 9 * 1024 * 1024);

    await sanitizeStillImage(SOURCE, 'image/jpeg', OUT, IMPORT_OPTIONS);

    // The pre-#918 size branch and the forced branch are the same branch --
    // a second call here would mean an archive image is decoded twice.
    expect(reencodeImage).toHaveBeenCalledTimes(1);
  });

  it('keeps a PNG a PNG through the forced re-encode', async () => {
    const files: Record<string, Uint8Array> = {
      [SOURCE]: buildPng(),
      [PREENCODE]: buildPng(),
    };
    mockFs(files);

    await expect(
      sanitizeStillImage(SOURCE, 'image/png', OUT, IMPORT_OPTIONS),
    ).resolves.toMatchObject({ format: 'png' });
    // Alpha in an archive screenshot survives: the forced route reproduces
    // today's format choice rather than flattening everything to JPEG.
    expect(reencodeImage).toHaveBeenCalledWith(SOURCE, PREENCODE, {
      maxDimension: 2048,
      quality: 0.9,
      format: 'png',
      maxPixelCount: 32_000_000,
    });
  });

  it('decodes natively for maxPixelCount alone, with no forceReencode', async () => {
    const files: Record<string, Uint8Array> = {
      [SOURCE]: uprightJpeg(),
      [PREENCODE]: reencodedJpeg(),
    };
    mockFs(files);

    // The whole point of the implication: an in-size orientation-1 JPEG
    // would otherwise skip the native call, and a ceiling the strip-only
    // path can skip is not a ceiling.
    await sanitizeStillImage(SOURCE, 'image/jpeg', OUT, {
      maxPixelCount: IMPORT_MAX_PIXELS,
    });

    expect(reencodeImage).toHaveBeenCalledTimes(1);
    expect(reencodeImage.mock.calls[0][2]).toEqual({
      maxDimension: 2048,
      quality: 0.9,
      format: 'jpeg',
      maxPixelCount: 32_000_000,
    });
  });
});

// ---------------------------------------------------------------------------
// 6. maxDimension must be > 0
// ---------------------------------------------------------------------------

describe('maxDimension validation', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
  ])('rejects a %s maxDimension before touching the filesystem', async (_label, maxDimension) => {
    const files: Record<string, Uint8Array> = { [SOURCE]: uprightJpeg() };
    mockFs(files);

    await expect(sanitizeStillImage(SOURCE, 'image/jpeg', OUT, { maxDimension })).rejects.toThrow(
      'maxDimension must be greater than 0',
    );

    // `?? 2048` does not catch 0, and the package reads 0 as "no scaling" --
    // a full-resolution, un-rotated decode handed straight to the JS strip.
    // Rejecting it is only worth anything if nothing has happened yet.
    expect(rnfs.stat).not.toHaveBeenCalled();
    expect(rnfs.read).not.toHaveBeenCalled();
    expect(rnfs.readFile).not.toHaveBeenCalled();
    expect(reencodeImage).not.toHaveBeenCalled();
  });

  it('is a plain Error, not a refusal about the image', async () => {
    const files: Record<string, Uint8Array> = { [SOURCE]: uprightJpeg() };
    mockFs(files);

    const err = await sanitizeStillImage(SOURCE, 'image/jpeg', OUT, {
      maxDimension: 0,
    }).catch((e: unknown) => e);

    // A caller bug is not a statement about the member's photo, so it must
    // not arrive wearing the taxonomy #926 maps to a skip reason.
    expect((err as Error).name).toBe('Error');
    expect(err).not.toHaveProperty('reason');
  });
});

// ---------------------------------------------------------------------------
// 7. The ceiling -- the issue's acceptance criterion
// ---------------------------------------------------------------------------

describe('the pixel ceiling', () => {
  /**
   * DECLARED dimensions, read out of the fixture's own header exactly as a
   * platform decoder reads them before it allocates: PNG IHDR (two u32s after
   * the 8-byte signature and the 8-byte chunk header) or JPEG SOF (two u16s,
   * height first, after the one-byte precision).
   */
  function readDeclaredDims(bytes: Uint8Array): { width: number; height: number } {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const at = 16; // signature(8) + length(4) + "IHDR"(4)
      const u32 = (o: number) =>
        (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
      return { width: u32(at) >>> 0, height: u32(at + 4) >>> 0 };
    }
    for (let i = 2; i + 9 < bytes.length; i++) {
      if (bytes[i] !== 0xff) continue;
      const marker = bytes[i + 1];
      // SOF0..SOF3 / SOF5..SOF7: the frame headers that declare the size.
      if (marker >= 0xc0 && marker <= 0xc7 && marker !== 0xc4) {
        const p = i + 5; // marker(2) + length(2) + precision(1)
        return {
          height: (bytes[p] << 8) | bytes[p + 1],
          width: (bytes[p + 2] << 8) | bytes[p + 3],
        };
      }
    }
    throw new Error('fixture declares no dimensions');
  }

  /**
   * Stands in for the native decoder: reads the header, refuses over the
   * ceiling WITHOUT touching the pixels, and otherwise writes an output.
   * It never consults the source's byte length -- the gate is on declared
   * pixels, which is the entire reason a 400 MP file can be 200 bytes.
   */
  function mockDimensionAwareDecoder(files: Record<string, Uint8Array>): void {
    reencodeImage.mockImplementation(
      async (src: string, dest: string, opts: { maxPixelCount?: number }) => {
        const { width, height } = readDeclaredDims(files[src]);
        if (
          opts.maxPixelCount !== undefined &&
          opts.maxPixelCount > 0 &&
          width * height > opts.maxPixelCount
        ) {
          throw new MediaTranscoderError('EPIXELS', 'source exceeds pixel ceiling');
        }
        files[dest] = reencodedJpeg();
        return { width: 2048, height: 1536 };
      },
    );
  }

  it('refuses a 20000x20000 PNG before anything reads its pixels', async () => {
    // 400 MP declared, ~200 bytes on "disk": the archive reader's 50 MiB
    // entry cap would wave this through, which is why the gate is here.
    const files: Record<string, Uint8Array> = {
      [SOURCE]: buildPng({ width: 20000, height: 20000 }),
    };
    mockFs(files);
    mockDimensionAwareDecoder(files);

    const err = await sanitizeStillImage(SOURCE, 'image/png', OUT, IMPORT_OPTIONS).catch(
      (e: unknown) => e,
    );

    expect((err as ImageSanitizeError).name).toBe('ImageSanitizeError');
    expect((err as ImageSanitizeError).reason).toBe('too-many-pixels');
    // The refusal happened before the strip: if the source were ever read
    // whole into Hermes, the ceiling would have bought nothing.
    expect(rnfs.readFile).not.toHaveBeenCalledWith(SOURCE, 'base64');
    expect(files[OUT]).toBeUndefined();
  });

  it('passes a 4096x4096 source -- the largest Meta serves from an export', async () => {
    const files: Record<string, Uint8Array> = {
      [SOURCE]: buildJpeg({ width: 4096, height: 4096 }),
    };
    mockFs(files);
    mockDimensionAwareDecoder(files);

    await expect(
      sanitizeStillImage(SOURCE, 'image/jpeg', OUT, IMPORT_OPTIONS),
    ).resolves.toMatchObject({ format: 'jpeg' });
    expect(files[OUT]).toBeDefined();
  });

  it('refuses an over-size JPEG too, read from its SOF rather than its IHDR', async () => {
    // Positive control for the JPEG arm of readDeclaredDims: without it, the
    // 4096 case above could be passing because the reader returns 1x1 for
    // every JPEG it is handed.
    const files: Record<string, Uint8Array> = {
      [SOURCE]: buildJpeg({ width: 8000, height: 8000 }), // 64 MP
    };
    mockFs(files);
    mockDimensionAwareDecoder(files);

    await expect(
      sanitizeStillImage(SOURCE, 'image/jpeg', OUT, IMPORT_OPTIONS),
    ).rejects.toMatchObject({ reason: 'too-many-pixels' });
  });

  it('does not refuse the same over-size source when no ceiling is passed', async () => {
    // Pins which argument does the work: the fake refuses on maxPixelCount
    // alone, so the three-argument call must sail past 400 MP.
    const files: Record<string, Uint8Array> = {
      [SOURCE]: buildPng({ width: 20000, height: 20000 }),
    };
    mockFs(files, 9 * 1024 * 1024);
    mockDimensionAwareDecoder(files);

    await expect(sanitizeStillImage(SOURCE, 'image/png', OUT)).resolves.toMatchObject({
      format: 'jpeg',
    });
  });
});

// ---------------------------------------------------------------------------
// 8-9. The error map
// ---------------------------------------------------------------------------

describe('native rejection mapping', () => {
  function rejectWith(code: string, message: string): void {
    reencodeImage.mockRejectedValue(new MediaTranscoderError(code, message));
  }

  it('turns EIMAGEFORMAT into an unsupported-format refusal', async () => {
    const files: Record<string, Uint8Array> = { [SOURCE]: uprightJpeg() };
    mockFs(files);
    rejectWith('EIMAGEFORMAT', 'unsupported image format');

    const err = await sanitizeStillImage(SOURCE, 'image/jpeg', OUT, IMPORT_OPTIONS).catch(
      (e: unknown) => e,
    );

    expect((err as ImageSanitizeError).name).toBe('ImageSanitizeError');
    expect((err as ImageSanitizeError).reason).toBe('unsupported-format');
    // The exact sentence from the frozen table -- NOT the native message,
    // which is where a device path would ride in if one ever leaked.
    expect((err as Error).message).toBe('This image format is not supported on this device.');
    expect(err).toBeInstanceOf(ImageSanitizeError);
  });

  it('turns EPIXELS into a too-many-pixels refusal', async () => {
    const files: Record<string, Uint8Array> = { [SOURCE]: uprightJpeg() };
    mockFs(files);
    rejectWith('EPIXELS', 'source exceeds pixel ceiling');

    const err = await sanitizeStillImage(SOURCE, 'image/jpeg', OUT, IMPORT_OPTIONS).catch(
      (e: unknown) => e,
    );

    expect((err as ImageSanitizeError).reason).toBe('too-many-pixels');
    expect((err as Error).message).toBe('This image is too large to process on this device.');
  });

  it.each([
    ['EIMAGE', 'image encode failed'],
    ['ENOENT', 'source unavailable'],
    ['ECANCELLED', 'cancelled'],
  ])('re-throws %s unchanged', async (code, message) => {
    const files: Record<string, Uint8Array> = { [SOURCE]: uprightJpeg() };
    mockFs(files);
    const original = new MediaTranscoderError(code, message);
    reencodeImage.mockRejectedValue(original);

    const err = await sanitizeStillImage(SOURCE, 'image/jpeg', OUT, IMPORT_OPTIONS).catch(
      (e: unknown) => e,
    );

    // Identity, not shape: an encode failure, a missing file and a teardown
    // are not statements about the image, so none of them may acquire this
    // module's taxonomy on the way out.
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(ImageSanitizeError);
    expect((err as { code: string }).code).toBe(code);
  });
});

// ---------------------------------------------------------------------------
// 10. The staging file's cleanup obligation
// ---------------------------------------------------------------------------

describe('pre-encode staging cleanup', () => {
  it('unlinks a partial file the native side wrote before it rejected', async () => {
    const files: Record<string, Uint8Array> = { [SOURCE]: uprightJpeg() };
    mockFs(files);
    reencodeImage.mockImplementation(async (_src: string, dest: string) => {
      // Half an image, then a failure: both platforms delete destPath on
      // their own failure paths, but the obligation starts when the path is
      // handed over, not when the call succeeds.
      files[dest] = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      throw new MediaTranscoderError('EIMAGE', 'image encode failed');
    });

    await expect(sanitizeStillImage(SOURCE, 'image/jpeg', OUT, IMPORT_OPTIONS)).rejects.toThrow();

    expect(files[PREENCODE]).toBeDefined(); // the partial really was written
    expect(rnfs.unlink).toHaveBeenCalledWith(PREENCODE);
  });

  it('unlinks the staging file on the ceiling refusal too', async () => {
    const files: Record<string, Uint8Array> = { [SOURCE]: uprightJpeg() };
    mockFs(files);
    reencodeImage.mockRejectedValue(
      new MediaTranscoderError('EPIXELS', 'source exceeds pixel ceiling'),
    );

    await expect(sanitizeStillImage(SOURCE, 'image/jpeg', OUT, IMPORT_OPTIONS)).rejects.toThrow(
      'too large to process',
    );

    expect(rnfs.unlink).toHaveBeenCalledWith(PREENCODE);
  });
});

// ---------------------------------------------------------------------------
// 11-12. The forced re-encode is a step IN FRONT of the strip, never instead
// ---------------------------------------------------------------------------

describe('the strip still runs after a forced re-encode', () => {
  it('strips an Exif APP1 that survived into the re-encoded file', async () => {
    const files: Record<string, Uint8Array> = {
      [SOURCE]: uprightJpeg(),
      // The native layer drops metadata by construction -- so this fixture
      // is the hypothesis that it did not. The byte-level strip plus the
      // fail-closed verify stay authoritative either way.
      [PREENCODE]: buildJpeg({ exif: true, xmp: true }),
    };
    mockFs(files);

    await sanitizeStillImage(SOURCE, 'image/jpeg', OUT, IMPORT_OPTIONS);

    expect(hasExif(files[PREENCODE])).toBe(true);
    expect(hasExif(files[OUT])).toBe(false);
    // The strip ran over the re-encoded file, and the verify re-read the
    // output that was actually written.
    expect(rnfs.readFile).toHaveBeenCalledWith(PREENCODE, 'base64');
    expect(rnfs.readFile).toHaveBeenCalledWith(OUT, 'base64');
  });

  it('fails closed when metadata survives the strip', async () => {
    const files: Record<string, Uint8Array> = {
      [SOURCE]: buildPng(),
      // No IEND, so the chunk walk never completes and the strip's fallback
      // copies the tail through -- six of those eight bytes are an Exif\0\0.
      [PREENCODE]: buildPng({ omitIend: true, tail: EXIF_TRAILER_BARE }),
    };
    mockFs(files);

    await expect(sanitizeStillImage(SOURCE, 'image/png', OUT, IMPORT_OPTIONS)).rejects.toThrow(
      'Could not remove metadata',
    );

    // Nothing is handed back, and the staging file is still cleaned up.
    expect(hasExif(files[OUT])).toBe(true);
    expect(rnfs.unlink).toHaveBeenCalledWith(PREENCODE);
  });
});

// ---------------------------------------------------------------------------
// 13. The dimensions the import runner will read (#918 D13), and the return
//     shape that is NOT widened to carry them yet
// ---------------------------------------------------------------------------

describe('returned dimensions', () => {
  it('reports the decoded output size through the native layer', async () => {
    const files: Record<string, Uint8Array> = {
      [SOURCE]: uprightJpeg(),
      [PREENCODE]: reencodedJpeg(),
    };
    mockFs(files);
    // Deliberately non-square, so a transposed passthrough would fail.
    reencodeImage.mockResolvedValue({ width: 1536, height: 2048 });

    await sanitizeStillImage(SOURCE, 'image/jpeg', OUT, IMPORT_OPTIONS);

    // The import runner's ONLY legitimate dimension source: the alternative is
    // a raw decode of exactly the hostile file this ceiling exists to bound.
    // #918 ships the reporting half -- the ceilinged decode resolves what it
    // WROTE -- and #926 widens sanitizeStillImage's return to surface it, when
    // there is finally a caller that reads it.
    await expect(reencodeImage.mock.results[0].value).resolves.toEqual({
      width: 1536,
      height: 2048,
    });
  });

  it('keeps the return shape unwidened, on both paths', async () => {
    // D1: omitting the options bag must be byte-identical to the
    // three-argument call, and that includes the shape of THIS object -- which
    // is what the four pre-existing sanitizer suites assert exhaustively. A
    // field nothing reads yet is not worth breaking that promise for.
    const files: Record<string, Uint8Array> = {
      [SOURCE]: uprightJpeg(),
      [PREENCODE]: reencodedJpeg(),
    };
    mockFs(files);

    await expect(sanitizeStillImage(SOURCE, 'image/jpeg', OUT, IMPORT_OPTIONS)).resolves.toEqual({
      format: 'jpeg',
    });
    expect(reencodeImage).toHaveBeenCalledTimes(1);

    mockFs({ [SOURCE]: uprightJpeg() });
    reencodeImage.mockClear();
    await expect(sanitizeStillImage(SOURCE, 'image/jpeg', OUT)).resolves.toEqual({
      format: 'jpeg',
    });
    expect(reencodeImage).not.toHaveBeenCalled();
  });
});
