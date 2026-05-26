---
name: identity-key-lifecycle
description: Identity keys are per-device not per-session; logout preserves crypto material, only clears sessions/sender-keys; account-switch detection via lastUserId sentinel triggers fullCryptoWipe
metadata:
  type: project
---

## Identity Key Lifetime: Per-Device, NOT Per-Session

Identity keys persist across logout/login cycles for the same user on the same device. They are generated once during registration and survive until the device is wiped or a different account logs in.

**Why:** Pre-keys uploaded to the server reference this identity key. If identity material were regenerated on login, peers holding stale bundles would get UntrustedIdentity errors. The server's pre-key count threshold (20) would not trigger replenishment if keys still exist server-side.

**How to apply:** Never clear identity keys, pre-keys, or TOFU pins on logout. Only clear session state.

---

## What Logout Preserves vs Clears

**PRESERVED on logout (same-user re-login scenario):**
- Identity private key (Keychain/Keystore) — see [[store-implementations]]
- Items table entries: public identity key, registration ID, pre-key IDs, ECIES locks (`ecies_locked:{groupId}`)
- Pre-keys (one-time, signed, Kyber) — server still advertises these
- signal_identity_keys table (TOFU pins for known peers)

**CLEARED on logout:**
- Sessions (session state is ephemeral; Double Ratchet re-establishes on next message)
- Sender keys (group ratchet state; re-distributed via SKDM on next group message)

**Why:** Sessions and sender keys are forward-looking state. Clearing them forces re-establishment which is safe. Pre-keys and identity are backward-facing commitments — clearing them creates zombie state where the server advertises keys that the device can no longer use for decryption.

---

## Account-Switch Detection

`lastUserId` sentinel stored in the items table. On login:
1. Read `lastUserId` from items
2. Compare against the authenticated userId from the login response
3. **Match:** Same user re-login. Preserve all crypto material.
4. **Mismatch:** Different account. Call `fullCryptoWipe()` which:
   - Clears ALL crypto tables (sessions, sender keys, pre-keys, signed pre-keys, Kyber pre-keys, identity keys)
   - Removes identity private key from Keychain
   - Clears items table entries (including ECIES locks)
   - Forces fresh registration flow

The `fullCryptoWipe()` function was extracted from the old logout logic specifically for this mismatch path.

**Why:** A device switching between accounts must not carry over key material. Identity keys are bound to a specific user's registration. Using User A's identity key for User B's sessions would cause protocol failures and break trust verification.

**How to apply:** The `fullCryptoWipe()` boundary is the ONLY path that clears identity material. Normal logout must never call it. Any new crypto state added in the future needs a corresponding cleanup entry in `fullCryptoWipe()`.

---

## Pre-Key Zombie State (Anti-Pattern)

Never clear pre-keys on logout while the server still advertises them:
- Server's `checkAndReplenishPreKeys` checks count against threshold (20)
- If pre-keys exist server-side but the device deleted them locally, peers fetching bundles will get pre-key IDs that the device cannot decrypt with
- This creates "zombie" pre-keys: valid from the server's perspective, useless from the device's perspective
- The only recovery is a full re-registration (new identity key, new pre-key batch upload)

---

## ECIES Downgrade Protection

`ecies_locked:{groupId}` items MUST survive logout:
- These flags record that a group has been upgraded to ECIES-wrapped keys
- If cleared on logout, a compromised server could serve raw (unwrapped) keys after re-login
- The client would accept them without ECIES verification, enabling a key substitution attack
- This is why items table preservation on logout is security-critical, not just a convenience

See [[ecies-group-key-management]] for ECIES v2 details.
