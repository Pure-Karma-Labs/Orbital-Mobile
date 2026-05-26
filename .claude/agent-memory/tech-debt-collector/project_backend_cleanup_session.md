---
name: backend-cleanup-2026-05-23
description: Backend debt resolved in single session — rate limiter centralized, UUID regex deduplicated, field naming standardized, 204 response handling fixed
metadata:
  type: project
---

On 2026-05-23, several backend debt items were resolved in Orbital-Backend:

**1. In-memory rate limiter centralized**
- Now lives in `src/middleware/rateLimiters.js`
- Uses `skip: skipRateLimiting` for test/dev bypass (NOT `max: 0` which blocks in express-rate-limit v7)
- Documented single-process constraint (will need Redis store for horizontal scaling)

**2. Duplicate UUID_REGEX extracted**
- Shared `isValidUUIDv4()` extracted to `src/utils/validation.js`
- All route files now import from there instead of defining their own regex

**3. Field naming inconsistency fixed**
- Signup route previously mixed camelCase (`inviteCode`) with snake_case (`public_key`)
- Fixed to all snake_case — consistent with other routes
- Mobile client auto-transforms via camelToSnake utility, so no client changes needed

**4. API client 204 response fix (Mobile)**
- `client.ts` now returns `undefined` on 204 responses without attempting JSON parse
- Eliminates need for per-endpoint PARSE_ERROR workarounds

**Why:** These were friction-reducing cleanups that prevent pattern spread. The rate limiter `max: 0` vs `skip` distinction is a v7 gotcha worth remembering.

**How to apply:** When reviewing backend PRs, verify new routes use `isValidUUIDv4()` from validation.js and apply rate limiters from rateLimiters.js rather than defining inline. For new API endpoints that return 204, no special handling is needed on the mobile client.

Related: [[debt-registry]]
