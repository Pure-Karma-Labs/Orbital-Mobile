/**
 * The media pre-pass (#925, hold obligation #983).
 *
 * ## The oracle is the real policy layer
 *
 * Every peek in this suite goes through the REAL `peekEntryKind` — the
 * builders fill the jest manual mock's native-shaped session and open it with
 * the production `openArchiveSession` — so the ORDER contract (a listed video
 * wins before a listing skip is consulted, contract (e)) and the F1 sniff
 * table are the things under test, not a second hand-written fake's idea of
 * them. The only outcome rows that call `classifyMediaItem` directly are the
 * ones no session can produce; each says so.
 *
 * The structural tests (chunking, parity, sequencing, the budget, abort) are
 * about the pre-pass's own obligations and build their sessions the same way.
 */

import {
  JPEG_HEAD,
  buildArchive,
  mp4Head,
  svgHead,
  unknownHead,
  type BuiltArchive,
} from '../testUtils/builders';
import {
  MAX_MEDIA_URIS_PER_FILE,
  MAX_URIS_PER_RESOLVE_CALL,
  classifyMediaItem,
  createFilePeekScope,
  createPeekBudget,
  foldPostMediaDecisions,
  peekMediaEntries,
  resolveFileMedia,
  type HoldReason,
  type MediaDecision,
  type PostMediaItem,
} from '../mediaPrePass';

import type {
  ArchiveImportSession,
  RustEntrySkipCode,
  UriResolution,
  UriSkipCode,
} from '../archiveAccess';

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Resolve + peek + classify one post's uris, exactly as `parseArchive` will. */
async function decideAll(
  built: BuiltArchive,
  uris: readonly string[],
  scope = createFilePeekScope(createPeekBudget()),
): Promise<MediaDecision[]> {
  const session = await built.open();
  const resolved = await resolveFileMedia(session, uris);
  if (!resolved.ok) throw new Error(`unexpected file issue: ${resolved.issue}`);
  const entryIds = resolved.resolutions.flatMap((r) => (r.ok ? [r.entryId] : []));
  const peeks = await peekMediaEntries(session, entryIds, scope);
  return resolved.resolutions.map((r) =>
    classifyMediaItem(r, r.ok ? (peeks.get(r.entryId) ?? null) : null),
  );
}

/** The single decision for one uri. */
async function decideOne(built: BuiltArchive, uri: string): Promise<MediaDecision> {
  const [decision] = await decideAll(built, [uri]);
  return decision;
}

/** A one-entry archive at `media/posts/<name>`, built from a spec. */
function mediaArchive(
  spec: Omit<Parameters<typeof buildArchive>[0][number], 'path'> & { readonly name: string },
  options: Parameters<typeof buildArchive>[1] = {},
): BuiltArchive {
  const { name, ...rest } = spec;
  return buildArchive([{ path: `media/posts/${name}`, ...rest }], options);
}

const item = (result: MediaDecision, originalDate: number | null = null): PostMediaItem => ({
  result,
  originalDate,
});

// ---------------------------------------------------------------------------
// Outcome rows (plan §4): one test per row of the hold table.
// ---------------------------------------------------------------------------

