---
name: REST API layer — Issue #13
description: Native fetch wrapper at src/services/api/ with 35 endpoints, snake_case↔camelCase auto-transform, typed error hierarchy, pluggable TokenStorage. 12/12 modules have test coverage (106 tests).
type: project
---

API layer lives at `src/services/api/`. No axios — uses native `fetch`.

Key files:
- `client.ts` — core `request<T>()` function: builds URL, injects Authorization header, serializes body to snake_case, applies 15s timeout via AbortController, parses response as camelCase. `API_BASE_URL` is now imported from `src/config/env.ts` (PR #344) and re-exported for backward compatibility
- `errors.ts` — typed error hierarchy: `ApiError` (base) → `NetworkError`, `AuthError`, `ValidationError`, `ServerError`, `NotFoundError`
- `tokenManager.ts` — `TokenManager` class with pluggable `TokenStorage` interface; `onTokensCleared` callback fires 401 store clearAuth
- `index.ts` — barrel re-exporting all domain services
- Domain service files: `auth.ts` (login, signup, verifyToken, getPublicKey, forgotPassword, resetPasswordWithCode), `users.ts`, `groups.ts`, `threads.ts`, `messages.ts`, `media.ts`, `devices.ts`, `invites.ts`, `version.ts`
- `src/types/api.ts` — all request/response DTOs (camelCase) for every endpoint

Important patterns:
- `camelToSnake()` / `snakeToCamel()` recursively transform plain objects and arrays; skip Date, ArrayBuffer, non-plain objects
- 401 triggers `tokenManager.clearTokens()` which fires `onTokensCleared` → `clearAuth()` in store; 403 does NOT clear tokens (authorized but not permitted)
- `rawResponse: true` on `request()` skips JSON parse and returns `ArrayBuffer` — used for binary media downloads
- `FormData` bodies skip `Content-Type` header so fetch sets the multipart boundary automatically
- `AuthError` covers both 401 and 403; check `statusCode` field to distinguish
- `buildQueryString(params)` utility in `client.ts` — converts a plain object to a URL query string, omitting null/undefined values. Used by `threads.ts`, `messages.ts`, and `version.ts` for GET endpoints with optional filters
- Fail-closed auth: if `getAccessToken()` returns null and `skipAuth` is false, `request()` throws `AuthError` immediately (does not attempt the fetch with no token)

**Why:** 401 vs 403 distinction was a bug fix (PR #41 patch) — clearing auth on 403 would log out users who were simply removed from a group. Fail-closed auth prevents accidental unauthenticated requests on token expiry edge cases.

**How to apply:** All API calls go through domain service files. Components never call `request()` directly — they call `authService`, or a domain service, which calls `request()`. Use `buildQueryString()` for any GET endpoint that takes optional query parameters.

**Test coverage:** 12/12 API modules have Jest tests (106 tests total). Test files live alongside their source (e.g., `threads.test.ts` next to `threads.ts`).
