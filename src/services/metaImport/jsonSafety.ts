/**
 * Hostile-input JSON handling for the Meta import (#925).
 *
 * The archive reader (#920) hands this layer a `string` it has already bounded
 * at `MAX_JSON_BYTES` and validated as UTF-8. Everything after that is a JS
 * problem: `JSON.parse` on 12 MiB of attacker-shaped text can blow the Hermes
 * heap, nest deep enough to matter, or hand back a graph whose heavy subtrees
 * (EXIF, camera metadata, media variants) are ten times the size of the four
 * fields we actually read.
 *
 * Three defences, in order:
 *
 *  1. **A byte cap**, enforced before the read by comparing the entry's
 *     `declaredSize` against `MAX_JSON_BYTES` (PR 2's `layout.ts`). The
 *     constant here is asserted equal to the Rust one in this module's test.
 *  2. **A depth scan** (`scanJsonDepth`) before `JSON.parse`. Hermes has its
 *     own nesting limit — 510, a catchable `RangeError` — so this is defence
 *     in depth, not the only line: 32 is a schema fact about Meta exports, and
 *     refusing at 33 costs a file we could not have read usefully anyway.
 *  3. **A pruning reviver** that deletes dangerous and sensitive keys during
 *     `JSON.parse`, so EXIF, GPS, tags and places never exist in any object a
 *     parser, a logger or a crash reporter could touch. Read the bench below
 *     before assuming it also saves memory — it does not.
 *
 * ## Hermes bench (2026-11-12, PR 1 deliverable)
 *
 * Method: `/usr/bin/time -l ios/Pods/hermes-engine/destroot/bin/hermes -O
 * bench.js` on the Pods Hermes 0.82.1 binary the app ships (macOS arm64),
 * over a synthetic Facebook `posts.json` of 12,583,396 bytes / 13,113 posts
 * built in-process — never a real export. The pipeline was hand-ported into
 * plain JS verbatim. Peak RSS is the whole process maximum, so every row
 * includes the cost of building the input string; the GENERATE row is the
 * baseline to subtract. Bench scripts live outside the repo (they generate
 * 12 MiB inputs); these numbers are the deliverable.
 *
 * | Stage (single 12 MiB file, cumulative) | elapsed | peak RSS |
 * |---|---|---|
 * | generate input only (baseline) | 36 ms | 53.4 MB |
 * | + `scanJsonDepth` | 662 ms | 53.4 MB |
 * | + `JSON.parse` with `pruningReviver` | 366 ms | 89.9 MB |
 * | + schema pick | 48 ms | 90.2 MB |
 *
 * | Multi-file run (10 × 12 MiB, 129,744 posts) | elapsed | peak RSS |
 * |---|---|---|
 * | all ten files, dedup `Set` live and full at 50,000 hex keys | 11.8 s | 151.3 MB |
 *
 * (scan 6.86 s · parse 3.69 s · pick 0.65 s · key framing + `Set` 0.13 s)
 *
 * ### These numbers are a DESKTOP LOWER BOUND
 *
 * They were measured on macOS arm64 against the Pods Hermes binary, with
 * desktop memory pressure, a desktop allocator and no other app in the
 * foreground. A phone running the same code under memory pressure will be
 * SLOWER and will peak HIGHER, and a cap that is contract-class (lowering
 * `MAX_JSON_BYTES` is an Instagram identity-contract change — see
 * `sourceItemId.ts`) should not be frozen on a desktop measurement alone.
 * #926 therefore owes a real-device re-measure of the ten-file run before
 * release; the lever if it fails is lowering the cap, which is why the
 * measurement has to happen while that is still cheap.
 *
 * **Verdict: PASS.** 151 MB against the ≤ ~400 MB budget, with the dedup Set
 * at its `MAX_POSTS_PER_RUN` ceiling and ten full-size files in one run. No
 * cap is lowered, so the 12 MiB ceiling — and with it the Instagram identity
 * contract in `sourceItemId.ts` — stands. The F16 estimate of ~10× the JSON
 * bytes for parse alone was conservative: a bare parse peaked at 78.6 MB,
 * about 6× the input including the input string itself.
 *
 * ### Two measurements that corrected an assumption
 *
 *  - **The reviver does NOT reduce peak memory.** `JSON.parse` builds the
 *    whole graph and THEN walks it calling the reviver (the spec's
 *    `InternalizeJSONProperty` runs bottom-up on an already-constructed
 *    value), so pruning cannot prevent an allocation. Measured: parse without
 *    the reviver 132 ms / 78.6 MB, with it 366 ms / 89.9 MB; over ten files
 *    9.0 s / 143.3 MB versus 11.8 s / 151.3 MB. Holding the graph while 6 MB
 *    of unrelated work allocated gave 92.1 MB without and 102.5 MB with.
 *    The reviver's justification is therefore ENTIRELY hygiene — prototype
 *    pollution, and a hard guarantee that no GPS coordinate exists in any
 *    object downstream — bought for roughly 10 MB and 25% of parse time. That
 *    is a price worth paying, but it must be stated for the right reason.
 *  - **The depth scan dominates wall time**, at ~0.69 s per 12 MiB file
 *    (one `charCodeAt` per character). Ten files is ~7 s of scanning. It stays
 *    because it runs BEFORE `JSON.parse` sees the text and the preflight is a
 *    one-off with a progress indicator; if it ever needs to be cheaper, the
 *    lever is scanning only until the depth ceiling can no longer be reached,
 *    not removing it.
 */

