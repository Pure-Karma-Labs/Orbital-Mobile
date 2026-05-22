---
name: audit-pr157-ecies-wrap
description: "PR #157 security audit — ECIES group key wrapping; 2 Critical + 1 High fixed (XEdDSA auth, HKDF binding, sender key verification); 2 Medium deferred"
metadata:
  type: project
---

## PR #157 Audit — ECIES Wrap Orchestration (2026-05-22)

Branch: `feature/95-wrap-orchestration`

### Critical Findings — RESOLVED

1. **unwrapGroupKey passes own public key as expected sender** — `getOrFetchGroupKey` called `unwrapGroupKey(response.wrappedGroupKey, getIdentityKeyPair().publicKey)`. The Rust `ecies_open` requires the **sender's** public key for XEdDSA verification. Self-wraps worked because sender == self, but cross-user wraps would fail.
   - **Resolution:** `wrapped_by` column added to backend `wrapped_keys` table. Client fetches `wrappedBy` user ID, looks up their public key, and passes it to `ecies_open` for sender verification.

2. **persistGroupKey validates 32 bytes but receives 190-byte ECIES envelopes** — `loadConversations`, `loadDmConversations`, and `joinOrbit` passed `wrappedGroupKey` (190-byte base64 ECIES envelope) to `persistGroupKey`, which called `validateAndDecode` rejecting anything != 32 bytes. Errors swallowed silently in load paths; no outer try/catch in joinOrbit.
   - **Resolution:** Receive paths updated to call `ecies_open` to unwrap the envelope before persisting the 32-byte group key.

### High Finding — RESOLVED

3. **Unauthenticated ECIES allowed server key substitution** — Original ECIES construction had no sender authentication. A compromised or malicious server could generate its own ECIES envelope wrapping a known key, substituting it for the real group key. Recipient would accept it without detecting the swap.
   - **Resolution:** XEdDSA signature added over the sealed envelope. Sender signs with their identity key. Recipient verifies signature using sender's public key before decryption.

### Additional High Finding — RESOLVED

4. **HKDF had no context/channel binding** — HKDF `info` parameter was empty or generic. An envelope sealed for user A could theoretically be replayed to user B if the server controlled routing.
   - **Resolution:** HKDF `info` now includes `ephemeralPub || recipientPub` (64 bytes), binding the derived key to the specific ephemeral session and intended recipient.

### Medium Findings — OPEN (deferred)

5. **detectKeyFormat allows raw-to-ecies downgrade** — No sticky per-group enforcement. A compromised server can substitute a known 32-byte value for a previously-wrapped key and bypass ECIES authentication.
   - **Status:** Deferred. Will be addressed when group key rotation is implemented (v2).

6. **evictPendingCache/submitWrappedKey/getPendingWraps never called** — WS handlers for `wrap_key_request`/`wrapped_key_delivered` are empty stubs. Only the 30s TTL expires pending state.
   - **Status:** Deferred. WebSocket key distribution is scaffolded but not connected.

### Positive Verifications

- `ecies_seal` called with correct 4 params (plaintext, recipientPubKey, privateKey, publicKey)
- No private key material in logs or state (no console statements in contentCrypto/identityKeyAccess)
- Rust ECIES implementation uses `zeroize`, constant-time comparison, small-order point rejection via `was_contributory()`
- Version byte check in `detectKeyFormat` (0x01 for ECIES)
- XEdDSA signature covers the entire sealed envelope (ephemeral pub + nonce + ciphertext + tag)
- HKDF channel binding includes both ephemeral and recipient public keys
- `submitWrappedKey` backend endpoint enforces explicit target membership check + transaction
- TOFU model for identity keys is acceptable for family social network; safety numbers needed long-term

### Authorization Model
- `submitWrappedKey` requires: (1) authenticated user is orbit member, (2) target user is orbit member
- Both checks are server-side in a database transaction
- Client checks are defense-in-depth only

**Why:** Tracks the evolution of ECIES wrap findings from initial Critical/High through resolution. All Critical/High findings are now resolved.
**How to apply:** Medium items (#5, #6) should be tracked in open_security_items.md. Any future changes to ECIES wrapping, key distribution, or authorization require re-audit against these findings.
