---
name: invite-codes-endpoint
description: POST /api/groups/:groupId/invite-codes requires target_email in body; route was broken until 2026-05-23 fix
metadata:
  type: project
---

## Backend Invite Codes Endpoint (2026-05-23)

### Endpoint

`POST /api/groups/:groupId/invite-codes`

### Contract

**Request body** (snake_case, per client auto-transform):
```json
{
  "target_email": "user@example.com"
}
```

**Response** (200):
```json
{
  "invite_code": "abc123...",
  "expires_at": "2026-06-23T..."
}
```

### Bug Fixed (2026-05-23)

The backend route handler was not extracting `target_email` from `req.body` — it was looking in the wrong place (possibly query params or not at all). Fixed to properly destructure from body.

**Why:** This endpoint is used during the invite flow when an existing orbit member invites a new user by email.

**How to apply:** When building the invite UI flow, call this endpoint via a service function. Remember the client auto-transforms `targetEmail` to `target_email` in the body. See [[client-camel-snake-transform]].
