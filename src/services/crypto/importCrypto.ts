/**
 * Meta-import crypto (#924): `K_import`, the per-post `import_key`, the sealed
 * import-meta envelope, and the group-key pin the whole run hangs from.
 *
 * ## The derivation, and where it is pinned
 *
 * ```
 * K_import   = hkdfSha256(group_key, "orbital-meta-import-v1", lowercase(userId), 32)
 * import_key = hmacSha256(K_import, utf8(source) ‖ 0x00 ‖ sourceItemId)[0..16]
 * ```
 *
 * Both primitives are the Rust uniffi exports from #917 — there is no HKDF or
 * HMAC in TypeScript anywhere in this app, and security invariant 30
 * (`import-kdf-call-sites`) exists to keep it that way: `hkdfSha256` and
 * `hmacSha256` may appear in THIS file and nowhere else outside the generated
 * bindings. The cross-layer contract is pinned three times over:
 *
 *  - `packages/orbital-signal/rust/orbital_signal/tests/kdf_kat_tests.rs` —
 *    `orbital_import_kat` (the end-to-end fixture) and
 *    `orbital_import_v1_frame_kat` (the same derivation over a real #925
 *    frame). **That file's `orbital_import_kat` doc comment is the single home
 *    of the framing-ownership sentence and of the `src/kdf.rs` fold-forward
 *    text**; nothing here restates it.
 *  - `tools/generate_kdf_kat_vectors.py` mints those vectors from stdlib
 *    Python and self-checks its own v1 framer against the TypeScript goldens in
 *    `src/services/metaImport/__tests__/sourceItemId.test.ts`.
 *  - `__tests__/importCrypto.kat.test.ts` asserts the same literals from this
 *    side, through the REAL `buildSourceItemId`.
 *
 * `sourceItemId` is opaque here. #925 owns what is inside it.
 *
 * ## Rotation ⇄ dedup coupling
 *
 * `K_import` is derived from the orbit's group key, so rotating that key
 * changes every `import_key`. The consequences (a re-import would duplicate a
 * member's entire history, and nothing can be re-derived because only the
 * 16-byte MAC is stored) are written out in
 * `packages/orbital-signal/rust/orbital_signal/src/kdf.rs:41-54`. That is why a
 * session PINS the key it opened under and {@link ImportKeySession.verifyGroupKeyPin}
 * aborts the run on a change rather than carrying on under a new one.
 *
 * ## Why this module imports no service
 *
 * It must not import `conversationService` — not because of a cycle (there is
 * none today: `conversationService` deep-imports `./crypto/*`, and the crypto
 * barrel has no importers) but because this file sits inside the crypto
 * ESLint fence, which bans Sentry and every telemetry facade. Importing a
 * service module would pull the whole service graph through that fence as a
 * transitive dependency, and a telemetry import added to any node of it would
 * go unflagged. `fulfillPendingWraps()` is therefore #926's call, made before
 * `openImportKeySession`, from outside the fence.
 *
 * For the same reason this module is deliberately **not** added to
 * `src/services/crypto/index.ts`: nothing imports that barrel, and a barrel
 * entry would be a second, unfenced path to these exports.
 *
 * ## Yield cadence and fake timers
 *
 * `deriveImportKey` is a synchronous JSI call wearing an async signature. It
 * yields a macrotask every {@link DERIVE_YIELD_EVERY} derivations so a
 * thousand-post parse cannot hold the JS thread. A test driving a parse under
 * `jest.useFakeTimers()` must pass `yieldEvery: 0`, or the `setTimeout` will
 * never fire and the parse will hang.
 *
 * ## Removal trigger
 *
 * {@link openImportMeta} and {@link parseImportMetaPlaintext} have no
 * production caller until #927. If #927 closes unmerged, delete them and their
 * tests.
 */

import { hkdfSha256, hmacSha256 } from 'orbital-signal';
import type { ArchiveErrorDisposition } from '../metaImport/archiveAccess';
import type { ImportSource } from '../metaImport/types';
import { useAppStore } from '../../stores/useAppStore';
import { encodeUtf8Strict } from '../../utils/utf8';
import {
  compareGroupKeyPin,
  decryptContent,
  encryptContent,
  getOrFetchGroupKey,
  PendingWrapError,
} from './contentCrypto';
import { GroupKeyUnwrapError } from './groupKeyErrors';
import { arrayBufferToBase64, bytesEqual, toArrayBuffer } from './utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * HKDF `salt`, i.e. the protocol version string. Bumping it re-derives every
 * `import_key` and is therefore a full re-import for every member — the same
 * blast radius as a group-key rotation. Spelled EXACTLY ONCE in non-test
 * sources; invariant 30.3 checks that.
 */
