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
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (code === 0x5c /* \ */) {
        escaped = true;
      } else if (code === 0x22 /* " */) {
        inString = false;
      }
      continue;
    }

    if (code === 0x22 /* " */) {
      inString = true;
    } else if (code === 0x7b /* { */ || code === 0x5b /* [ */) {
      depth++;
      if (depth > maxDepth) return false;
    } else if (code === 0x7d /* } */ || code === 0x5d /* ] */) {
      // Clamped at zero: an unbalanced closer is `JSON.parse`'s business, and
      // letting depth go negative would let `}}}}{{{{` hide real nesting.
      if (depth > 0) depth--;
    }
  }

  return true;
}

export type JsonParseOutcome =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly reason: Extract<FileIssueReason, 'json_too_deep' | 'json_unparseable'>;
    };

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
export function parseJsonSafely(text: string, maxDepth: number = MAX_JSON_DEPTH): JsonParseOutcome {
  if (!scanJsonDepth(text, maxDepth)) return { ok: false, reason: 'json_too_deep' };
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

/** A finite integer. `1.5`, `NaN`, `1e308 * 10` and `"12"` are all `null`. */
export function pickInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
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
