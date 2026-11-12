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
  type MediaDecision,
  type PostMediaItem,
} from '../mediaPrePass';

import type { ArchiveImportSession, UriResolution } from '../archiveAccess';

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
  it('imports a resolved entry whose peek says image', async () => {
    const built = mediaArchive({ name: 'photo.jpg', head: JPEG_HEAD });
    await expect(decideOne(built, 'media/posts/photo.jpg')).resolves.toEqual({
      decision: 'import-image',
      entryId: built.entryIdFor('photo.jpg'),
    });
  });

  it('holds held_video for a peek that says video', async () => {
    const built = mediaArchive({ name: 'clip.mp4', head: mp4Head() });
    await expect(decideOne(built, 'media/posts/clip.mp4')).resolves.toEqual({
      decision: 'hold',
      reason: 'held_video',
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

// A compile-time check that the session slices the pre-pass asks for are
// really the session's: a widened `Pick` would make the pre-pass able to
// extract, which it must never do.
const _sessionShape: (s: ArchiveImportSession) => void = (session) => {
  void resolveFileMedia(session, []);
  void peekMediaEntries(session, [], createFilePeekScope(createPeekBudget()));
};
void _sessionShape;
