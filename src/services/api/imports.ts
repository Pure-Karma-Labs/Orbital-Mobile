/**
 * Meta import API (#926) — the six JSON routes of B#315/B#317/B#318 plus the
 * B#337 lookup.
 *
 * The two media routes live in `./media.ts` beside the ordinary chunked
 * upload they share a transport with.
 *
 * ## Flag gate
 *
 * All eight import routes are gated by `importsEnabled` BEFORE `authenticate`
 * (Orbital-Backend `src/routes/imports.js`), so a server with `IMPORTS_ENABLED`
 * off answers 404 with a body byte-identical to an unknown route's.
 * `IMPORTS_ENABLED` is off in production today: a `NotFoundError` from any of
 * these means "imports are not available here", not "that session is gone".
 *
 * ## retryOn429
 *
 * Every call here passes `retryOn429: false`. The import runner (#926) owns
 * the single pause authority, driven by `RateLimitError.retryAfterMs` from the
 * server's own `Retry-After` — a second ladder inside the client would spend
 * the member's remaining quota before the runner ever saw the 429.
 *
 * ## Removal trigger
 *
 * Every function here ships ahead of its only caller, the import runner in
 * `src/services/metaImport/` (PR B of #926). There is no knip or ts-prune in
 * this repo to notice an export with no callers, so: if #926's PR B closes
 * unmerged, delete this module, its entry in `./index.ts`, its tests, and the
 * import types in `src/types/api.ts` — nothing else imports them.
 */

import { request } from './client';
import type {
  CompleteImportResponse,
  GroupImportsResponse,
  ImportBatchRequest,
  ImportBatchResponse,
  ImportLookupRequest,
  ImportLookupResponse,
  ImportSessionResponse,
  StartImportRequest,
  StartImportResponse,
} from '../../types/api';

/**
 * POST /api/groups/:groupId/imports — open a session.
 *
 * All THREE body fields are REQUIRED since B#352. The declared values reserve
 * against the orbit's quota; `source` names the allowance bucket this session
 * spends and binds the session to that platform for its lifetime. An omitted
 * or unknown source is 400 `IMPORT_DECLARED_INVALID` — the server validates it
 * before the service runs, so a bad value never creates an allowance row.
 *
 * 409 `IMPORT_REFUSED` with `IMPORT_IN_PROGRESS` (one open session per member
 * per orbit ACROSS sources — its details carry `{import_id, source}`, or
 * neither on the insert race), `IMPORT_ALLOWANCE_EXCEEDED` (that source's
 * bucket) or `IMPORT_QUOTA_EXCEEDED` (the orbit's, shared) — all thrown
 * inside the transaction, so a refusal creates NO session.
 */
export function startImport(
  groupId: string,
  data: StartImportRequest,
): Promise<StartImportResponse> {
  return request<StartImportResponse>({
    method: 'POST',
    path: `/api/groups/${encodeURIComponent(groupId)}/imports`,
    body: data,
    retryOn429: false,
  });
}

/**
 * GET /api/groups/:groupId/imports — the preflight.
 *
 * Read-only: BOTH sources' lifetime allowances (`allowances`, always both
 * keys, zeros where no row exists), the caller's open session if any — of
 * EITHER source, so read its `source` before adopting it — and the server's
 * advertised limits. There is no flat `allowance` key since B#352.
 *
 * This is also the availability probe (see the flag-gate note above); a
 * response with no `allowances` map is an older server, which the caller
 * treats as unavailable rather than pricing an import it cannot.
 */
export function getGroupImports(groupId: string): Promise<GroupImportsResponse> {
  return request<GroupImportsResponse>({
    method: 'GET',
    path: `/api/groups/${encodeURIComponent(groupId)}/imports`,
    retryOn429: false,
  });
}

/**
 * POST /api/groups/:groupId/imports/lookup — which of these keys are already
 * in this orbit.
 *
 * Read-only and group-scoped: `groupId` comes from the path and the author
 * from the token, never from the body. A caller can only learn about threads
 * THEY authored in an orbit they still belong to.
 *
 * The body goes through the client's camelCase→snake_case transform, so the
 * wire carries `import_keys`. The response carries the matching keys only.
 *
 * Gated on `limits.lookupMax`: a server without the route omits it, and the
 * caller must then not call this at all — the route would answer the
 * flag-gate 404 (indistinguishable from an unknown route).
 *
 * `signal` is threaded through because the only caller runs this at PARSE
 * time, where the member's Cancel must abort the request in flight.
 */
export function lookupImportKeys(
  groupId: string,
  data: ImportLookupRequest,
  signal?: AbortSignal,
): Promise<ImportLookupResponse> {
  return request<ImportLookupResponse>({
    method: 'POST',
    path: `/api/groups/${encodeURIComponent(groupId)}/imports/lookup`,
    body: data,
    signal,
    retryOn429: false,
  });
}

/**
 * GET /api/imports/:importId — one session, in any status.
 *
 * Owner-only; a session belonging to another user is a 404, not a 403. Its
 * `source` is the session's own, and `allowance` is that source's bucket — a
 * session of the other source is still the caller's, so the id alone does not
 * make it adoptable.
 */
export function getImportSession(importId: string): Promise<ImportSessionResponse> {
  return request<ImportSessionResponse>({
    method: 'GET',
    path: `/api/imports/${encodeURIComponent(importId)}`,
    retryOn429: false,
  });
}

/**
 * POST /api/imports/:importId/threads — submit a batch.
 *
 * `results` comes back dense and index-aligned with `items`: a malformed item
 * is `rejected` INSIDE the 200 and never fails the request. Only the envelope
 * can: an empty or over-size `items` is a 400 (`IMPORT_BATCH_TOO_LARGE`), and
 * a body over the app-wide 10 MB JSON limit is a bare 413 — both mean halve
 * the batch, neither is a per-item verdict.
 *
 * The body goes through the client's camelCase→snake_case transform, so the
 * wire carries `import_key`, `original_created_at`, `encrypted_title`, … as
 * the backend's item validator expects.
 */
export function submitImportBatch(
  importId: string,
  data: ImportBatchRequest,
): Promise<ImportBatchResponse> {
  return request<ImportBatchResponse>({
    method: 'POST',
    path: `/api/imports/${encodeURIComponent(importId)}/threads`,
    body: data,
    retryOn429: false,
  });
}

/**
 * POST /api/imports/:importId/complete — finish the session.
 *
 * Idempotent: a second complete of a completed session is a 200 that fires no
 * broadcast. A `closed` or `abandoned` session is 409 `IMPORT_CLOSED`.
 */
export function completeImport(importId: string): Promise<CompleteImportResponse> {
  return request<CompleteImportResponse>({
    method: 'POST',
    path: `/api/imports/${encodeURIComponent(importId)}/complete`,
    // Explicit empty body, the project convention for a bodyless POST (the
    // ToS-accept route does the same): a POST with no Content-Length at all
    // is the shape Cloudflare and some proxies are least consistent about
    // forwarding, and the route reads no body either way.
    body: {},
    retryOn429: false,
  });
}
