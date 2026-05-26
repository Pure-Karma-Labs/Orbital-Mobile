---
name: signal-relay-ratelimit-per-user
description: Signal relay /v1/ rate limiting must be keyed by userId not IP — family members share NAT IPs; use req.user?.userId ?? req.ip with null guard
metadata:
  type: project
---

## Signal Relay Rate Limiting — Per-User Keying

### Problem

Family members sharing a home network all present the same public IP address (NAT). Per-IP rate limiting on the Signal relay routes (`/v1/messages`, `/v1/keys`, etc.) would throttle an entire household when multiple family members are active simultaneously.

### Required Pattern

```javascript
keyGenerator: (req) => req.user?.userId ?? req.ip
```

- **Authenticated requests:** Rate limit by `userId` (extracted from JWT after auth middleware).
- **Unauthenticated requests:** Fall back to `req.ip` (covers pre-auth key fetching, etc.).
- **Null guard:** The `?? req.ip` fallback is critical — without it, unauthenticated requests would all share a single `undefined` bucket, effectively creating a global rate limit that one attacker could exhaust for everyone.

### Scope

This applies specifically to `/v1/` routes (Signal Protocol relay). Other routes (auth, media upload) may use per-IP limiting if appropriate, but should still consider the shared-NAT scenario for family apps.

### Related

- See [[backend-ratelimit-v7-config]] for the `validate.xForwardedForHeader` requirement.
- The `trust proxy` + `validate` configuration is a prerequisite — without correct IP extraction, even per-user keying would malfunction for unauthenticated fallback.

**Why:** Orbital's threat model is a family social network. Shared household NAT is the default, not an edge case. Per-IP limiting would degrade UX for legitimate multi-device households.
**How to apply:** When auditing any backend rate-limiting configuration, verify relay routes use per-user keying. When reviewing new authenticated API routes, consider whether per-user keying is more appropriate than per-IP.
