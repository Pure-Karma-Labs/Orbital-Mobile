---
name: push-infrastructure-deployed
description: Push notification backend fully deployed — Firebase/FCM live, device token endpoints, dispatch hooks in threads.js and signal-relay.js
metadata:
  type: project
---

Push infrastructure is live as of 2026-05-20.

**Why:** Mobile clients need reliable background message delivery; WebSocket alone only works when the app is foregrounded.

**How to apply:** This is not aspirational — it is deployed. Reference these file paths when adding new event types or debugging delivery issues.

## Backend Files (Pure-Karma-Labs/Orbital-Backend)

- `migrations/1730000000021_device-tokens.js` — device_tokens table, unique index on (user_id, device_id)
- `src/routes/devices.js` — POST /api/devices/register (upsert, 20 requests/15min rate limit per user), DELETE /api/devices/:deviceId (IDOR-protected, scoped to user_id)
- `src/services/pushService.js` — firebase-admin integration, lazy init, PUSH_ENABLED env guard, strict payload field allowlist

## Dispatch Hooks

Push is dispatched fire-and-forget alongside existing WebSocket broadcasts:

- `src/routes/threads.js` — hooks for `new_thread` and `new_reply` events; reuses recipients array from broadcastToConversation
- `src/routes/signal-relay.js` — hook for `new_dm` events

No online-user skip: push is always sent; the client deduplicates. This prevents a race condition where WebSocket drops between the server's "online" check and actual delivery.

Invites are intentionally excluded — no target user_id is available at invite generation time.

## Allowed Payload Fields

Strict allowlist in pushService.js: `[t, gid, tid, rid, code, v]`
- `t` = event type string
- `gid` = group ID
- `tid` = thread ID
- `rid` = reply ID
- `code` = notification code
- `v` = payload version

No message bodies, thread titles, or sender names — content-free by design.

## Platform Differences

- iOS: `alert.title` with literal strings, uses APNs via Firebase
- Android: data-only payload (no `notification` key) — avoids system tray interference with encrypted content
