/**
 * Post body assembly for the Meta import (#925).
 *
 * One pipeline, in this exact order, because two of the steps are identity
 * decisions rather than cosmetics:
 *
 * ```
 * raw  →  length floor  →  repairMojibake  →  [ID INPUT TAKEN HERE]
 *      →  NFC  →  newline normalise  →  trim  →  append link line
 *      →  code-point cap
 * ```
 *
 *  - **The id input is pre-NFC.** `source_item_id` frames the repaired text
 *    BEFORE normalisation: archive bytes are deterministic, Hermes's
 *    platform-backed `normalize('NFC')` tables are not. See `sourceItemId.ts`.
 *  - **Over-long is a SKIP, never a truncation.** Half of a member's post,
 *    silently, is worse than an honest "this one did not migrate" row in
 *    #928's list.
 */

import { repairMojibake } from './mojibake';

/**
 * Body ceiling in CODE POINTS, matching the app's own composer
 * (`ComposeThreadScreen.tsx:433`, `maxLength={10000}`).
 *
 * The composer's `maxLength` counts UTF-16 units and this counts code points,
 * so an imported body of 10,000 astral characters is 20,000 units — longer
 * than anything the composer can produce. That asymmetry is deliberate: the
 * ceiling exists to refuse pathological posts, and counting code points is the
 * count a member would recognise as "characters".
 */
export const BODY_MAX_CHARS = 10_000;

/**
 * Hard floor on the RAW text, in UTF-16 units, before any work is done.
 *
 * A single JSON string this long is not a Meta post; it is the shape of an
 * attack on the repair and NFC passes, both of which are superlinear in
 * allocation. Above this the post is `malformed_post` and nothing is
 * normalised, repaired or framed.
 */
export const RAW_TEXT_MAX_UNITS = 64_000;

export type AssembledBody =
  | {
      readonly ok: true;
      readonly body: string;
      /** Repaired, PRE-NFC text — the `source_item_id` input. */
      readonly idText: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'malformed_post';
      /** No id: the text never got far enough to be framed. */
      readonly idText: null;
    }
  | {
      readonly ok: false;
      readonly reason: 'text_too_long';
      /**
       * Present even though the post is skipped: #921 persists a skipped
       * item's `import_key`, and that key must be the one this post would
       * always have had.
       */
      readonly idText: string;
    };

export interface AssembleBodyOptions {
  /**
   * The post's text as exported. Facebook's multiple `data[].post` strings are
   * joined with a blank line by the caller BEFORE this call, so the length
   * floor applies to what the member would actually see.
   */
  readonly rawText: string;
  /**
   * An accepted `^https?://` shared link, or `null`.
   *
   * Appended verbatim — not repaired and not NFC-normalised — so that the
   * body's url and the url inside `source_item_id` are byte-for-byte the same
   * string. Meta's urls are percent-encoded ASCII in both local samples.
   */
  readonly linkUrl?: string | null;
  readonly maxChars?: number;
}

/** Count code points, not UTF-16 units: `for…of` iterates code points. */
export function countCodePoints(text: string): number {
  let count = 0;
  for (const _codePoint of text) count++;
  return count;
}

/** `\r\n` and lone `\r` → `\n`. Meta exports contain both. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Run the pipeline above.
 *
 * A post with neither text nor link comes back `ok` with an EMPTY body — it is
 * the caller that knows whether there is media, and therefore whether this is
 * `empty_post`.
 */
export function assembleBody(options: AssembleBodyOptions): AssembledBody {
  const { rawText, linkUrl = null, maxChars = BODY_MAX_CHARS } = options;

  if (rawText.length > RAW_TEXT_MAX_UNITS) {
    return { ok: false, reason: 'malformed_post', idText: null };
  }

  const idText = repairMojibake(rawText);

  let body = normalizeNewlines(idText.normalize('NFC')).trim();
  if (linkUrl !== null && linkUrl.length > 0) {
    // Its own line below the member's words (Alex, 2026-11-12); a link-only
    // post is a body that is just the url.
    body = body.length > 0 ? `${body}\n${linkUrl}` : linkUrl;
  }

  if (countCodePoints(body) > maxChars) {
    return { ok: false, reason: 'text_too_long', idText };
  }

  return { ok: true, body, idText };
}
