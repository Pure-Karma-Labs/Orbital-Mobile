---
name: rate-limiter-architecture
description: Backend rate limiting in src/middleware/rateLimiters.js — four tiers, xForwardedForHeader validation, per-user vs per-IP fallback
metadata:
  type: project
---

## Backend Rate Limiter Architecture (2026-05-23)

### Location

`Orbital-Backend/src/middleware/rateLimiters.js` — centralized rate limiter definitions.

### Four Tiers

| Tier | Limit | Key | Use Cases |
|------|-------|-----|-----------|
| auth | 10 req/window/IP | IP address | Login, signup, password reset |
| general | 500 req/window/IP | IP address | Most authenticated endpoints |
| signalRelay | 500 req/window/user | userId (fallback IP) | Signal protocol message relay |
| mediaUpload | 300 req/window/user | userId (fallback IP) | Chunk uploads |

### Configuration Requirements

All limiters need `validate: { xForwardedForHeader: false }` because the app runs behind nginx. Without this flag, the rate limiter rejects requests that have `X-Forwarded-For` headers (treating them as spoofed).

### Per-User Key Pattern

Per-user limiters use: `req.user?.userId ?? req.ip`

This means unauthenticated requests (where auth middleware hasn't run or failed) fall back to IP-based limiting rather than crashing.

**Why:** Rate limiting protects the backend from abuse. The tier structure balances security (tight auth limits) with usability (generous limits for normal authenticated use).

**How to apply:** When adding new backend endpoints, assign the appropriate rate limiter tier. Auth-adjacent endpoints (anything that doesn't require a valid token) get `auth` tier. Media/upload endpoints get `mediaUpload`. Most others get `general`. The client should handle 429 responses gracefully — see [[project_429_retry_client]] for the retry logic.
