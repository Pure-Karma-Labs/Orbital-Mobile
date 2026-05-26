---
name: identity-key-lifecycle
description: Orbital identity keys are per-device (survive logout); logout clears sessions + sender keys only; lastUserId sentinel detects account switch and triggers full crypto wipe
metadata:
  type: project
---

## Identity Key Persistence Model

Orbital diverges from Signal's standard model where identity keys are per-registration (tied to a phone number). In Orbital:

- **Identity keys are per-device, not per-registration.** They survive logout.
- **Logout only clears:** sessions, sender keys, and cached state. The identity key pair in Keychain/Keystore is preserved.
- **Account switch detection:** A `lastUserId` sentinel value is stored. On login, if the incoming userId differs from `lastUserId`, a full crypto wipe is triggered (identity key deleted, all stores cleared, fresh key pair generated).
- **Rationale:** Family app with stable devices. Avoiding unnecessary re-keying on routine logout/login preserves session continuity and avoids pre-key churn.

### Security Implications

1. **Device theft after logout:** The identity key remains in Keychain/Keystore. Biometric gating (F-12, currently Low/deferred) would mitigate this.
2. **Account switching:** The `lastUserId` sentinel is the critical gate. If it fails to detect a switch, a new user would inherit the previous user's identity key — impersonation risk.
3. **Backup extraction:** Identity key survives logout, so backup-based attacks have the same window whether the user is logged in or out. Keychain `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` prevents iCloud backup extraction.

### Audit Checkpoints

- Verify `lastUserId` is written atomically with login success, not before authentication completes.
- Verify the full crypto wipe path deletes: identity key from Keychain, all SQLCipher Signal stores, any cached key material in memory.
- Verify logout does NOT delete the identity key or `lastUserId`.

**Why:** This non-standard persistence model is intentional for UX but creates attack surface around the account-switch sentinel. Must be verified whenever auth flows change.
**How to apply:** Reference when reviewing auth/logout flows, Keychain operations, or any PR touching identity key lifecycle. See [[preloaded-store-architecture]] for identity key storage details.
