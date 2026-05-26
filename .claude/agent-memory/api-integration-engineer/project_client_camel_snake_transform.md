---
name: client-camel-snake-transform
description: API client auto-transforms body keys camelCase->snake_case; backend must accept snake_case; caused signup bug with inviteCode->invite_code
metadata:
  type: project
---

## API Client camelCase to snake_case Auto-Transform (2026-05-23)

The `request()` function in `src/services/api/client.ts` automatically transforms all JSON body keys from camelCase to snake_case before sending to the backend. This is a global transform applied to every request with a body.

### The Pitfall

If a backend endpoint is written to expect camelCase field names (e.g., `inviteCode`), the request will fail because the client sends `invite_code` instead. This caused a real signup bug where the backend route handler destructured `req.body.inviteCode` but received `invite_code`.

### Rules

1. All backend route handlers MUST destructure using snake_case field names from `req.body`
2. When writing new backend endpoints, always expect snake_case in the body
3. When debugging "field is undefined" backend errors, check whether the mismatch is a casing issue
4. FormData bodies (used by `uploadChunk`, `uploadAvatar`) are NOT transformed — they use manual snake_case keys directly

**Why:** The transform is correct by convention (REST APIs use snake_case), but developers writing backend code may forget and use camelCase in their destructuring patterns.

**How to apply:** When adding new backend endpoints or debugging missing field errors, always verify the backend handler uses snake_case field names. See also [[issue-92-cleanup-findings]] for the FormData exception.