import type { FileIssueReason } from './types';

/**
 * In-memory JSON ceiling, **equal to** the Rust `limits.rs` `MAX_JSON_BYTES`
 * (12 MiB). `jsonSafety.test.ts` reads the Rust constant and asserts parity.
 *
 * This side may become STRICTER than Rust, never looser — but note that
 * lowering it is an Instagram **identity-contract change**, not a tuning
 * decision: see `sourceItemId.ts`.
 */
export const MAX_JSON_BYTES = 12 * 1024 * 1024;

/**
 * Maximum nesting accepted before `JSON.parse` is attempted.
 *
 * Meta's deepest observed shape is `data[] → attachments[] → data[] → media →
 * media_metadata → photo_metadata`, nowhere near this. 32 is a wide margin
 * over the schema and a long way under Hermes's own 510.
 */
export const MAX_JSON_DEPTH = 32;

/**
 * Per-post media ceiling. A post claiming more than this is `malformed_post`:
 * the largest real FB album in the samples is well under it, and the number
 * bounds both the uri batch and the id framing.
 */
export const MAX_MEDIA_PER_POST = 50;

/**
 * Per-file post ceiling. A 12 MiB file cannot legitimately hold more (IG's
 * `posts.json` hits the byte cap near ~1,300 posts); beyond this the file is
 * not a Meta export shape we recognise.
 *
 * The RUN-wide caps (`MAX_POSTS_PER_RUN`, `MAX_POST_JSON_FILES`,
 * `MAX_MEDIA_URIS_PER_FILE`, `MAX_PEEKS_PER_RUN`) belong to the orchestration
 * and land with `parseArchive`/`mediaPrePass` in PR 2.
 */
export const MAX_POSTS_PER_FILE = 20_000;

/**
 * Keys dropped at revive time.
 *
 * Two groups, one mechanism:
 *
 *  - **`__proto__`, `constructor`, `prototype`** — prototype-pollution
 *    hygiene. `JSON.parse` defines rather than assigns, so this is defence in
 *    depth, and it costs one `Set.has` per key.
 *  - **the sensitive subtrees** — EXIF and camera metadata (which carry GPS),
 *    places and coordinates, user tags, media variants, dubbing info,
 *    cross-post sources and AI sticker provenance. None of them is read by any
 *    parser. Dropping them HERE rather than in the schema pick means no object
 *    downstream of this function has ever held a coordinate, so there is
 *    nothing for a log line, a crash report or a future careless serialisation
 *    to leak. It does NOT save memory — see the bench in the
 *    module header, which measured the opposite — and the tests assert the
 *    absence, not the allocation.
 *
 * This Set is the one sanctioned place in the import where these names appear
 * (PR 2's `noExifLeak` test greps for them everywhere else).
 *
 * Array ELEMENTS are never pruned: the denylist holds property names, and an
 * array element's key is its numeric index, so a prune can never punch a hole
 * in an array. Dropping an element would also renumber nothing — `JSON.parse`
 * leaves `undefined` in place — which is precisely why it is not done.
 */