describe('outcome rows', () => {
  // Heads built HERE rather than in the builders: the builders export the
  // heads several suites share, and these three exist only so the image row
  // cannot pass by knowing one magic number. Each is another signature
  // `sniffContentType` recognises as a still image.

  /** The 8-byte PNG signature plus the start of its IHDR chunk. */
  function pngHead(): Uint8Array {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  }

  /** `GIF89a`, the newer of the two GIF version stamps. */
  function gifHead(): Uint8Array {
    return new Uint8Array(Array.from('GIF89a', (c) => c.charCodeAt(0)));
  }

  /** A RIFF container whose form type is `WEBP`. */
  function webpHead(): Uint8Array {
    const head = new Uint8Array(16);
    head.set(
      Array.from('RIFF', (c) => c.charCodeAt(0)),
      0,
    );
    head.set(
      Array.from('WEBP', (c) => c.charCodeAt(0)),
      8,
    );
    return head;
  }

  /**
   * One `it.each` row per key, with the key's own type kept.
   *
   * The tables below are `Record`s keyed by a skip union so that completeness
   * is a COMPILE error rather than a reviewer's count: a code added to Rust or
   * to the uri resolver leaves the annotation short a key until someone decides
   * its hold, and a code removed leaves a stale one.
   */
  function rowsOf<K extends string, V>(table: Readonly<Record<K, V>>): [K, V][] {
    return Object.entries<V>(table).map(([key, value]) => [key as K, value]);
  }

  // -------------------------------------------------------------------------
  // Row 1: the five resolution skips
  // -------------------------------------------------------------------------

  const RESOLUTION_HOLDS: Readonly<Record<UriSkipCode, HoldReason>> = {
    // Retryable with a fuller ZIP-part selection: the target may be in a part
    // the member did not hand over.
    URI_UNRESOLVED: 'media_missing',
    URI_AMBIGUOUS: 'media_missing',
    // The reference itself is the problem, so re-running changes nothing.
    URI_INVALID: 'media_unsupported_reference',
    URI_OUTSIDE_ALLOWLIST: 'media_unsupported_reference',
    URI_UNSUPPORTED_KIND: 'media_unsupported_reference',
  };

  it.each(rowsOf(RESOLUTION_HOLDS))(
    'holds %s as %s, having looked at nothing',
    async (skip, reason) => {
      // `uriOverrides` is the only deterministic lever for the four codes the
      // builders' own path match never produces, and the resolution still comes
      // back through the real `resolveFileMedia`, index-aligned.
      const built = mediaArchive(
        { name: 'photo.jpg', head: JPEG_HEAD },
        { uriOverrides: { 'media/posts/ref.jpg': { ok: false, skip } } },
      );

      await expect(decideOne(built, 'media/posts/ref.jpg')).resolves.toEqual({
        decision: 'hold',
        reason,
      });
      // An unresolved uri names no entry, so there is nothing to peek at — and
      // a peek on a guessed id would be exactly the wrong photo.
      expect(built.mock.peekHead).not.toHaveBeenCalled();
    },
  );

  // -------------------------------------------------------------------------
  // Row 2: a positive image verdict, the one import licence
  // -------------------------------------------------------------------------

  it('imports a resolved entry whose peek says image', async () => {
    const built = mediaArchive({ name: 'photo.jpg', head: JPEG_HEAD });
    await expect(decideOne(built, 'media/posts/photo.jpg')).resolves.toEqual({
      decision: 'import-image',
      entryId: built.entryIdFor('photo.jpg'),
    });
  });

  it.each([
    ['a PNG head', pngHead()],
    ['a GIF89a head', gifHead()],
    ['a WebP head', webpHead()],
  ])('imports an entry with %s', async (_label, head) => {
    // The licence is "the sniff said image", not "the bytes said JPEG": a
    // JPEG-only row would pass against a sniff table that had lost every other
    // still format, and a member's PNGs would silently stop importing.
    const built = mediaArchive({ name: 'photo.jpg', head });
    await expect(decideOne(built, 'media/posts/photo.jpg')).resolves.toEqual({
      decision: 'import-image',
      entryId: built.entryIdFor('photo.jpg'),
    });
  });

  // -------------------------------------------------------------------------
  // Row 3: video, by every route the real peek can reach it
  // -------------------------------------------------------------------------

  it('holds held_video for a peek that says video', async () => {
    const built = mediaArchive({ name: 'clip.mp4', head: mp4Head() });
    await expect(decideOne(built, 'media/posts/clip.mp4')).resolves.toEqual({
      decision: 'hold',
      reason: 'held_video',
    });
  });

  it('holds held_video for a LISTED video without reading a byte of it', async () => {
    const built = mediaArchive({ name: 'clip.mov' });
    await expect(decideOne(built, 'media/posts/clip.mov')).resolves.toEqual({
      decision: 'hold',
      reason: 'held_video',
    });
    // The listed kind is evidence enough, and holding is free: the head is
    // never inflated, so a 2 GB clip costs the run nothing.
    expect(built.mock.peekHead).not.toHaveBeenCalled();
  });

  it('holds held_video for mp4 bytes under an image NAME', async () => {
    // The F1 sniff is the only thing standing between a disguised video and an
    // import that would claim to be a photo: the listing says image here.
    const built = mediaArchive({ name: 'photo.jpg', head: mp4Head() });
    await expect(decideOne(built, 'media/posts/photo.jpg')).resolves.toEqual({
      decision: 'hold',
      reason: 'held_video',
    });
    expect(built.mock.peekHead).toHaveBeenCalledTimes(1);
  });

  it('holds held_video for a listed video that Rust ALSO skipped', async () => {
    const built = mediaArchive({ name: 'clip.mp4', skip: 'ENTRY_CORRUPT' });
    const session = await built.open();
    const entryId = built.entryIdFor('clip.mp4');

    // The resolution is SYNTHESISED and the peek is REAL. The builders answer
    // `URI_UNRESOLVED` for any skipped entry (a skipped entry is
    // indistinguishable from an absent one), so routing this row through
    // `resolveFileMedia` would prove `media_missing` and leave contract (e) —
    // a listed video wins BEFORE the listing skip is consulted — untested.
    const peek = await session.peekEntryKind(entryId);

    expect(peek).toEqual({ ok: true, kind: 'video' });
    expect(classifyMediaItem({ ok: true, entryId }, peek)).toEqual({
      decision: 'hold',
      reason: 'held_video',
    });
    expect(built.mock.peekHead).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Row 4: an indeterminate sniff
  // -------------------------------------------------------------------------

  it.each([
    ['WebM or MKV magic', unknownHead()],
    ['an SVG document', svgHead()],
    ['an empty head', new Uint8Array(0)],
  ])('holds media_unreadable for %s under an image name', async (_label, head) => {
    // "Unrecognised" is never "not a video": the sniff knows ISO-BMFF video
    // only, so a WebM arrives here and must hold rather than import.
    const built = mediaArchive({ name: 'photo.jpg', head });
    await expect(decideOne(built, 'media/posts/photo.jpg')).resolves.toEqual({
      decision: 'hold',
      reason: 'media_unreadable',
    });
  });

  it('reports ENTRY_SNIFF_INDETERMINATE for bytes nothing recognises', async () => {
    // Named here once, so the row above is tied to the code the sniff really
    // produces rather than to any failure that happens to hold.
    const built = mediaArchive({ name: 'photo.jpg', head: unknownHead() });
    const session = await built.open();
    await expect(session.peekEntryKind(built.entryIdFor('photo.jpg'))).resolves.toEqual({
      ok: false,
      skip: 'ENTRY_SNIFF_INDETERMINATE',
    });
  });

  // -------------------------------------------------------------------------
  // Row 5: every Rust entry skip
  // -------------------------------------------------------------------------

  // Every code Rust can put on a listed entry, and the hold each one earns.
  // They all earn the same one: a skip is never proof of "not a video", so
  // "we could not read it" is as far as the pre-pass may go.
  const LISTING_SKIP_HOLDS: Readonly<Record<RustEntrySkipCode, HoldReason>> = {
    ENTRY_PATH_INVALID: 'media_unreadable',
    ENTRY_PATH_TRAVERSAL: 'media_unreadable',
    ENTRY_SYMLINK: 'media_unreadable',
    ENTRY_SPECIAL_FILE: 'media_unreadable',
    ENTRY_ENCRYPTED: 'media_unreadable',
    ENTRY_NESTED_ARCHIVE: 'media_unreadable',
    ENTRY_UNSUPPORTED_METHOD: 'media_unreadable',
    ENTRY_DUPLICATE: 'media_unreadable',
    ENTRY_OVER_CAP: 'media_unreadable',
    ENTRY_RATIO_EXCEEDED: 'media_unreadable',
    ENTRY_CORRUPT: 'media_unreadable',
    ENTRY_KIND_NOT_ENABLED: 'media_unreadable',
    ENTRY_KIND_MISMATCH: 'media_unreadable',
    ENTRY_NOT_UTF8: 'media_unreadable',
    ENTRY_NOT_ALLOWLISTED: 'media_unreadable',
  };

  it.each(rowsOf(LISTING_SKIP_HOLDS))('holds a listing %s as %s', async (skip, reason) => {
    const built = mediaArchive({ name: 'x.jpg', skip });
    const session = await built.open();
    const entryId = built.entryIdFor('x.jpg');

    // Synthesised resolution, real peek — for the reason given in the listed-
    // video row: the builders report a listing-skipped entry as
    // `URI_UNRESOLVED`, so the end-to-end route would classify every one of
    // these 15 codes as `media_missing` and never reach the peek arm.
    const peek = await session.peekEntryKind(entryId);

    expect(peek).toEqual({ ok: false, skip });
    expect(classifyMediaItem({ ok: true, entryId }, peek)).toEqual({
      decision: 'hold',
      reason,
    });
  });

  it('holds media_unreadable when the head read itself fails', async () => {
    // The end-to-end counterpart of the 15 rows above: nothing is wrong with
    // the LISTING, so the uri resolves and the failure arrives from `peekHead`.
    const built = mediaArchive({ name: 'torn.jpg', readSkip: 'ENTRY_CORRUPT' });
    await expect(decideOne(built, 'media/posts/torn.jpg')).resolves.toEqual({
      decision: 'hold',
      reason: 'media_unreadable',
    });
    expect(built.mock.peekHead).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Row 6: the two skip codes no session can produce
  // -------------------------------------------------------------------------

  it('holds unsupported_image_format for ENTRY_UNSUPPORTED_IMAGE_FORMAT', () => {
    // Direct, because `peekEntryKind` cannot produce this code today (verified
    // 2026-11-12): `sniffContentType` returns only `image/*`, `video/*` or
    // `null`, so `classifySniff`'s non-image branch never fires and an exotic
    // head arrives as `ENTRY_SNIFF_INDETERMINATE` instead. The live producer is
    // #926's upload-time `sanitizeStillImage` failure, long after this pre-pass
    // — the row exists so the code already has its hold when that wiring lands.
    expect(
      classifyMediaItem(
        { ok: true, entryId: 'fp0:1' },
        { ok: false, skip: 'ENTRY_UNSUPPORTED_IMAGE_FORMAT' },
      ),
    ).toEqual({ decision: 'hold', reason: 'unsupported_image_format' });
  });

  it('holds held_video for ENTRY_IS_VIDEO arriving as a skip', () => {
    // Also unreachable from `peekEntryKind`, which maps this verdict to
    // `{ok: true, kind: 'video'}` before it can ever be returned as a skip.
    // Video evidence either way, so the hold must agree with the `ok` arm.
    expect(
      classifyMediaItem({ ok: true, entryId: 'fp0:1' }, { ok: false, skip: 'ENTRY_IS_VIDEO' }),
    ).toEqual({ decision: 'hold', reason: 'held_video' });
  });

  // -------------------------------------------------------------------------
  // Row 7: the budget ran out
  // -------------------------------------------------------------------------

  it('holds media_unreadable for an item the budget never let us look at', () => {
    // `null` is "never looked at", not "nothing wrong": the item was never
    // classified, and an unclassified item has no licence.
    expect(classifyMediaItem({ ok: true, entryId: 'fp0:1' }, null)).toEqual({
      decision: 'hold',
      reason: 'media_unreadable',
    });
  });
});

// ---------------------------------------------------------------------------
// Resolution: chunking, caps, parity, abort
// ---------------------------------------------------------------------------

describe('resolveFileMedia', () => {
  function manyUris(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `media/posts/p${i}.jpg`);
  }

  it('chunks at MAX_URIS_PER_RESOLVE_CALL and returns one resolution per uri, in order', async () => {
    const built = mediaArchive({ name: 'photo.jpg', head: JPEG_HEAD });
    const session = await built.open();
    const uris = [...manyUris(MAX_URIS_PER_RESOLVE_CALL + 500), 'media/posts/photo.jpg'];

    const result = await resolveFileMedia(session, uris);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.resolutions).toHaveLength(uris.length);
    const callLengths = built.mock.resolveMediaUris.mock.calls.map(([chunk]) => chunk.length);
    expect(callLengths).toEqual([MAX_URIS_PER_RESOLVE_CALL, 501]);
    // Index alignment is the contract: the only resolvable uri is the last one.
    expect(result.resolutions[result.resolutions.length - 1]).toEqual({
      ok: true,
      entryId: built.entryIdFor('photo.jpg'),
    });
    expect(result.resolutions[0]).toEqual({ ok: false, skip: 'URI_UNRESOLVED' });
  });

  it('resolves a single-chunk file in one call', async () => {
    const built = mediaArchive({ name: 'photo.jpg', head: JPEG_HEAD });
    const session = await built.open();
    await resolveFileMedia(session, ['media/posts/photo.jpg']);
    expect(built.mock.resolveMediaUris).toHaveBeenCalledTimes(1);
  });

  it('refuses a file over MAX_MEDIA_URIS_PER_FILE without resolving anything', async () => {
    const built = mediaArchive({ name: 'photo.jpg', head: JPEG_HEAD });
    const session = await built.open();

    const result = await resolveFileMedia(session, manyUris(MAX_MEDIA_URIS_PER_FILE + 1));

    expect(result).toEqual({ ok: false, issue: 'json_too_many_media' });
    expect(built.mock.resolveMediaUris).not.toHaveBeenCalled();
  });

  it('accepts a file exactly at the cap', async () => {
    const built = mediaArchive({ name: 'photo.jpg', head: JPEG_HEAD });
    const session = await built.open();
    const result = await resolveFileMedia(session, manyUris(MAX_MEDIA_URIS_PER_FILE));
    expect(result.ok).toBe(true);
  });

  it('throws ARCHIVE_INTERNAL when a chunk comes back short of its input', async () => {
    const built = mediaArchive({ name: 'photo.jpg', head: JPEG_HEAD });
    built.mock.resolveMediaUris.mockImplementation((uris) =>
      uris.slice(1).map(() => ({ ok: false, skip: 'URI_UNRESOLVED' as const })),
    );
    const session = await built.open();

    await expect(resolveFileMedia(session, ['a.jpg', 'b.jpg'])).rejects.toMatchObject({
      code: 'ARCHIVE_INTERNAL',
    });
  });

  it('throws ARCHIVE_INTERNAL when a chunk comes back longer than its input', async () => {
    const built = mediaArchive({ name: 'photo.jpg', head: JPEG_HEAD });
    built.mock.resolveMediaUris.mockImplementation((uris): UriResolution[] => [
      ...uris.map(() => ({ ok: false, skip: 'URI_UNRESOLVED' }) as const),
      { ok: false, skip: 'URI_UNRESOLVED' } as const,
    ]);
    const session = await built.open();

    await expect(resolveFileMedia(session, ['a.jpg'])).rejects.toMatchObject({
      code: 'ARCHIVE_INTERNAL',
    });
  });

  it('checks the signal between chunks and stops resolving', async () => {
    const built = mediaArchive({ name: 'photo.jpg', head: JPEG_HEAD });
    const controller = new AbortController();
    built.mock.resolveMediaUris.mockImplementation((uris) => {
      controller.abort();
      return uris.map(() => ({ ok: false, skip: 'URI_UNRESOLVED' as const }));
    });
    const session = await built.open();

    await expect(
      resolveFileMedia(session, manyUris(MAX_URIS_PER_RESOLVE_CALL + 1), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ECANCELLED' });
    expect(built.mock.resolveMediaUris).toHaveBeenCalledTimes(1);
  });

  it('refuses before the first chunk when the signal is already aborted', async () => {
    const built = mediaArchive({ name: 'photo.jpg', head: JPEG_HEAD });
    const controller = new AbortController();
    controller.abort();
    const session = await built.open();

    await expect(
      resolveFileMedia(session, ['media/posts/photo.jpg'], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ECANCELLED' });
    expect(built.mock.resolveMediaUris).not.toHaveBeenCalled();
  });

  it('does not catch a resolver throw', async () => {
    const built = mediaArchive({ name: 'photo.jpg', head: JPEG_HEAD });
    built.mock.resolveMediaUris.mockImplementation(() => {
      throw new Error('native blew up');
    });
    const session = await built.open();
    await expect(resolveFileMedia(session, ['a.jpg'])).rejects.toThrow('native blew up');
  });
});

// ---------------------------------------------------------------------------
// Peek: sequencing, memo, budget
// ---------------------------------------------------------------------------

describe('peekMediaEntries', () => {
  /** Count overlapping `peekHead` calls: contract (d) says there are none. */
  function trackConcurrency(built: BuiltArchive): { max: () => number } {
    let live = 0;
    let max = 0;
    const heads = new Map<string, Uint8Array>();
    for (const entry of built.entries) heads.set(entry.entryId, JPEG_HEAD);
    built.mock.peekHead.mockImplementation(async (entryId: string) => {
      live += 1;
      max = Math.max(max, live);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      live -= 1;
      return { ok: true, head: heads.get(entryId) ?? JPEG_HEAD };
    });
    return { max: () => max };
  }

  function photoArchive(count: number): BuiltArchive {
    return buildArchive(
      Array.from({ length: count }, (_, i) => ({
        path: `media/posts/p${i}.jpg`,
        head: JPEG_HEAD,
      })),
    );
  }

  it('peeks sequentially, never overlapping two calls', async () => {
    const built = photoArchive(4);
    const concurrency = trackConcurrency(built);
    const session = await built.open();

    await peekMediaEntries(
      session,
      built.entries.map((e) => e.entryId),
      createFilePeekScope(createPeekBudget()),
    );

    expect(built.mock.peekHead).toHaveBeenCalledTimes(4);
    expect(concurrency.max()).toBe(1);
  });

  it('memoises per entry id within a file scope, across calls', async () => {
    const built = photoArchive(1);
    const session = await built.open();
    const scope = createFilePeekScope(createPeekBudget());
    const [entryId] = built.entries.map((e) => e.entryId);

    const first = await peekMediaEntries(session, [entryId, entryId], scope);
    const second = await peekMediaEntries(session, [entryId], scope);

    expect(built.mock.peekHead).toHaveBeenCalledTimes(1);
    expect(first.get(entryId)).toEqual({ ok: true, kind: 'image', contentType: 'image/jpeg' });
    expect(second.get(entryId)).toEqual(first.get(entryId));
    expect(scope.budget.remaining).toBe(createPeekBudget().remaining - 1);
  });

  it('charges one budget unit per distinct entry, and nothing for a memo hit', async () => {
    const built = photoArchive(3);
    const session = await built.open();
    const scope = createFilePeekScope(createPeekBudget(10));
    const ids = built.entries.map((e) => e.entryId);

    await peekMediaEntries(session, [...ids, ...ids], scope);

    expect(scope.budget.remaining).toBe(7);
    expect(built.mock.peekHead).toHaveBeenCalledTimes(3);
  });

  it('returns null past the run-wide budget, and the fold holds media_unreadable', async () => {
    const built = photoArchive(2);
    const session = await built.open();
    const scope = createFilePeekScope(createPeekBudget(1));
    const ids = built.entries.map((e) => e.entryId);

    const peeks = await peekMediaEntries(session, ids, scope);

    expect(built.mock.peekHead).toHaveBeenCalledTimes(1);
    expect(peeks.get(ids[0])).toEqual({ ok: true, kind: 'image', contentType: 'image/jpeg' });
    expect(peeks.get(ids[1])).toBeNull();
    expect(classifyMediaItem({ ok: true, entryId: ids[1] }, peeks.get(ids[1]) ?? null)).toEqual({
      decision: 'hold',
      reason: 'media_unreadable',
    });
  });

  it('shares one budget across file scopes and re-peeks in a new scope', async () => {
    const built = photoArchive(1);
    const session = await built.open();
    const budget = createPeekBudget(10);
    const [entryId] = built.entries.map((e) => e.entryId);

    await peekMediaEntries(session, [entryId], createFilePeekScope(budget));
    await peekMediaEntries(session, [entryId], createFilePeekScope(budget));

    expect(built.mock.peekHead).toHaveBeenCalledTimes(2);
    expect(budget.remaining).toBe(8);
  });

  it('checks the signal before each peek', async () => {
    const built = photoArchive(2);
    const controller = new AbortController();
    built.mock.peekHead.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ ok: true, head: JPEG_HEAD });
    });
    const session = await built.open();

    await expect(
      peekMediaEntries(
        session,
        built.entries.map((e) => e.entryId),
        createFilePeekScope(createPeekBudget()),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'ECANCELLED' });
    expect(built.mock.peekHead).toHaveBeenCalledTimes(1);
  });

  it('does not catch a peek throw, and the entry has still spent its budget', async () => {
    const built = photoArchive(1);
    built.mock.peekHead.mockRejectedValue(new Error('native blew up'));
    const session = await built.open();
    const scope = createFilePeekScope(createPeekBudget(5));

    await expect(
      peekMediaEntries(
        session,
        built.entries.map((e) => e.entryId),
        scope,
      ),
    ).rejects.toThrow('native blew up');
    expect(scope.budget.remaining).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// The whole-post fold
// ---------------------------------------------------------------------------

describe('foldPostMediaDecisions', () => {
  const importImage = (entryId: string): MediaDecision => ({ decision: 'import-image', entryId });

  it('imports every item when nothing holds, carrying each date', () => {
    expect(
      foldPostMediaDecisions([item(importImage('a'), 1_700_000_000_000), item(importImage('b'))]),
    ).toEqual({
      outcome: 'import',
      media: [
        { entryId: 'a', originalDate: 1_700_000_000_000 },
        { entryId: 'b', originalDate: null },
      ],
    });
  });

  it('imports an empty list for a post with no media', () => {
    expect(foldPostMediaDecisions([])).toEqual({ outcome: 'import', media: [] });
  });

  it('holds the WHOLE post when a single item holds', () => {
    expect(
      foldPostMediaDecisions([
        item(importImage('a')),
        item({ decision: 'hold', reason: 'media_missing' }),
        item(importImage('b')),
      ]),
    ).toEqual({ outcome: 'hold', reason: 'media_missing' });
  });

  it.each([
    ['held_video', 'unsupported_image_format'],
    ['unsupported_image_format', 'media_missing'],
    ['media_missing', 'media_unsupported_reference'],
    ['media_unsupported_reference', 'media_unreadable'],
  ] as const)('reports %s ahead of %s, in either order', (winner, loser) => {
    const decisions = [
      item({ decision: 'hold', reason: loser }),
      item({ decision: 'hold', reason: winner }),
    ];
    expect(foldPostMediaDecisions(decisions)).toEqual({ outcome: 'hold', reason: winner });
    expect(foldPostMediaDecisions([...decisions].reverse())).toEqual({
      outcome: 'hold',
      reason: winner,
    });
  });

  it('reports held_video over every other hold at once', () => {
    expect(
      foldPostMediaDecisions([
        item({ decision: 'hold', reason: 'media_unreadable' }),
        item({ decision: 'hold', reason: 'media_unsupported_reference' }),
        item({ decision: 'hold', reason: 'media_missing' }),
        item({ decision: 'hold', reason: 'unsupported_image_format' }),
        item({ decision: 'hold', reason: 'held_video' }),
      ]),
    ).toEqual({ outcome: 'hold', reason: 'held_video' });
  });
});

// ---------------------------------------------------------------------------
// End to end over one post
// ---------------------------------------------------------------------------

describe('a mixed post', () => {
  it('holds a photo+video post whole, through the real peek path', async () => {
    const built = buildArchive([
      { path: 'media/posts/photo.jpg', head: JPEG_HEAD },
      { path: 'media/posts/clip.mp4', head: mp4Head() },
    ]);

    const decisions = await decideAll(built, ['media/posts/photo.jpg', 'media/posts/clip.mp4']);

    expect(decisions[0]).toEqual({
      decision: 'import-image',
      entryId: built.entryIdFor('photo.jpg'),
    });
    expect(foldPostMediaDecisions(decisions.map((d) => item(d)))).toEqual({
      outcome: 'hold',
      reason: 'held_video',
    });
  });

  it('imports a two-photo post whole', async () => {
    const built = buildArchive([
      { path: 'media/posts/a.jpg', head: JPEG_HEAD },
      { path: 'media/posts/b.jpg', head: JPEG_HEAD },
    ]);

    const decisions = await decideAll(built, ['media/posts/a.jpg', 'media/posts/b.jpg']);

    expect(foldPostMediaDecisions(decisions.map((d, i) => item(d, i)))).toEqual({
      outcome: 'import',
      media: [
        { entryId: built.entryIdFor('a.jpg'), originalDate: 0 },
        { entryId: built.entryIdFor('b.jpg'), originalDate: 1 },
      ],
    });
  });

  it('never peeks an unresolved uri', async () => {
    const built = buildArchive([{ path: 'media/posts/a.jpg', head: JPEG_HEAD }]);
    const decisions = await decideAll(built, ['media/posts/missing.jpg']);
    expect(decisions).toEqual([{ decision: 'hold', reason: 'media_missing' }]);
    expect(built.mock.peekHead).not.toHaveBeenCalled();
  });
});

describe('the session slice the pre-pass asks for', () => {
  // A real session is accepted wherever the module asks for a `Pick` of one —
  // a compile-time fact, asserted at runtime so the annotation cannot rot. The
  // narrowing is the point: the pre-pass can resolve and peek, and the type
  // does not let it extract a file.
  it('accepts a whole ArchiveImportSession and resolves nothing for an empty list', async () => {
    const built = buildArchive([{ path: 'media/posts/a.jpg', head: JPEG_HEAD }]);
    const session: ArchiveImportSession = await built.open();

    const resolved = await resolveFileMedia(session, []);
    const peeks = await peekMediaEntries(session, [], createFilePeekScope(createPeekBudget()));

    expect(resolved).toEqual({ ok: true, resolutions: [] });
    expect(peeks.size).toBe(0);
    expect(built.mock.resolveMediaUris).not.toHaveBeenCalled();
    expect(built.mock.peekHead).not.toHaveBeenCalled();
  });
});
