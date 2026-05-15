---
name: project-429-retry-client
description: Global 429 retry in API client — 3 retries, exponential backoff capped at 10s, distinct from per-endpoint retry in uploadChunk
metadata:
  type: project
---

## Client-Level 429 Retry (added 2026-05-15)

`_executeRequest` in `src/services/api/client.ts` now retries HTTP 429 responses up to 3 times with exponential backoff before surfacing a `RATE_LIMITED` error.

### Behavior

- Max retries: 3 (`MAX_429_RETRIES`)
- Backoff: `1s * 2^attempt + jitter(0-500ms)`, capped at 10s (`MAX_RETRY_DELAY_MS`)
- Respects `AbortSignal` — if the request is aborted during backoff, throws `NetworkError` immediately
- After all retries exhausted: throws `ApiError` with code `RATE_LIMITED` and `retryable: true`

**Why:** The backend (`Pure-Karma-Labs/Orbital-Backend`) uses express-rate-limit v7 at 500 req/15min in production. Burst traffic (e.g., loading a thread with 20+ replies + media metadata) can hit this. A transparent retry at the client level absorbs transient 429s without requiring every caller to handle them.

**How to apply:** Do NOT use the server's `Retry-After` header value directly for mobile — it can suggest multi-minute waits that are unacceptable on a phone. The 10s cap ensures the user isn't staring at a frozen screen. If the server is truly overloaded, the retries will fail and the caller gets the RATE_LIMITED error to show UI feedback.

### Distinct from Upload Chunk Retry

`uploadChunk` in `src/services/api/media.ts` has its OWN retry loop (3 attempts, exponential backoff) that wraps the entire upload call including 429s. This is intentional — chunk uploads are long-running and benefit from endpoint-specific retry semantics (e.g., skip retry on 401/403, handle cancellation). The client-level retry and the uploadChunk retry can stack, but in practice the client retry resolves most 429s before the uploadChunk retry activates.

### Backend Context

- Rate limit: 500 req/15min (production), express-rate-limit v7
- Backend needs `validate: { xForwardedForHeader: false }` when behind nginx proxy
- Auth limiter is separate: 10 req/15min on `/api/login` and `/api/signup` only

### Related

- [[project-media-upload-pipeline]] — uploadChunk has its own retry layer