const IMPORT_SALT = 'orbital-meta-import-v1';

/**
 * HMAC input for the session fingerprint. A different domain string from the
 * HKDF salt on purpose: the fingerprint is published (it rides in an
 * `import_jobs` row, #921) and must not be a prefix of anything derived under
 * the same key for another purpose.
 */
const FINGERPRINT_INFO = 'orbital-import-fingerprint-v1';

/** Bytes of the fingerprint kept. 64 bits of change detection, not a secret. */
const FINGERPRINT_BYTES = 8;

/** `import_key` width — the backend's `threads_import_key_len` CHECK. */
const IMPORT_KEY_BYTES = 16;

/** Group keys are AES-256. A different length means something is very wrong. */
const GROUP_KEY_BYTES = 32;

/** Derivations between macrotask yields. See the yield-cadence note above. */
export const DERIVE_YIELD_EVERY = 32;

/**
 * Caps on the sealed import-meta envelope, asserted at seal time so an oversize
 * value is caught here rather than by a server 400 mid-run. The plaintext is
 * three fixed-shape fields, so the real ciphertext is ~120 base64 chars; these
 * are headroom, not a tight fit.
 */
const MAX_IMPORT_META_B64 = 1024;
const MAX_IMPORT_META_IV_B64 = 64;

/**
 * The canonical lowercase hyphenated UUIDv4, which is what the server issues
 * and what `info` must be. Version and variant nibbles are checked, not just
 * the shape: a non-v4 id would mean the store is holding something that is not
 * a user id at all. Matching is case-insensitive because the store keeps the
 * server's string verbatim; the value is lowercased before use rather than
 * rejected.
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The sealed per-thread import metadata. `v` bumps on any shape change. */
export interface ImportMetaV1 {
  readonly v: 1;
  readonly source: ImportSource;
  /**
   * Epoch milliseconds UTC — the POST's date.
   *
   * Deliberately a different fact from `UploadMediaOptions.importOriginalCreatedAt`,
   * which is one media item's own date. #927's precedence: a media item's date
   * wins, and it falls back to this one.
   */
  readonly originalCreatedAt: number;
}

export interface ImportKeySessionOptions {
  readonly groupId: string;
  readonly source: ImportSource;
  /** Derivations between yields. `0` disables yielding (fake timers). */
  readonly yieldEvery?: number;
}

