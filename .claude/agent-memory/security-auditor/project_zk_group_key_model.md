---
name: project-zk-group-key-model
description: "Zero-knowledge group key distribution — per-member ECIES wrapping, backend stores only ciphertext, send/receive path status"
metadata:
  type: project
---

## Zero-Knowledge Group Key Model (2026-05-22)

### Architecture
Each orbit/DM group has a single 32-byte AES-256 group key used for content encryption (thread titles, bodies, media metadata envelopes). The group key is distributed using per-member ECIES wrapping:

1. **Key Generation:** Creator generates a 32-byte CSPRNG group key
2. **Per-Member Wrapping:** For each member, the creator calls `ecies_seal(groupKey, memberPubKey, senderPrivKey, senderPubKey)` producing a 190-byte ECIES envelope
3. **Backend Storage:** Backend stores `wrapped_keys` table with `(orbit_id, user_id, wrapped_key, wrapped_by)`. Backend sees only ciphertext — zero knowledge of plaintext group keys.
4. **Unwrapping:** Each member calls `ecies_open(wrappedKey, senderPubKey, recipientPrivKey)` to recover the 32-byte group key

### Backend Schema
- `wrapped_keys` table: `orbit_id`, `user_id`, `wrapped_key` (base64 ECIES envelope), `wrapped_by` (user_id of sealer)
- `wrapped_by` column is required for `ecies_open` sender verification — the recipient needs to know whose public key to verify the XEdDSA signature against

### Send Paths (wired as of 2026-05-22)
- **createOrbit:** Wraps group key for all initial members at orbit creation time
- **startDm (isNew):** Wraps group key for both DM participants

### Receive Paths (scaffolded, not yet connected)
- **unwrap on load/join:** `loadConversations`, `loadDmConversations`, and `joinOrbit` receive `wrappedGroupKey` from API but connection to `ecies_open` was broken (PR #157 Critical finding #2 — envelope bytes passed to validator expecting 32 bytes)
- **WS handlers:** `wrap_key_request` and `wrapped_key_delivered` WebSocket message handlers are empty stubs (PR #157 Medium finding #5)

### Authorization Model
- **submitWrappedKey:** Requires explicit target membership check + database transaction. The submitter must be a member of the orbit AND the target user must be a member.
- Backend validates both conditions server-side; client-side checks are defense-in-depth only.

### Known Gaps (as of 2026-05-22)
1. **No group key rotation on member removal** — When a member is removed, the group key is not rotated. Removed member retains the ability to decrypt past messages (expected for backward secrecy) AND any future messages if they intercept ciphertext. Scheduled for v2 scope.
2. **detectKeyFormat allows raw-to-ecies downgrade** — No sticky per-group enforcement. A compromised server could substitute a raw 32-byte key for a previously ECIES-wrapped key. Medium severity.
3. **evictPendingCache / getPendingWraps never called** — The pending wrap request/delivery cycle over WebSocket is stubbed but not connected.

**Why:** Documents the group key distribution model so all agents understand the trust boundaries and zero-knowledge properties.
**How to apply:** Any PR touching group key creation, wrapping, unwrapping, or distribution must preserve zero-knowledge (backend never sees plaintext key) and per-member authentication (ECIES with XEdDSA). Changes to the wrapped_keys schema or authorization model are High severity minimum.
