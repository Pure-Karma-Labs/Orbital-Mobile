---
name: issue-95-wrapped-key-contract
description: API contract changes for Issue #95 — encryptedGroupKey renamed to wrappedGroupKey, new pending-wraps endpoints, wrappedBy field semantics, identity key format distinction
metadata:
  type: project
---

## Issue #95: Wrapped Group Key API Contract Changes (2026-05-22)

### Rename: encryptedGroupKey -> wrappedGroupKey

All request/response types that previously used `encryptedGroupKey` now use `wrappedGroupKey`. The backend snake_case field is `wrapped_group_key`, auto-transformed by `snakeToCamel`.

### Type-by-type changes

**JoinGroupRequest** — removed `encryptedGroupKey` entirely. The server now wraps the group key asynchronously after join, so the client no longer sends it at join time.

**JoinGroupResponse** — `wrappedGroupKey` is `string | null`. A `null` value means the server hasn't wrapped the key yet (pending wrap state). The client must poll or wait for push to get the wrapped key later.

**GroupResponse** — renamed field + added `wrappedBy: string` (userId UUID of the member who wrapped the key for this user).

**GroupKeyResponse** — renamed field + added `wrappedBy: string`.

**CreateDmResponse** — renamed field + added `wrappedBy: string`.

**DmResponse** — renamed field + added `wrappedBy: string`.

**CreateDmRequest** — added optional `recipientWrappedGroupKey?: string` so the DM creator can pre-wrap the key for the recipient.

**GroupMember.publicKey** — changed from `unknown` to `string` (the identity public key is always present for members).

### New types

- **SubmitWrappedKeyRequest** — `{ wrappedGroupKey: string }` — body for submitting a wrapped key for a specific user.
- **PendingWrapsResponse** — `Array<{ userId: string; identityPublicKey: string }>` — list of members who still need their group key wrapped.

### New API functions (groups.ts)

- `submitWrappedKey(groupId: string, userId: string, wrappedGroupKey: string)` — POST `/api/groups/:groupId/members/:userId/wrapped-key`
- `getPendingWraps(groupId: string)` — GET `/api/groups/:groupId/pending-wraps` — returns array of `{userId, identityPublicKey}`.

### New backend endpoint

- `POST /v1/keys/bundle` — stores `identity_public_key` (among other pre-key bundle fields). The identity key stored here is the DJB/Curve25519 key used for ECIES wrapping.

**Why:** Issue #95 transitions from client-side synchronous key wrapping at join time to server-mediated async wrapping. This enables offline joins and multi-device key distribution.

**How to apply:** When touching any group/DM creation or join flow, use `wrappedGroupKey` (not `encryptedGroupKey`). Always handle `null` wrappedGroupKey as a pending state. The `wrappedBy` field is a userId that must be resolved via `getPreKeyBundle()` to get the actual identity key for ECIES unwrapping.
