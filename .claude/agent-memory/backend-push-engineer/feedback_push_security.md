---
name: push-security-decisions
description: Security rules for push token handling, payload design, and error logging — established during initial push infrastructure deployment
metadata:
  type: feedback
---

Never log raw push tokens — log only error messages and device IDs (not the token string itself).

**Why:** Push tokens are sensitive credential-equivalent values. Logging them creates a persistent record that could be extracted from log aggregators.

**How to apply:** In pushService.js and devices.js, always use `device_id` (our internal UUID) in log messages, never the raw FCM/APNs token string.

---

Push payloads must be content-free — no message bodies, thread titles, or sender names.

**Why:** Zero-knowledge server principle. The server handles ciphertext only; leaking plaintext into push payloads would break the encryption model.

**How to apply:** The strict allowlist `[t, gid, tid, rid, code, v]` in pushService.js enforces this. Any new event type must fit within these fields. Consult the signal-crypto-specialist before adding new payload fields.

---

Android push must use data-only payloads (no `notification` key in the FCM message).

**Why:** Including a `notification` key on Android causes the system to display a notification before the app has a chance to decrypt and render the content, potentially showing encrypted ciphertext to users.

**How to apply:** Only iOS gets an `alert.title`. Android messages go into the FCM `data` field only.

---

`handleSendError` must deactivate tokens on known-bad FCM error codes, not just log them.

**Why:** Stale tokens that are never pruned cause silent push failures and accumulate indefinitely, degrading reliability metrics.

**How to apply:** The three deactivation codes are `registration-token-not-registered`, `invalid-registration-token`, and `invalid-argument`. When FCM returns these, set `active = false` on the device_tokens row immediately.
