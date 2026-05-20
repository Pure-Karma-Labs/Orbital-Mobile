---
name: phase2-push-notification-audit
description: Push notification security audit outcomes — zero-knowledge payloads, IDOR fix, rate limiting, token logging, APNs-via-FCM tradeoff
metadata:
  type: project
---

## Push Notification Security Audit (2026-05-20)

### Positive Verifications

1. **Zero-knowledge push payloads enforced** — Backend `pushService.js:filterPayload()` applies strict field allowlist: `[t, gid, tid, rid, code, v]`. No message content, sender names, or thread titles ever reach push infrastructure.

2. **IDOR on DELETE /api/devices/:deviceId fixed** — Endpoint now scoped to authenticated `user_id`. Returns 404 (not 403) for devices belonging to other users, preventing enumeration.

3. **Per-user rate limiting on device registration** — 20 requests per 15 minutes, keyed by `userId` (not IP). Prevents device-registration abuse and token brute-forcing.

4. **Raw FCM/APNs tokens never logged** — Only error messages and device IDs appear in catch blocks. Token values excluded from all log output (verified in `notificationService.ts` and backend `pushService.js`).

5. **Firebase service account restricted** — IAM role limited to `cloudmessaging.admin` only. No Firestore, Auth, or Storage access from the push-sending service account.

6. **Deep link navigation is safe** — `navigateFromNotification()` in `notificationService.ts:237` uses hardcoded `switch` on `t` field. Unknown types fall through to `default: break` (no-op). Missing IDs (`tid`, `gid`, `code`) trigger early `return` — cannot navigate to arbitrary screens via crafted push payloads.

7. **Cold-start payload queuing is safe** — `setPayloadConsumer()` is called synchronously in `setupNotificationTapHandler()`, registering the consumer before the async `getInitialNotification()` resolves. No race window where a payload could be consumed by an uninitialized handler. Queued payloads are flushed from `NavigationContainer.onReady`.

8. **Content-free local notifications** — Foreground display uses Notifee with static titles from `NOTIFICATION_TITLES` lookup (keyed by `t` field). `body: 'Tap to view'` is hardcoded — no server-supplied text reaches the notification shade.

### Architecture Decision: APNs via FCM Gateway

APNs messages are routed through the FCM gateway rather than using direct APNs integration. Acceptable for beta because:
- All push payloads are content-free event signals (no plaintext content)
- Eliminates the need for a separate APNs certificate/key management path
- Trade-off: slightly higher latency on iOS, dependency on Google infrastructure for Apple push delivery
- Revisit for production if latency or reliability issues arise

### Spec Update

`docs/MOBILE-APP-SPEC.md` was updated to remove `sender_display_name` and `notification_body` from the push payload specification. These fields were in the original spec but were never implemented — the zero-knowledge payload design was adopted from the start. The spec now matches the implementation.

### Backend References

The following are in `Pure-Karma-Labs/Orbital-Backend`, not in this repo:
- `pushService.js:filterPayload()` — field allowlist enforcement
- Device registration rate limiting (express-rate-limit, 20/15min per userId)
- Firebase IAM role restriction
- IDOR fix on `DELETE /api/devices/:deviceId`

**Why:** Push notifications are a high-risk surface for metadata leakage in E2EE apps. This audit confirms the zero-knowledge payload design is implemented correctly end-to-end.
**How to apply:** Any future push payload field additions must be reviewed against the allowlist. New fields containing user-generated content or metadata (display names, message previews, timestamps) are Critical severity findings.
