---
name: ecies-group-key-management
description: ECIES v2 with groupId HKDF binding, pending-wrap fulfillment on login, self-wrap bootstrap gap (Issue #14), and client-generated UUIDv4 for createGroup
metadata:
  type: project
---

## ECIES v2 Protocol

Version byte `0x02`. Key wrapping uses ECIES (Elliptic Curve Integrated Encryption Scheme) with HKDF info that includes the groupId as additional authenticated data (AAD).

**Wire format:** `[0x02 | ECIES ciphertext]` where HKDF info = `"orbital-ecies-v2:" || groupId`

**Client-generated groupId:** The client generates a UUIDv4 BEFORE calling createGroup, then passes it to the backend. The backend uses `COALESCE` for server-side fallback (generates its own UUID only if the client omits it). This ensures the client knows the groupId at encryption time without a round-trip.

**Why:** Binding the groupId into the HKDF derivation prevents key-relocation attacks where a wrapped key from Group A is replayed into Group B by a compromised server.

**How to apply:** When implementing ECIES wrap/unwrap, the HKDF info string MUST include the groupId. Forgetting this binding downgrades to v1 security. The version byte allows future protocol upgrades without ambiguity.

---

## Pending-Wrap Fulfillment

`fulfillPendingWraps()` runs after `loadConversations` on login/restore. Its job: distribute group keys to members who joined while this device was offline.

**Flow:**
1. After conversations load, iterate groups where the current user already has a decrypted group key
2. For each group, call `getPendingWraps(groupId)` to discover members awaiting a wrapped key
3. Wrap the group key with each pending member's identity public key (ECIES v2)
4. Submit via `submitWrappedKey` endpoint

**Throttling:**
- 60-second debounce (prevents rapid-fire on app-state transitions)
- Bounded to 10 groups x 5 members per sweep (prevents blocking the main thread on large families)

**Why:** Offline members cannot wrap keys for themselves. Any online member who has the group key can fulfill pending wraps for others. This is a cooperative protocol — availability improves with more online members.

**How to apply:** New group-related features (e.g., key rotation) must consider whether they create pending wraps. If so, `fulfillPendingWraps` handles delivery automatically — no per-feature logic needed.

---

## Self-Wrap Bootstrap Gap (Issue #14)

**Problem:** After a global key wipe (all members lose their group key), no member can bootstrap because:
- `submitWrappedKey` requires the submitter to already have a non-NULL key
- `submitWrappedKey` blocks self-wrap (you cannot wrap a key for yourself)

**Current workaround:** `fulfillPendingWraps` handles delivery when ANY member with a key comes online. But if ALL members lose their key simultaneously (e.g., a catastrophic server event), there is no recovery path short of creating a new group.

**Status:** Issue #14 — needs a dedicated self-wrap or re-keying endpoint before production. Low priority for beta (single-family, always at least one device online).

**How to apply:** When designing key rotation or group recovery flows, this gap must be addressed. Possible solutions: (a) allow self-wrap with server-side nonce binding, (b) admin re-key endpoint that generates a fresh group key, (c) out-of-band key transport.

---

## Related

- [[identity-key-lifecycle]] — ECIES locks must survive logout to prevent downgrade
- [[store-implementations]] — Identity key in Keychain is the ECIES private key for unwrapping
- [[crypto-hardening]] — Zeroize patterns apply to unwrapped group key material in memory