export interface ImportKeySession {
  /**
   * Base64 of `hmacSha256(K_import, FINGERPRINT_INFO)[0..8]`.
   *
   * #921 stores it on the job row; #926 compares it on resume and aborts the
   * job when it has changed, which is the resumable-run counterpart of
   * {@link ImportKeySession.verifyGroupKeyPin}. Not a secret: it is a MAC of a
   * fixed public string, and 8 bytes of it.
   */
  readonly keyFingerprint: string;
  /** 16 bytes, a fresh copy per call. Never a view over the 32-byte tag. */
  deriveImportKey(sourceItemId: Uint8Array): Promise<Uint8Array>;
  /** Verifies the pin, then seals under the LIVE key. Epoch ms. */
  sealImportMeta(
    originalCreatedAt: number,
  ): Promise<{ encryptedImportMeta: string; importMetaIv: string }>;
  /** Resolves when the group key is unchanged; throws otherwise. */
  verifyGroupKeyPin(): Promise<void>;
  /** Zero-fills and unregisters. Idempotent; later method calls throw. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The group key changed under a running import. Terminal for the run. */
export class ImportKeyChangedError extends Error {
  constructor() {
    super('Group key changed during import');
    this.name = 'ImportKeyChangedError';
  }
}

/** A method was called after `close()`. A caller bug; terminal for the run. */
export class ImportKeySessionClosedError extends Error {
  constructor() {
    super('Import key session is closed');
    this.name = 'ImportKeySessionClosedError';
  }
}

/** The store's userId is missing, malformed, or not UTF-8-encodable. */
export class ImportUserIdError extends Error {
  constructor(reason: string) {
    super(`Cannot derive import key: ${reason}`);
    this.name = 'ImportUserIdError';
  }
}

/**
 * An import-meta envelope failed to authenticate, or was not decodable at all.
 *
 * A tamper signal, never `null`: the group key opened everything else in the
 * thread, so a GCM tag failure here means these bytes are not what this device
 * wrote. `null` from {@link openImportMeta} is reserved for ciphertext that
 * DID authenticate and simply is not a v1 envelope.
 */
export class ImportMetaAuthError extends Error {
  constructor() {
    super('Import metadata failed authentication');
    this.name = 'ImportMetaAuthError';
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The wire form of an `import_key`: standard padded base64 (RFC 4648 §4) of
 * exactly 16 bytes, which is what the backend's `IMPORT_KEY_B64_RE` accepts.
 * NOT base64url.
 *
 * Module-level and pure, so #926 can encode a key it loaded from #921's table
 * without holding a live session.
 */
export function importKeyToWire(importKey: Uint8Array): string {
  if (importKey.length !== IMPORT_KEY_BYTES) {
    throw new Error(
      `import_key must be exactly ${IMPORT_KEY_BYTES} bytes, got ${importKey.length}`,
    );
  }
  return arrayBufferToBase64(toArrayBuffer(importKey));
}

/**
 * Parse an import-meta plaintext, or `null` if it is not a v1 envelope.
 *
 * Tolerant about unknown keys (a later version may add fields) and strict
 * about the three it reads: a wrong `v`, a non-object, a missing field, a
 * `source` outside the two literals, or a non-safe-integer date all give
 * `null`. Exported for #927, which may hold the plaintext already.
 */
export function parseImportMetaPlaintext(json: string): ImportMetaV1 | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (record.v !== 1) return null;

  const source = record.source;
  if (source !== 'facebook' && source !== 'instagram') return null;

  const originalCreatedAt = record.originalCreatedAt;
  if (typeof originalCreatedAt !== 'number' || !Number.isSafeInteger(originalCreatedAt)) {
    return null;
  }

  return { v: 1, source, originalCreatedAt };
}

/**
 * The run disposition for a crypto error, in the vocabulary #926 already
 * switches on, or `null` for "not a crypto verdict — fall through to the
 * HTTP/network taxonomy".
 *
 * A pending or unopenable group key is `'retryable-pause'` and never a
 * permanent item failure: the wrap may still arrive. Everything this module
 * raises itself is `'terminal-for-run'` — a changed key, a closed session and
 * a bad userId are all conditions no retry can clear, and an import-meta
 * authentication failure on the WRITE path means the envelope we just produced
 * did not round-trip. #927 decides its own read-path handling of that error.
 */
export function classifyImportCryptoError(e: unknown): ArchiveErrorDisposition | null {
  if (e instanceof PendingWrapError || e instanceof GroupKeyUnwrapError) {
    return 'retryable-pause';
  }
  if (
    e instanceof ImportKeyChangedError ||
    e instanceof ImportKeySessionClosedError ||
    e instanceof ImportUserIdError ||
    e instanceof ImportMetaAuthError
  ) {
    return 'terminal-for-run';
  }
  return null;
}

/**
 * Strict UTF-8, refusing an empty result and any embedded NUL.
 *
 * Both refusals matter for the HMAC framing: `source ‖ 0x00 ‖ sourceItemId` is
 * unambiguous only while `source` is NUL-free and non-empty, and an empty
 * encode is the `encodeUTF8`-truncation bug class (#373) the Rust export also
 * refuses.
 */
function encodeFramingAscii(value: string, label: string): Uint8Array {
  const bytes = encodeUtf8Strict(value);
  if (bytes === null || bytes.length === 0) {
    throw new Error(`importCrypto: ${label} is not encodable as UTF-8`);
  }
  if (bytes.indexOf(0x00) !== -1) {
    throw new Error(`importCrypto: ${label} must not contain a NUL byte`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

/**
 * Close callbacks of every open session — CALLBACKS ONLY, never key material,
 * so this set holds nothing a wipe would have to reach into.
 *
 * The safety net for the case where an import is running when the account is
 * wiped: #926 owns aborting its own run (its reset is wired into `localWipe`
 * next to `resetBulkExportState`), and this is the belt that catches a session
 * whose owner never got to its `finally`.
 */
const openSessions = new Set<() => void>();

/**
 * Close every open import-key session, zeroing `K_import` and the pinned group
 * key. Wired into `authService.localWipe` (next to `clearGroupKeyCache`) and
 * `keyGenerationService.fullCryptoWipe`.
 *
 * Synchronous and best-effort per session: one session's failure must not
 * leave the others holding key bytes through a wipe.
 */
export function closeAllImportKeySessions(): void {
  for (const close of [...openSessions]) {
    try {
      close();
    } catch {
      // A close that throws has still been unregistered by its own guard;
      // keep going so one bad session cannot strand the others' key bytes.
      openSessions.delete(close);
    }
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Open a session: resolve the member's id, pin the orbit's group key, derive
 * `K_import` once, and keep it until {@link ImportKeySession.close}.
 *
 * Throws {@link ImportUserIdError} for a store without a usable userId, and
 * propagates `PendingWrapError` / `GroupKeyUnwrapError` from the group-key
 * fetch — both classify as `'retryable-pause'`, so failing to open is never a
 * permanent failure of the import.
 *
 * #926 must call `close()` in a `finally`.
 */
export async function openImportKeySession(
  options: ImportKeySessionOptions,
): Promise<ImportKeySession> {
  const { groupId, source } = options;
  const yieldEvery = options.yieldEvery ?? DERIVE_YIELD_EVERY;

  // 1. The member's id, which is the ONLY per-member input to K_import and
  //    therefore the whole of the backend's cross-member unlinkability.
  const userId = useAppStore.getState().userId;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new ImportUserIdError('no authenticated user');
  }
  if (!UUID_V4_RE.test(userId)) {
    throw new ImportUserIdError('userId is not a UUIDv4');
  }
  // Convert, don't reject: the store holds the server's string verbatim, and
  // the derivation is specified over the lowercase form.
  const canonicalUserId = userId.toLowerCase();
  const infoBytes = encodeUtf8Strict(canonicalUserId);
  if (infoBytes === null || infoBytes.length === 0) {
    throw new ImportUserIdError('userId is not encodable as UTF-8');
  }

  // 2. The source bytes, asserted before any key material exists so a bad
  //    value cannot reach the derivation at all.
  if (source !== 'facebook' && source !== 'instagram') {
    throw new Error(`importCrypto: unknown import source ${JSON.stringify(source)}`);
  }
  const sourceBytes = encodeFramingAscii(source, 'source');

  // 3. The group key, and the PIN. The copy is mandatory: the cache's array is
  //    `.fill(0)`'d in place by `invalidateGroupKey` / `clearGroupKeyCache`, so
  //    a pin that aliased it would zero itself mid-run and every later
  //    comparison would see a key of 32 zeros. `pinned` lives until close().
  const live = await getOrFetchGroupKey(groupId);
  if (live.length !== GROUP_KEY_BYTES) {
    throw new Error(
      `importCrypto: group key must be ${GROUP_KEY_BYTES} bytes, got ${live.length}`,
    );
  }
  const pinned = live.slice();

  // 4. K_import, derived once for the whole run. `ikmBuf` is its own copy of
  //    the pin (toArrayBuffer slices), so zeroing it after the derivation
  //    wipes the ikm the FFI lifted from without touching `pinned`.
  const ikmBuf = toArrayBuffer(pinned);
  let kImportBuf: ArrayBuffer;
  try {
    kImportBuf = hkdfSha256(
      ikmBuf,
      toArrayBuffer(encodeFramingAscii(IMPORT_SALT, 'salt')),
      toArrayBuffer(infoBytes),
      32,
    );
  } finally {
    new Uint8Array(ikmBuf).fill(0);
  }

  const fingerprintTag = new Uint8Array(
    hmacSha256(kImportBuf, toArrayBuffer(encodeFramingAscii(FINGERPRINT_INFO, 'fingerprint info'))),
  );
  const keyFingerprint = arrayBufferToBase64(
    toArrayBuffer(fingerprintTag.slice(0, FINGERPRINT_BYTES)),
  );

  let closed = false;
  let derivations = 0;

  function assertOpen(): void {
    if (closed) throw new ImportKeySessionClosedError();
  }

  function close(): void {
    if (closed) {
      // Still unregister: a double close must leave nothing behind for
      // closeAllImportKeySessions() to walk.
      openSessions.delete(close);
      return;
    }
    closed = true;
    new Uint8Array(kImportBuf).fill(0);
    pinned.fill(0);
    openSessions.delete(close);
  }

  async function verifyGroupKeyPin(): Promise<void> {
    assertOpen();
    const verdict = compareGroupKeyPin(groupId, pinned);
    if (verdict === 'match') return;
    if (verdict === 'changed') throw new ImportKeyChangedError();

    // 'absent': neither tier can answer — the cache was cleared and the row is
    // gone, which is what a `decryptWithRetry` invalidate-then-refetch looks
    // like from here. Join that refetch rather than returning no verdict. A
    // pending or unwrap failure propagates and classifies as 'retryable-pause',
    // which is the right answer for "can't tell yet".
    const refetched = await getOrFetchGroupKey(groupId);
    if (!bytesEqual(refetched, pinned)) throw new ImportKeyChangedError();
  }

  async function deriveImportKey(sourceItemId: Uint8Array): Promise<Uint8Array> {
    assertOpen();
    // Messages here never include item content: `sourceItemId` embeds the post
    // text verbatim (see sourceItemId.ts), so it must not reach an Error.
    if (sourceItemId.length === 0) {
      throw new Error('importCrypto: sourceItemId must not be empty');
    }

    const framed = new Uint8Array(sourceBytes.length + 1 + sourceItemId.length);
    framed.set(sourceBytes, 0);
    framed[sourceBytes.length] = 0x00;
    framed.set(sourceItemId, sourceBytes.length + 1);

    const tag = new Uint8Array(hmacSha256(kImportBuf, toArrayBuffer(framed)));

    derivations += 1;
    if (yieldEvery > 0 && derivations % yieldEvery === 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }

    // A COPY, with a 16-byte backing buffer of its own: `tag.slice(0, 16)`
    // alone would keep the 32-byte tag alive behind it, and the second half of
    // that tag is unpublished key-derived material.
    return new Uint8Array(tag.slice(0, IMPORT_KEY_BYTES));
  }

  async function sealImportMeta(
    originalCreatedAt: number,
  ): Promise<{ encryptedImportMeta: string; importMetaIv: string }> {
    assertOpen();
    if (!Number.isSafeInteger(originalCreatedAt)) {
      throw new Error('importCrypto: originalCreatedAt must be a safe integer (epoch ms)');
    }

    // Verify FIRST, then seal with the live key. The two are identical by
    // construction once the pin verifies, and sealing with the live bytes is
    // what makes it impossible to seal import-meta under a key the rest of the
    // import is not using.
    await verifyGroupKeyPin();
    const liveKey = await getOrFetchGroupKey(groupId);

    // Fixed key order, so the plaintext is a function of the values alone.
    const plaintext = JSON.stringify({ v: 1, source, originalCreatedAt });
    const { ciphertext, iv } = encryptContent(plaintext, liveKey, groupId);

    // Base64 is ASCII, so character count IS the UTF-8 byte count here.
    if (ciphertext.length > MAX_IMPORT_META_B64) {
      throw new Error(
        `importCrypto: sealed import meta is ${ciphertext.length} bytes, over the ${MAX_IMPORT_META_B64} cap`,
      );
    }
    if (iv.length > MAX_IMPORT_META_IV_B64) {
      throw new Error(
        `importCrypto: import meta IV is ${iv.length} bytes, over the ${MAX_IMPORT_META_IV_B64} cap`,
      );
    }

    return { encryptedImportMeta: ciphertext, importMetaIv: iv };
  }

  openSessions.add(close);

  return {
    keyFingerprint,
    deriveImportKey,
    sealImportMeta,
    verifyGroupKeyPin,
    close,
  };
}

/**
 * Open a sealed import-meta envelope (#927's read path).
 *
 * Error contract:
 *  - `PendingWrapError` / `GroupKeyUnwrapError` from the group-key fetch
 *    propagate unchanged — the envelope may well be fine, the key just is not
 *    here yet.
 *  - A GCM authentication failure, or base64 that will not decode, throws
 *    {@link ImportMetaAuthError}.
 *  - `null` means the plaintext authenticated but is not a v1 envelope.
 *
 * Needs no session: it derives nothing, and reads only the group key.
 */
export async function openImportMeta(
  encryptedImportMeta: string,
  importMetaIv: string,
  groupId: string,
): Promise<ImportMetaV1 | null> {
  const groupKey = await getOrFetchGroupKey(groupId);

  let plaintext: string;
  try {
    plaintext = decryptContent(encryptedImportMeta, importMetaIv, groupKey, groupId);
  } catch {
    // Deliberately swallowing the cause: an AES-GCM failure reason and a
    // base64 parse error are the same fact to the caller, and neither message
    // may carry ciphertext.
    throw new ImportMetaAuthError();
  }

  return parseImportMetaPlaintext(plaintext);
}
