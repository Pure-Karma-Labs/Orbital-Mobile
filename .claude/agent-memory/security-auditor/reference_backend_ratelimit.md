---
name: backend-ratelimit-v7-config
description: express-rate-limit v7 requires explicit xForwardedForHeader validation config when behind nginx reverse proxy
metadata:
  type: reference
---

## Backend Rate-Limit Configuration (express-rate-limit v7)

**Repo:** Pure-Karma-Labs/Orbital-Backend

When running `express-rate-limit` v7 behind an nginx reverse proxy:

- `app.set('trust proxy', 1)` is necessary but NOT sufficient for v7's stricter validation.
- Must also pass `validate: { xForwardedForHeader: false }` to the rate limiter options.
- Without this, v7 rejects requests because it detects an inconsistency between `trust proxy` and the `X-Forwarded-For` header validation.

**Why:** This was discovered during post-merge bug fixes for the Media Chunk 3 implementation. The rate limit was raised from 100 to 500 req/15min (per-endpoint limits deferred). Without the `validate` option, the rate limiter could silently fail to apply limits or reject all requests.

**How to apply:** When auditing backend rate-limiting or reviewing backend PRs that touch middleware configuration, verify both `trust proxy` and `validate.xForwardedForHeader` are set correctly. Also relevant when reviewing any new Express middleware that inspects client IP addresses. See [[audit-coverage-phase2]] for full backend notes.
