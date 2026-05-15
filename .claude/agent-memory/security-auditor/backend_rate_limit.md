---
name: backend-rate-limit-status
description: Backend rate limit raised to 500/15min globally; per-endpoint limits deferred with follow-up issue
metadata:
  type: project
---

Global rate limit raised from 100 to 500 requests per 15 minutes (as of 2026-05-14).
Per-endpoint rate limiting is not yet implemented — a follow-up issue has been filed.

**Why:** The 100 req/15min limit was too aggressive for media upload flows (chunked uploads can consume many requests quickly). The global raise is a stopgap.
**How to apply:** When auditing API abuse vectors, note that there is no per-endpoint throttling. A single endpoint (e.g., chunk upload) can consume the entire budget, potentially starving other requests. Flag if per-endpoint limits remain unimplemented before beta launch.
