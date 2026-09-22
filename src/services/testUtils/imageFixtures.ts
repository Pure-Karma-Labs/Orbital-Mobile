/**
 * Synthetic JPEG/PNG fixture builders shared by the imageSanitizer test suites.
 *
 * Every imageSanitizer suite needs the same thing: a structurally valid image
 * whose segments/chunks can be switched on and off one at a time, so an
 * assertion can pin exactly which ones the stripper drops and which it keeps.
 * Three suites had each grown their own near-identical copy of that builder,
 * which meant a layout fix had to land three times. This module is the single
 * definition they all import.
 *
 * It lives in `testUtils/` rather than `__tests__/` on purpose: jest's default
 * testMatch treats everything under `__tests__/` as a suite, and a file of pure
 * helpers with no `it()` fails as an empty suite. Same placement and reason as
 * `src/database/testUtils/dbMockHelpers.ts`.
 *
 * All segment/chunk lengths are computed from the real payload lengths (unless
 * a fixture deliberately lies about one), so the stripper's segment walk never
 * hits a malformed length it did not opt into.
 */

// ---------------------------------------------------------------------------
// Low-level writers
// ---------------------------------------------------------------------------

/** JPEG segment: marker + 2-byte length (which includes itself) + payload. */
export function writeSegment(marker: [number, number], payload: number[]): number[] {
  // The length field covers itself (2 bytes) but not the 2-byte marker.
  const len = payload.length + 2;
  return [...marker, (len >> 8) & 0xFF, len & 0xFF, ...payload];
}

/**
 * PNG chunk: 4-byte length + 4-byte type + data + 4-byte CRC placeholder.
 *
 * The CRC is a placeholder: neither the stripper nor the detector validates it.
 *
 * @param lengthOverride Writes a length field that disagrees with
 *   `data.length` (used to build malformed-chunk fixtures).
 */
export function writeChunk(type: string, data: number[], lengthOverride?: number): number[] {
  const len = lengthOverride ?? data.length;
  return [
    (len >>> 24) & 0xFF, (len >>> 16) & 0xFF, (len >>> 8) & 0xFF, len & 0xFF,
    ...Array.from(new TextEncoder().encode(type)),
    ...data,
    0, 0, 0, 0, // CRC placeholder
  ];
}

// ---------------------------------------------------------------------------
// Byte-search helpers
// ---------------------------------------------------------------------------

