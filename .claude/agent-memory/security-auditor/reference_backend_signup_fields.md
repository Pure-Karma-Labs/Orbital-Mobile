---
name: backend-signup-field-naming
description: Backend signup route uses snake_case fields (invite_code, public_key) because mobile API client auto-transforms camelCase to snake_case
metadata:
  type: reference
---

## Backend Signup Route — Field Naming Convention

**Repo:** Pure-Karma-Labs/Orbital-Backend

The signup route (`POST /auth/signup` or equivalent) expects snake_case field names in the request body:

- `invite_code` (not `inviteCode`)
- `public_key` (not `publicKey`)

### Why Snake Case

The mobile API client (likely an Axios interceptor or similar) automatically transforms outgoing request bodies from camelCase to snake_case. The backend therefore expects and validates snake_case fields.

### Security Relevance

- **Input validation:** If auditing the signup route's request validation (Joi, Zod, express-validator), look for snake_case field names, not camelCase.
- **Injection surface:** The `public_key` field carries the user's identity public key. Validation must ensure it is a properly-encoded Ed25519 key (32 bytes, base64) and reject malformed input.
- **Invite code:** Should be validated as alphanumeric with expected length. Timing-safe comparison if checked against stored codes.

**Why:** Knowing the wire format avoids confusion during backend security audits and ensures correct field validation paths are reviewed.
**How to apply:** When auditing auth routes or API contract changes, remember the snake_case convention on the wire. Check that the auto-transform layer doesn't introduce injection vectors (e.g., nested objects being flattened incorrectly).