const PRUNED_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'media_metadata',
  'exif_data',
  'camera_metadata',
  'tags',
  'place',
  'coordinate',
  'dubbing_info',
  'media_variants',
  'cross_post_source',
  'ai_stickers',
]);

/**
 * `JSON.parse` reviver: drop every `PRUNED_KEYS` property as it is revived.
 *
 * Exported so the test can exercise it directly, and so PR 2's parsers are
 * physically unable to parse a Meta file without it — `parseJsonSafely` is the
 * only parse entry point in the import.
 */
export function pruningReviver(key: string, value: unknown): unknown {
  if (PRUNED_KEYS.has(key)) return undefined;
  return value;
}

/**
 * Whether `text` nests no deeper than `maxDepth`.
 *
 * ITERATIVE and string-aware: a recursive scanner would blow the JS stack on
 * the very input it exists to refuse, and a naive bracket count would be
 * defeated by `{"post": "[[[[["}` (benign) or satisfied by `"{"` repeated
 * (nothing at all). Escapes are honoured, so `"\\"` closes its string and
 * `"\""` does not.
 *
 * This is NOT a validator — it says nothing about whether the brackets match
 * or the text is JSON at all. `JSON.parse` decides that.
 */
export function scanJsonDepth(text: string, maxDepth: number = MAX_JSON_DEPTH): boolean {
  const state = newDepthScanState();
  for (let at = 0; at < text.length; at += DEPTH_SCAN_SLICE_CHARS) {
    if (!scanSlice(text, at, Math.min(at + DEPTH_SCAN_SLICE_CHARS, text.length), maxDepth, state)) {
      return false;
    }
  }
  return true;
}

/**
 * The same scan, in slices, with a turn of the event loop between them.
 *
 * The bench in this module's header measured the scan at ~0.66 s per 12 MiB
 * file — the single most expensive stage, and as one `for` loop it was 0.66 s
 * during which an `AbortSignal` could not be observed and the UI could not
 * paint. A member who taps Cancel waits out the current FILE before anything
 * notices. Sliced at 256 KiB that is ~14 ms of uninterrupted work (~48 slices
 * for a 12 MiB file), which is one frame.
 *
 * `checkpoint` is called between slices and may THROW to stop the scan; this
 * module does not know what cancellation means to its caller, and inventing an
 * error code here would put an archive-reader concept inside a pure JSON
 * helper. `parseArchive` passes its own abort check, so a cancelled parse
 * still comes out as `ECANCELLED` with the disposition #926 dispatches on.
 *
 * The state carried across slices is the whole scanner: depth, in-string and
 * escaped. Slicing therefore cannot change the verdict — a slice boundary in
 * the middle of a string or right after a backslash resumes exactly where it
 * left off, which is what the sync variant above shares this code to prove.
 */
export async function scanJsonDepthChunked(
  text: string,
  maxDepth: number = MAX_JSON_DEPTH,
  options: DepthScanOptions = {},
): Promise<boolean> {
  const state = newDepthScanState();
  for (let at = 0; at < text.length; at += DEPTH_SCAN_SLICE_CHARS) {
    if (at > 0) {
      options.checkpoint?.();
      await yieldToEventLoop();
    }
    if (!scanSlice(text, at, Math.min(at + DEPTH_SCAN_SLICE_CHARS, text.length), maxDepth, state)) {
      return false;
    }
  }
  return true;
}

/** Characters scanned between two yields. ~14 ms of Hermes at the bench rate. */
export const DEPTH_SCAN_SLICE_CHARS = 256 * 1024;

export interface DepthScanOptions {
  /**
   * Called between slices, BEFORE the yield. Throwing from it abandons the
   * scan — which is how a caller's `AbortSignal` reaches this loop without
   * this module importing one.
   */
  readonly checkpoint?: () => void;
}

/** Everything the scanner remembers across a slice boundary. */
interface DepthScanState {
  depth: number;
  inString: boolean;
  escaped: boolean;
}

function newDepthScanState(): DepthScanState {
  return { depth: 0, inString: false, escaped: false };
}

