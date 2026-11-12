# Meta import test fixtures (#925)

Synthetic builders for Facebook and Instagram "Download Your Information"
archives, used by the `metaImport` parser tests.

## Rules

1. **No real export content, ever.** This repository is PUBLIC. Nothing in this
   directory — no caption, filename, timestamp, fbid or uri — may be copied
   from a real Meta export. The *shapes* were read from two local sample
   exports; everything written down here is invented.
2. **Real ZIPs are never committed.** They are tens of megabytes of one
   person's life. `#922` owns the on-disk hostile-ZIP corpus for the Rust
   crate; it lives outside this repo too.
3. **The oracle is the production policy layer.** Builders fill the jest manual
   mock `__mocks__/orbital-archive-reader.ts` (`makeMockArchiveSession`, which
   is the native `ArchiveSession` shape) and then open it through the REAL
   `openArchiveSession` from `../archiveAccess.ts`. Never hand-roll a second
   `ArchiveImportSession`: the denied-root tripwire, the sniff table and
   `peekEntryKind`'s order contract are what the parser is being tested
   against, and a fake would quietly replace all three.
4. **Builders are not the implementation.** `mojibakeEscape` is hand-rolled
   rather than built on `encodeUtf8Strict`, so a fixture cannot agree with the
   code under test about a bug.

## Shape

```ts
const archive = fbArchive({ layout: 'activity', posts: [{ timestamp: 1_600_000_000, post: 'hi' }] });
const session = await archive.open();          // real openArchiveSession
const json = await session.readEntryJson(archive.entryIdFor('.json'));
```

- `buildArchive(specs, options)` — the primitive. Entry specs in, a listing
  plus a wired-up mock session out. `options.uriOverrides` is the only way to
  produce `URI_OUTSIDE_ALLOWLIST`, `URI_INVALID`, `URI_UNSUPPORTED_KIND` or
  `URI_AMBIGUOUS` deterministically.
- `fbEntrySpecs(file)` / `fbArchive(file)` — one Facebook post file and its
  media, in any of the three detected layouts. Compose several `*EntrySpecs`
  results into one `buildArchive` call for multi-file and multi-part tests.
- `JPEG_HEAD`, `mp4Head()`, `svgHead()`, `unknownHead()` — the 128-byte heads
  `peekHead` returns, one definition each (`archiveAccess.test.ts` imports the
  same ones).
- `mojibakeEscape(text)` — the exact inverse of `repairMojibake`: turns a
  readable synthetic string into the UTF-8-bytes-as-latin1 form Meta's
  exporter emits.

Entry ids (`fp0:N`) are **opaque**. A test may pass one around and compare it
for equality; it may never parse one.
