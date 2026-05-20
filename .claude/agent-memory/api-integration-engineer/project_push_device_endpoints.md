---
name: push-device-endpoints
description: Device registration API endpoints for push notifications — POST /api/devices/register (upsert) and DELETE /api/devices/:deviceId (soft-delete)
metadata:
  type: project
---

Push notification device registration endpoints added as part of Phase 2.

## Endpoints

- `POST /api/devices/register` — upserts device token. Request: `{ platform, pushToken, deviceId }`. Response: `{ deviceId, platform, registeredAt }`.
- `DELETE /api/devices/:deviceId` — soft-delete (sets `is_active = false` in backend DB). Scoped to authenticated user. Returns void (204).

## Mobile API Client

- Module: `src/services/api/devices.ts` with `registerDevice()` and `deregisterDevice()`
- Types: `RegisterDeviceRequest` and `RegisterDeviceResponse` in `src/types/api.ts`
- Exported via namespace re-export in `src/services/api/index.ts` (`export * as devices from './devices'`)
- Follows the same `request<T>({ method, path, body })` pattern as users.ts, groups.ts, etc.

## Backend Push Dispatch

- Backend fires `sendPushToRecipients()` in `threads.js` (new_thread, new_reply) and `signal-relay.js` (new_dm)
- Push payloads are content-free: `{ t, gid, tid, rid, code, v }` — no message content ever included
- All dispatch hooks are fire-and-forget with `.catch(err => logger.error(...))`

**Why:** Push notifications are a Phase 2 core feature for mobile-first UX. Device registration is the prerequisite for receiving any push.

**How to apply:** When building push notification handling on the mobile side, the device token must be registered via `registerDevice()` after auth. On logout, call `deregisterDevice()` to stop push delivery. Push payloads contain only routing metadata — actual content must be fetched via existing thread/message API endpoints.