/** Index of `needle` inside `hay`, or -1. */
export function indexOfSeq(hay: ArrayLike<number>, needle: ArrayLike<number>): number {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * True if `marker` appears in the JPEG header region -- walks segments from SOI
 * by declared length and stops at SOS or EOI.
 *
 * Deliberately NOT a raw byte scan: entropy-coded scan data contains arbitrary
 * 0xFF-led byte pairs, so only a structural walk can tell a real header segment
 * from a coincidence in the compressed stream.
 */
export function hasHeaderMarker(data: Uint8Array, marker: number): boolean {
  let pos = 2; // skip SOI
  while (pos < data.length - 1) {
    if (data[pos] !== 0xFF) { pos++; continue; }
    const seen = (data[pos] << 8) | data[pos + 1];
    if (seen === 0xFFDA || seen === 0xFFD9) return false; // SOS or EOI ends the header
    if (seen === marker) return true;
    if (pos + 3 >= data.length) return false;
    const segLen = (data[pos + 2] << 8) | data[pos + 3];
    if (segLen < 2) return false;
    pos += 2 + segLen;
  }
  return false;
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

export interface BuildJpegOptions {
  /** APP1 carrying "Exif\0\0" + a minimal but structurally correct TIFF IFD (dropped by the stripper). */
  exif?: boolean;
  /** APP1 carrying the XMP packet signature (dropped by the stripper). */
  xmp?: boolean;
  /** APP13 Photoshop/IPTC segment (dropped by the stripper). */
  iptc?: boolean;
  /**
   * COM comment segment (dropped by the stripper). Its payload is plain ASCII
   * with no Exif or XMP signature, so only a marker-aware detector sees it.
   */
  com?: boolean;
  /** APP2 "ICC_PROFILE\0" segment (KEPT by the stripper -- a color profile is not metadata). */
  icc?: boolean;
  /** Use SOF2 (progressive) instead of SOF0 (baseline). */
  progressive?: boolean;
  /** Entropy bytes of the first scan. Default `[0xAA, 0xBB, 0xCC]`. */
  scanData?: number[];
  /**
   * Raw bytes emitted after the first scan's entropy data. When present, a
   * second SOS + `scan2Data` follows -- the multi-scan progressive case, where
   * tables sit between scans and all scans precede the single closing EOI.
   */
  betweenScans?: number[];
  /** Entropy bytes of the second scan; only meaningful with `betweenScans`. */
  scan2Data?: number[];
  /** Emit no closing EOI (degraded-stream fixtures). */
  omitEoi?: boolean;
  /** Bytes appended after the EOI (or after the scan when `omitEoi`). */
  postEoiTrailer?: number[];
}

/** APP0 JFIF payload: "JFIF\0", version 1.1, no density, no thumbnail. */
const JFIF_PAYLOAD = [
  0x4A, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
  0x01, 0x01,                   // version 1.1
  0x00,                         // aspect ratio units = 0
  0x00, 0x01, 0x00, 0x01,       // 1 dpi
  0x00, 0x00,                   // no thumbnail
];

/**
 * APP1 Exif payload: the "Exif\0\0" signature plus a minimal but structurally
 * correct TIFF IFD ("MM" big-endian, magic 42, IFD0 at offset 8, one Make tag).
 */
const EXIF_PAYLOAD = [
  0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0" -- the pattern the detector looks for
  0x4D, 0x4D,                         // "MM" big-endian
  0x00, 0x2A,                         // TIFF magic 42
  0x00, 0x00, 0x00, 0x08,             // IFD0 offset = 8 (relative to "MM")
  // IFD0: 1 entry
  0x00, 0x01,
  // Entry: Make (0x010F) | ASCII (0x0002) | count 4 | offset 0x1A
  0x01, 0x0F, 0x00, 0x02, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x1A,
  0x00, 0x00, 0x00, 0x00,             // next IFD = 0
  // "Cam\0" at offset 0x1A (26 dec) from the start of the TIFF header
  0x43, 0x61, 0x6D, 0x00,
];

/** APP13 (IPTC / Photoshop) payload. */
const IPTC_PAYLOAD = [0x50, 0x68, 0x6F, 0x74, 0x6F]; // "Photo"

/** COM payload: plain ASCII, deliberately free of Exif and XMP signatures. */
const COM_PAYLOAD = Array.from(new TextEncoder().encode('Orbital fixture comment'));

/** SOF payload: 8-bit precision, 1x1, single grayscale component. */
const SOF_PAYLOAD = [
  0x08,       // precision: 8 bits
  0x00, 0x01, // height: 1 px
  0x00, 0x01, // width: 1 px
  0x01,       // components: 1 (grayscale)
  0x01, 0x11, 0x00, // Y: sampling 1x1, quantization table 0
];

/** DHT payload: structurally valid, not a usable Huffman table. */
const DHT_PAYLOAD = [
  0x00,                                            // TC=0 TH=0 (DC luma)
  0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  // 1 code of length 2
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,        // 0 codes for lengths 3-16
  0x00,                                            // symbol: 0
];

/** SOS payload: 1 component, full spectral selection. */
const SOS_PAYLOAD = [
  0x01,       // Ns=1 component
  0x01, 0x00, // C1, Td=0/Ta=0
  0x00, 0x3F, 0x00, // Ss=0, Se=63, Ah=0/Al=0
];

/**
 * Structurally complete JPEG with optional metadata segments and an optional
 * post-EOI trailer.
 *
 * Layout: SOI, APP0 JFIF, [APP1 Exif], [APP1 XMP], [APP13 IPTC], [COM],
 * [APP2 ICC], SOF0/SOF2, DHT, SOS, scanData, [betweenScans, SOS, scan2Data],
 * [EOI], [postEoiTrailer].
 */
export function buildJpeg(opts: BuildJpegOptions = {}): Uint8Array {
  const {
    exif = false,
    xmp = false,
    iptc = false,
    com = false,
    icc = false,
    progressive = false,
    scanData = [0xAA, 0xBB, 0xCC],
    betweenScans,
    scan2Data = [],
    omitEoi = false,
    postEoiTrailer = [],
  } = opts;

  const parts: number[] = [];

  // SOI
  parts.push(0xFF, 0xD8);

  // APP0 JFIF -- kept by the stripper
  parts.push(...writeSegment([0xFF, 0xE0], JFIF_PAYLOAD));

  // APP1 Exif -- dropped
  if (exif) {
    parts.push(...writeSegment([0xFF, 0xE1], EXIF_PAYLOAD));
  }

  // APP1 XMP -- dropped (same APP1 marker 0xFFE1)
  if (xmp) {
    const xmpSig = Array.from(new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0'));
    const xmpPayload = [...xmpSig, ...Array.from(new TextEncoder().encode('<x:xmpmeta/>'))];
    parts.push(...writeSegment([0xFF, 0xE1], xmpPayload));
  }

  // APP13 IPTC -- dropped
  if (iptc) {
    parts.push(...writeSegment([0xFF, 0xED], IPTC_PAYLOAD));
  }

  // COM comment -- dropped (textual metadata by definition)
  if (com) {
    parts.push(...writeSegment([0xFF, 0xFE], COM_PAYLOAD));
  }

  // APP2 ICC profile -- kept (a color profile is a rendering instruction)
  if (icc) {
    const iccSig = Array.from(new TextEncoder().encode('ICC_PROFILE\0'));
    parts.push(...writeSegment([0xFF, 0xE2], [...iccSig, 0x01, 0x01, 0xDE, 0xAD]));
  }

  // SOF0 or SOF2 (progressive) -- kept
  const sofMarker: [number, number] = progressive ? [0xFF, 0xC2] : [0xFF, 0xC0];
  parts.push(...writeSegment(sofMarker, SOF_PAYLOAD));

  // DHT -- kept
  parts.push(...writeSegment([0xFF, 0xC4], DHT_PAYLOAD));

  // SOS -- everything from here to the EOI is copied verbatim by the stripper
  parts.push(...writeSegment([0xFF, 0xDA], SOS_PAYLOAD));
  parts.push(...scanData);

  // Second scan (progressive multi-scan): inter-scan bytes, then SOS + entropy.
  if (betweenScans) {
    parts.push(...betweenScans);
    parts.push(...writeSegment([0xFF, 0xDA], SOS_PAYLOAD));
    parts.push(...scan2Data);
  }

  // EOI
  if (!omitEoi) {
    parts.push(0xFF, 0xD9);
  }

  // Trailer (e.g. Samsung SEF) past the end of the image stream
  parts.push(...postEoiTrailer);

  return new Uint8Array(parts);
}

// ---------------------------------------------------------------------------
// Samsung SEF motion-photo trailer
// ---------------------------------------------------------------------------

/**
 * Synthetic Samsung SEF motion-photo trailer: SEFH header + block table + an
 * embedded JPEG thumbnail carrying its own Exif APP1 + SEFT footer.
 *
 * Samsung phones append a short motion video after the JPEG EOI on every Motion
 * Photo. The SEF block structure wraps an MP4 whose frames are JPEGs with their
 * own (often location-bearing) Exif headers. That is why the trailer matters:
 * copying post-EOI bytes through a "metadata strip" would preserve exactly the
 * metadata the strip exists to remove. Real trailers are several MB; this is a
 * structurally representative minimum that carries the same Exif signature.
 */
export function buildSefTrailer(): number[] {
  // The Exif\0\0 bytes that appear inside the embedded JPEG thumbnail
  // that Samsung's SEF MP4 container holds.
  const embeddedJpegApp1Payload = [
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x4D, 0x4D, 0x00, 0x2A,             // TIFF: MM + magic
    0x00, 0x00, 0x00, 0x08,             // IFD0 at offset 8
    0x00, 0x00,                         // 0 IFD entries (minimal)
    0x00, 0x00, 0x00, 0x00,             // next IFD = 0
  ];

  // Minimal embedded JPEG thumbnail (SOI + APP1 + EOI) as would appear
  // inside the SEF's MP4 'mdat' box.
  const embeddedJpeg = [
    0xFF, 0xD8,                          // SOI of embedded thumbnail
    ...writeSegment([0xFF, 0xE1], embeddedJpegApp1Payload),
    0xFF, 0xD9,                          // EOI of embedded thumbnail
  ];

  // SEF block count and offset table (simplified from the Samsung SEF v2 spec)
  const blockName = Array.from(new TextEncoder().encode('moti')); // "moti" block type
  const blockDataOffset = 0x18;           // offset from end of SEFH to block data
  const blockDataSize = embeddedJpeg.length;

  const sefhBody = [
    0x00, 0x00, 0x00, 0x02,             // SEF version 2
    0x00, 0x00, 0x00, 0x01,             // num blocks = 1
    ...blockName,                        // block name: "moti"
    (blockDataOffset >> 24) & 0xFF, (blockDataOffset >> 16) & 0xFF,
    (blockDataOffset >> 8) & 0xFF, blockDataOffset & 0xFF,
    (blockDataSize >> 24) & 0xFF, (blockDataSize >> 16) & 0xFF,
    (blockDataSize >> 8) & 0xFF, blockDataSize & 0xFF,
  ];

  const sefhSize = sefhBody.length + 8; // 4 "SEFH" + 4 size field + body

  return [
    // SEFH marker
    0x53, 0x45, 0x46, 0x48,             // "SEFH"
    (sefhSize >> 24) & 0xFF, (sefhSize >> 16) & 0xFF,
    (sefhSize >> 8) & 0xFF, sefhSize & 0xFF,
    ...sefhBody,

    // Padding between SEFH and block data (blockDataOffset bytes)
    ...new Array(blockDataOffset).fill(0x00),

    // Embedded JPEG thumbnail with its own Exif\0\0 in APP1
    ...embeddedJpeg,

    // SEFT footer (trailer end marker + total SEF size)
    0x53, 0x45, 0x46, 0x54,             // "SEFT"
    0x00, 0x00, 0x00, 0x00,             // size placeholder (not needed for these tests)
  ];
}

// ---------------------------------------------------------------------------
// Real Samsung Galaxy S24 post-EOI layout
// ---------------------------------------------------------------------------

/**
 * Embedded Ultra HDR gain-map JPEG, as it appears immediately after the primary
 * stream's EOI on an S24 capture: a complete JPEG whose FIRST segment is an XMP
 * APP1 of declared length 605.
 *
 * It matters because it is the half of the trailer a pattern scan CAN see (the
 * XMP packet signature), which is why the real capture was detectable at all
 * before the strip learned to truncate at the EOI. Posting the photo drops it,
 * so an Ultra HDR capture posts as SDR (Mobile #736).
 */
export function buildGainMapJpeg(): number[] {
  const payload = [
    ...Array.from(new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0')),
    ...Array.from(new TextEncoder().encode(
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description ' +
      'hdrgm:Version="1.0" hdrgm:GainMapMin="0.0" hdrgm:GainMapMax="3.0"/>' +
      '</rdf:RDF></x:xmpmeta>',
    )),
  ];
  // The real segment declares 605; pad the packet out to match it exactly.
  const declaredLength = 605;
  while (payload.length < declaredLength - 2) payload.push(0x20); // XMP pad
  return [
    0xFF, 0xD8,
    ...writeSegment([0xFF, 0xE1], payload),
    ...writeSegment([0xFF, 0xC0], SOF_PAYLOAD),
    ...writeSegment([0xFF, 0xC4], DHT_PAYLOAD),
    ...writeSegment([0xFF, 0xDA], SOS_PAYLOAD),
    0x7F, 0x11, 0x22,
    0xFF, 0xD9,
  ];
}

/**
 * The capture timestamp carried by the committed SEF tail, SCRUBBED.
 *
 * The real capture wrote a 13-digit epoch-millis value; it is replaced here by
 * the same number of digits, because every offset in the SEFH index is measured
 * backwards from "SEFH" and a shorter value would invalidate the whole table.
 */
export const S24_SEF_CAPTURE_TIMESTAMP = '1700000000000';

/** Mobile Country Code recorded by the capture. 311 = United States. */
export const S24_SEF_MCC = '311';

/**
 * The last 217 bytes of a real Samsung Galaxy S24 photo -- the Samsung SEF tail
 * that validated the #732 fix, committed as reviewable hex rather than as an
 * opaque binary fixture.
 *
 * Provenance: source photo sha256
 * 537437998214caecc4b08f04f38a6abe8fdbafecfbac09bafe07f9adaaa4e341,
 * 2,685,491 bytes. Its primary JPEG stream closed with an EOI at offset
 * 2,643,609; the 41,880 bytes that followed were an embedded Ultra HDR gain-map
 * JPEG (first segment an XMP APP1 of declared length 605 -- see
 * buildGainMapJpeg) and then these 217 bytes. The photo is not in the repo.
 *
 * Layout: five key/value blocks (Image_UTC_Data, MCC_Data, Color_Display_P3,
 * Photo_HDR_Info, Camera_Capture_Mode_Info), then "SEFH" with one 12-byte index
 * entry per block, a size field, and the terminal "SEFT" magic.
 *
 * Why it is the interesting half: this tail carries NO "Exif\0\0" and NO XMP
 * packet, so no pattern scan can see it -- yet it is plainly capture metadata
 * (time, carrier country, HDR mode, capture mode). On the copy-through path,
 * where the strip cannot find an EOI, the terminal SEFT check in hasExif is the
 * only thing that catches it.
 */
export const S24_SEF_TAIL_HEX =
  '0000010a0e000000496d6167655f5554435f446174613137303030303030303030303000' +
  '00a10a080000004d43435f446174613331310000c10c10000000436f6c6f725f44697370' +
  '6c61795f50330c06060000d20c0e00000050686f746f5f4844525f496e666f000000610c' +
  '1800000043616d6572615f436170747572655f4d6f64655f496e666f31534546486b0000' +
  '00050000000000010a89000000230000000000a10a66000000130000000000c10c530000' +
  '001b0000000000d20c38000000170000000000610c210000002100000048000000534546' +
  '54';

/** The real S24 SEF tail as bytes. */
export function s24SefTail(): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < S24_SEF_TAIL_HEX.length; i += 2) {
    bytes.push(parseInt(S24_SEF_TAIL_HEX.slice(i, i + 2), 16));
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

export interface BuildPngOptions {
  /** eXIf chunk (dropped by the stripper). */
  exif?: boolean;
  /** tEXt chunk (dropped by the stripper). */
  text?: boolean;
  /** tIME chunk (dropped by the stripper). */
  time?: boolean;
  /** Raw bytes emitted directly after the IDAT chunk (e.g. a malformed chunk from `writeChunk`). */
  afterIdat?: number[];
  /** Emit no IEND chunk. */
  omitIend?: boolean;
  /** Bytes appended after IEND (or after everything, when `omitIend`). */
  tail?: number[];
}

/** PNG signature. */
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** IHDR payload: 16x16, 8-bit, color type 2 (RGB), no interlace. */
const IHDR_PAYLOAD = [
  0, 0, 0, 16, // width
  0, 0, 0, 16, // height
  8, // bit depth
  2, // color type (RGB)
  0, // compression
  0, // filter
  0, // interlace
];

/** IDAT payload: minimal, not a decodable zlib stream. */
const IDAT_PAYLOAD = [0x08, 0x99, 0x01, 0x00];

/**
 * Structurally complete PNG with optional metadata chunks and an optional tail.
 *
 * Layout: signature, IHDR, [eXIf], [tEXt], [tIME], IDAT, [afterIdat], [IEND],
 * [tail].
 */
export function buildPng(opts: BuildPngOptions = {}): Uint8Array {
  const { exif = false, text = false, time = false, afterIdat = [], omitIend = false, tail = [] } = opts;

  const parts: number[] = [...PNG_SIGNATURE];

  parts.push(...writeChunk('IHDR', IHDR_PAYLOAD));

  if (exif) {
    parts.push(...writeChunk('eXIf', [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4D, 0x4D])); // "Exif\0\0MM"
  }

  if (text) {
    parts.push(...writeChunk('tEXt', Array.from(new TextEncoder().encode('Comment\0Test text'))));
  }

  if (time) {
    parts.push(...writeChunk('tIME', [0x07, 0xEA, 0x07, 0x11, 0x0A, 0x1E, 0x00]));
  }

  parts.push(...writeChunk('IDAT', IDAT_PAYLOAD));

  parts.push(...afterIdat);

  if (!omitIend) {
    parts.push(...writeChunk('IEND', []));
  }

  parts.push(...tail);

  return new Uint8Array(parts);
}
