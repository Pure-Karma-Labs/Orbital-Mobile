---
name: push-test-coverage
description: Test file locations and coverage counts for push service and device endpoints in Orbital-Backend
metadata:
  type: reference
---

## Test Files (Pure-Karma-Labs/Orbital-Backend)

- `tests/pushService.test.js` — 28 tests covering:
  - `filterPayload` — allowlist enforcement, field stripping
  - `buildMessage` — iOS vs Android payload structure
  - `handleSendError` — token deactivation on known-bad FCM error codes

- `tests/devices.test.js` — 11 integration tests covering:
  - POST /api/devices/register (happy path, upsert behavior, rate limit)
  - DELETE /api/devices/:deviceId (happy path, IDOR protection — cannot delete another user's token)
  - Mock auth middleware pattern used throughout

## Key Test Patterns

- Auth is mocked via middleware injection (not live JWT verification)
- IDOR test verifies that DELETE scoped to user_id correctly rejects cross-user requests with 403
- pushService tests mock firebase-admin — no live FCM calls during test runs