/** One slice, `[from, to)`. `false` means the depth ceiling was passed. */
function scanSlice(
  text: string,
  from: number,
  to: number,
  maxDepth: number,
  state: DepthScanState,
): boolean {
  for (let i = from; i < to; i++) {
    const code = text.charCodeAt(i);

    if (state.inString) {
      if (state.escaped) {
        state.escaped = false;
      } else if (code === 0x5c /* \ */) {
        state.escaped = true;
      } else if (code === 0x22 /* " */) {
        state.inString = false;
      }
      continue;
    }

    if (code === 0x22 /* " */) {
      state.inString = true;
    } else if (code === 0x7b /* { */ || code === 0x5b /* [ */) {
      state.depth++;
      if (state.depth > maxDepth) return false;
    } else if (code === 0x7d /* } */ || code === 0x5d /* ] */) {
      // Clamped at zero: an unbalanced closer is `JSON.parse`'s business, and
      // letting depth go negative would let `}}}}{{{{` hide real nesting.
      if (state.depth > 0) state.depth--;
    }
  }

  return true;
}

/**
 * Give the JS thread a turn.
 *
 * `setTimeout(0)`, not a resolved promise: a microtask does not let the UI
 * run, and letting the UI run is the entire point of slicing the scan.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

export type JsonParseOutcome =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly reason: Extract<FileIssueReason, 'json_too_deep' | 'json_unparseable'>;
    };

export interface ParseJsonOptions {
  /**
   * The caller has ALREADY depth-scanned this exact text at this exact
   * `maxDepth` and it passed — skip the scan.
   *
   * Set by `parseArchive` and nobody else. It runs `scanJsonDepthChunked` over
   * each file as it reads it (so the scan is abortable), and scanning again
   * here would double the run's single most expensive stage: ~0.66 s per
   * 12 MiB file, ~7 s on a ten-file run, for a verdict already in hand. A
   * caller that sets this without scanning disables the defence, which is why
   * exactly one does, and why `parseArchive`'s own end-to-end test asserts a
   * too-deep file still becomes a `json_too_deep` file issue.
   */
  readonly depthScanned?: boolean;
}

/**
 * Depth-scan, then parse with the pruning reviver. Never throws.
 *
 * The `catch` is deliberately untyped and catches ANY thrown value, not just
 * `Error`: Hermes's own nesting limit surfaces as a `RangeError`, an
 * out-of-memory may surface as something else entirely, and a `throw 'x'` from
 * a future reviver must not escape as an unhandled rejection in the middle of
 * an import run.
 *
 * Nothing about the input is reported — the outcome is a code. The text is the
 * member's own content (F18).
 */
export function parseJsonSafely(
  text: string,
  maxDepth: number = MAX_JSON_DEPTH,
  options: ParseJsonOptions = {},
): JsonParseOutcome {
  if (options.depthScanned !== true && !scanJsonDepth(text, maxDepth)) {
    return { ok: false, reason: 'json_too_deep' };
  }
  try {
    return { ok: true, value: JSON.parse(text, pruningReviver) as unknown };
  } catch {
    return { ok: false, reason: 'json_unparseable' };
  }
}

// ---------------------------------------------------------------------------
// Schema pick
// ---------------------------------------------------------------------------
//
// The parsers project the parsed graph through these, never by casting it to
// an interface. A cast is a promise about an attacker's file; these are
// checks. Each returns `null` for "not the shape I asked for", so a malformed
// value is a skip reason rather than a `TypeError` three frames later.

/** A plain JSON object, or `null`. Arrays are NOT objects here. */
export function pickObject(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

export function pickArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

export function pickString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A SAFE integer. `1.5`, `NaN`, `1e308 * 10` and `"12"` are all `null`, and so
 * are `1e21` and `2 ** 60`.
 *
 * `Number.isSafeInteger` rather than `Number.isInteger` because every integer
 * this import reads is a timestamp in seconds, and an unsafe one is not a
 * timestamp — it is a number that cannot even round-trip through arithmetic.
 * `1e21` passes `Number.isInteger`, survives `× 1000` as `1e24`, and is the
 * kind of value that reaches `new Date(...).toISOString()` as a `RangeError`
 * several layers from here. Refusing it at the pick is one rule instead of a
 * bounds check at every call site.
 */
export function pickInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/**
 * Read one OWN property of a parsed object.
 *
 * `Object.prototype.hasOwnProperty.call` rather than `key in obj` or a plain
 * read, so a file cannot answer a schema question with something inherited
 * (`toString`, `valueOf`) that it never actually contained.
 */
export function pickField(value: unknown, key: string): unknown {
  const object = pickObject(value);
  if (object === null) return undefined;
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}
