# API Compatibility Report — Orbital Mobile

**Backend:** `https://api.orbitl.org`
**Verification date:** 2026-04-09
**Status:** All 35+ endpoints implemented and verified

---

## Summary

All REST API endpoints defined in the Mobile App Spec (`docs/MOBILE-APP-SPEC.md`) have been implemented in the API service layer under `src/services/api/`. This document records the complete endpoint inventory, auth requirements, mobile-specific adaptations, and known gaps.

---

## Endpoint Inventory

### Authentication (`src/services/api/auth.ts`)

| Method | Path | Auth Required | Notes |
|--------|------|--------------|-------|
| POST | `/api/signup` | No | `skipAuth: true` |
| POST | `/api/login` | No | `skipAuth: true` |
| POST | `/api/verify-token` | Yes | |
| GET | `/api/users/:username/public-key` | No | `skipAuth: true`; used for pre-auth key lookup |

### Groups / Orbits (`src/services/api/groups.ts`)

| Method | Path | Auth Required | Notes |
|--------|------|--------------|-------|
| POST | `/api/groups` | Yes | Create group |
| GET | `/api/groups` | Yes | List all groups for authenticated user |
| POST | `/api/groups/join` | Yes | Join by invite code |
| GET | `/api/groups/:groupId/members` | Yes | URL param encoded |
| GET | `/api/groups/:groupId/key` | Yes | Returns per-member encrypted group key |
| GET | `/api/groups/:groupId/quota` | Yes | Storage quota (bytes) |
| DELETE | `/api/groups/:groupId/members/:userId` | Yes | Both params encoded; no body |
| POST | `/api/groups/dm` | Yes | Create direct message conversation |
| GET | `/api/groups/dms` | Yes | List all DMs |

### Threads (`src/services/api/threads.ts`)

| Method | Path | Auth Required | Notes |
|--------|------|--------------|-------|
| POST | `/api/threads` | Yes | Accepts optional client-generated `id` for offline creation |
| GET | `/api/groups/:groupId/threads` | Yes | Supports `cursor`, `limit`, `sort` query params |
| GET | `/api/threads/:threadId` | Yes | |
| POST | `/api/threads/:threadId/replies` | Yes | Accepts optional client `id`; `parentReplyId: null` for top-level |
| GET | `/api/threads/:threadId/replies` | Yes | Supports `cursor` query param |

### Signal Protocol Relay (`src/services/api/messages.ts`)

| Method | Path | Auth Required | Notes |
|--------|------|--------------|-------|
| POST | `/v1/messages` | Yes | Sends encrypted Signal envelope; envelope content is opaque |
| GET | `/v1/messages` | Yes | Supports `since` (epoch ms) and `limit` query params |
| DELETE | `/v1/messages/:messageId` | Yes | URL param encoded |

### Media (`src/services/api/media.ts`)

| Method | Path | Auth Required | Notes |
|--------|------|--------------|-------|
| POST | `/api/media/upload/chunk` | Yes | FormData body; 60s timeout; optional `AbortSignal` |
| GET | `/api/media/:mediaId/download` | Yes | `rawResponse: true`; returns raw `ArrayBuffer`; 60s timeout; optional `AbortSignal` |

### Users (`src/services/api/users.ts`)

| Method | Path | Auth Required | Notes |
|--------|------|--------------|-------|
| GET | `/api/users/me` | Yes | Returns authenticated user's profile |
| GET | `/api/users/:userId` | Yes | URL param encoded |
| POST | `/api/users/avatar` | Yes | FormData body; 60s timeout |
| DELETE | `/api/users/avatar` | Yes | No body |
| PUT | `/api/users/display-name` | Yes | JSON body `{ displayName }` |

### Invites (`src/services/api/invites.ts`)

| Method | Path | Auth Required | Notes |
|--------|------|--------------|-------|
| POST | `/api/invites/generate` | Yes | Accepts optional `groupId` |
| POST | `/api/invites/generate-link` | Yes | Returns deep link `orbital://invite/CODE` |
| GET | `/api/invites/status/:code` | Yes | URL param encoded |
| GET | `/api/invites/group/:groupId` | Yes | URL param encoded |

### Signal Keys (`src/services/api/keys.ts`)

| Method | Path | Auth Required | Notes |
|--------|------|--------------|-------|
| POST | `/api/keys` | Yes | Upload pre-key bundle (registration + device + identity + signed + prekeys + kyber) |
| GET | `/api/keys/count` | Yes | Returns remaining one-time pre-key count |
| GET | `/api/keys/:userId/bundle` | Yes | Fetch pre-key bundle for session establishment; URL param encoded |

