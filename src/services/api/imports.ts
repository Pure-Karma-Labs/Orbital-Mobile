/**
 * Meta import API (#926) — the five JSON routes of B#315/B#317/B#318.
 *
 * The two media routes live in `./media.ts` beside the ordinary chunked
 * upload they share a transport with.
 *
 * ## Flag gate
 *
 * All seven import routes are gated by `importsEnabled` BEFORE `authenticate`
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
  ImportSessionResponse,
  StartImportRequest,
  StartImportResponse,
} from '../../types/api';

/**
 * POST /api/groups/:groupId/imports — open a session.
 *
 * Both declared values are REQUIRED and reserve against the orbit's quota.
 * 409 `IMPORT_REFUSED` with `IMPORT_IN_PROGRESS` (one open session per member
 * per orbit), `IMPORT_ALLOWANCE_EXCEEDED` or `IMPORT_QUOTA_EXCEEDED` — all
 * thrown inside the transaction, so a refusal creates NO session.
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
 * Read-only: the lifetime allowance, the caller's open session if any, and the
 * server's advertised limits. This is also the availability probe (see the
 * flag-gate note above).
 */
export function getGroupImports(groupId: string): Promise<GroupImportsResponse> {
  return request<GroupImportsResponse>({
    method: 'GET',
    path: `/api/groups/${encodeURIComponent(groupId)}/imports`,
    retryOn429: false,
  });
}

/**
 * GET /api/imports/:importId — one session, in any status.
 *
 * Owner-only; a session belonging to another user is a 404, not a 403.
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
    retryOn429: false,
  });
}
