/**
 * `sanitizeStillImage`'s returned format is a TOTAL function of the bytes it
 * wrote (#880 / #881 review): jpeg or png from the shared sniffer, and a throw
 * for anything else. The upload service labels an entire row — envelope, DB,
 * store, canonical file — from that one value, so a silent default would put a
 * wrong label on content we could not identify.
 *
 * The sniff is STUBBED rather than the strip. With the real strips the bad
 * state is unreachable: `stripPngMetadata` rejects anything without the PNG
 * signature, and `stripJpegMetadata` copies the SOI and the next marker, so its
 * output always sniffs as JPEG. Stubbing the one function whose answer the
 * guard reads is what makes a defensive branch testable at all — and if the
 * guard is deleted, the first case below returns `{format:'jpeg'}` instead of
 * rejecting.
 */

jest.mock('@dr.pogodin/react-native-fs');

const mockSniff = jest.fn<string | null, [Uint8Array]>();

jest.mock('../media/contentType', () => {
  // Everything else stays REAL — `hasPngSignature` is what the strip dispatch
  // inside the sanitizer uses, so a bare stub module would break the subject.
  const actual = jest.requireActual('../media/contentType');
  return { ...actual, sniffContentType: (head: Uint8Array) => mockSniff(head) };
});

import { sanitizeStillImage } from '../media/imageSanitizer';
import { buildJpeg } from '../testUtils/imageFixtures';

const SOURCE = '/tmp/photo.jpg';
const OUT = '/tmp/out/photo-sanitized.jpg';

const rnfs = require('@dr.pogodin/react-native-fs');

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** Virtual filesystem, as in imageSanitizer.orientation.test.ts. */
function mockFs(files: Record<string, Uint8Array>): void {
  rnfs.stat.mockResolvedValue({ size: 1024 });
  rnfs.read.mockImplementation(async (p: string, len: number, pos: number) => {
    const bytes = files[p];
    if (!bytes) throw new Error('ENOENT');
    return toBase64(bytes.slice(pos, pos + len));
  });
  rnfs.readFile.mockImplementation(async (p: string) => {
    const bytes = files[p];
    if (!bytes) throw new Error('ENOENT');
    return toBase64(bytes);
  });
  rnfs.writeFile.mockImplementation(async (p: string, b64: string) => {
    files[p] = fromBase64(b64);
  });
  rnfs.unlink.mockResolvedValue(undefined);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSniff.mockReset();
  mockFs({ [SOURCE]: buildJpeg() });
});

describe('sanitizeStillImage — returned format is total', () => {
  it.each([
    ['image/jpeg', 'jpeg'],
    ['image/png', 'png'],
  ] as const)('maps %s to %s', async (sniffed, format) => {
    mockSniff.mockReturnValue(sniffed);

    await expect(sanitizeStillImage(SOURCE, 'image/jpeg', OUT)).resolves.toEqual({
      format,
    });
  });

  it.each([null, 'image/webp', 'video/mp4', 'image/heic'])(
    'refuses to label the upload when the written bytes sniff as %s',
    async (sniffed) => {
      mockSniff.mockReturnValue(sniffed);

      await expect(sanitizeStillImage(SOURCE, 'image/jpeg', OUT)).rejects.toThrow(
        'Could not process this image',
      );
    },
  );

  it('sniffs the bytes it WROTE, not the source', async () => {
    mockSniff.mockReturnValue('image/jpeg');
    const files: Record<string, Uint8Array> = { [SOURCE]: buildJpeg() };
    mockFs(files);

    await sanitizeStillImage(SOURCE, 'image/jpeg', OUT);

    expect(mockSniff).toHaveBeenCalledTimes(1);
    // The stripped output, byte-identical to what landed at outPath.
    expect(mockSniff.mock.calls[0][0]).toEqual(files[OUT]);
  });
});