### Devices (`src/services/api/devices.ts`)

| Method | Path | Auth Required | Notes |
|--------|------|--------------|-------|
| POST | `/api/devices/register` | Yes | Registers APNs (iOS) or FCM (Android) push token |

### Version (`src/services/api/version.ts`)

| Method | Path | Auth Required | Notes |
|--------|------|--------------|-------|
| GET | `/api/version/check` | No | `skipAuth: true`; `platform` + `version` as query params |

---

## Response Format

### camelCase Auto-Transform

The API client (`src/services/api/client.ts`) automatically transforms server responses from snake_case to camelCase on receipt, and serialises request bodies from camelCase to snake_case. All type definitions in `src/types/api.ts` use camelCase throughout. Consumers never see raw snake_case keys.

### Pagination

Paginated endpoints return a `PaginatedResponse<T>` with:
- `items: T[]`
- `cursor: string | null` (opaque token for the next page)
- `hasMore: boolean`
- `total?: number` (optional)

Callers pass `cursor` as a query parameter to retrieve subsequent pages.

---

## Mobile-Specific Adaptations

### FormData for Uploads

`uploadAvatar` and `uploadChunk` use `FormData` bodies rather than JSON. The API client detects `FormData` and omits the `Content-Type: application/json` header, letting the browser/RN networking layer set the correct multipart boundary.

### 60-Second Timeout for Large Payloads

The following endpoints use `timeout: 60_000` to accommodate large payloads over mobile networks:
- `POST /api/users/avatar` — profile image upload
- `POST /api/media/upload/chunk` — encrypted media chunk upload
- `GET /api/media/:mediaId/download` — encrypted media download

All other endpoints use the default client timeout.

### rawResponse for Binary Downloads

`downloadMedia` sets `rawResponse: true`, which instructs the API client to return the raw `ArrayBuffer` instead of attempting JSON parsing. Callers receive raw encrypted bytes and are responsible for decryption using the attachment key.

### AbortSignal Support

`uploadChunk` and `downloadMedia` accept an optional `AbortSignal` that is forwarded directly to the underlying fetch call. This enables in-flight cancellation for large uploads and downloads (e.g., user navigates away from the media upload screen).

### Client-Generated UUIDs

`createThread` and `createReply` accept an optional `id` field. When provided, the server uses that UUID as the record ID. This enables optimistic UI — the local record is created with a client UUID before the server confirms, and the sync layer reconciles using the same ID. Callers that omit `id` receive a server-generated UUID in the response.

---

## Known Gaps

### WebSocket

Real-time updates (new threads, replies, typing indicators, message delivery receipts) are delivered via WebSocket. The WebSocket connection is managed separately and is NOT part of this REST API layer. See `src/services/` for the WebSocket client implementation.

### Sealed Sender Endpoints

The Signal Protocol sealed-sender flow requires endpoints for encrypted sender certificates. These endpoints are not yet implemented on the backend (tracked separately). The current `messages` module sends unsealed envelopes until the backend adds sealed-sender support.

### Offline Sync Queue

The API layer itself has no offline awareness — it makes live HTTP calls. The offline-first sync queue (pending writes, retry logic, conflict resolution) is implemented at the store layer (`src/stores/`) and calls these API functions when network is available.

---

## Test Coverage

All 12 API service modules have corresponding test suites under `src/services/api/__tests__/`:

| Module | Test File | Tests |
|--------|-----------|-------|
| `auth.ts` | `auth.test.ts` | 4 |
| `client.ts` | `client.test.ts` | 20 |
| `threads.ts` | `threads.test.ts` | 9 |
| `keys.ts` | `keys.test.ts` | 4 |
| `tokenManager.ts` | `tokenManager.test.ts` | 25 |
| `users.ts` | `users.test.ts` | 6 |
| `groups.ts` | `groups.test.ts` | 10 |
| `messages.ts` | `messages.test.ts` | 8 |
| `media.ts` | `media.test.ts` | 7 |
| `invites.ts` | `invites.test.ts` | 6 |
| `devices.ts` | `devices.test.ts` | 2 |
| `version.ts` | `version.test.ts` | 3 |

Each test verifies that the module function calls `request()` with the correct `method`, `path`, `body`, and any special flags (`skipAuth`, `timeout`, `rawResponse`, `signal`).
