---
name: group-key-delivery-flow
description: Group key wrapping uses WebSocket wrap_key_request; offline delivery depends on fulfillPendingWraps() on next member login; no persistent WS queue
metadata:
  type: project
---

## Group Key Delivery Flow (2026-05-23)

### Happy Path (online member available)

1. New member joins/signs up -> member row created with `wrapped_group_key = NULL`
2. Server sends `wrap_key_request` WebSocket event to all online group members
3. An online member's client receives the WS event
4. Client calls `getPendingWraps(groupId)` to get list of members needing keys
5. Client ECIES-wraps the group key for each pending member using their `identityPublicKey`
6. Client calls `submitWrappedKey(groupId, userId, wrappedGroupKey)` for each
7. Server stores the wrapped key and sends `wrap_key_delivered` WS event to the new member
8. New member can now decrypt group content

### Offline Path (no members online)

If no group members are online when a new member joins:
- The `wrap_key_request` WS event is lost (no persistent queue for WebSocket messages)
- Key delivery depends on `fulfillPendingWraps()` which runs when the NEXT member logs in
- Until then, the new member has a NULL key and cannot decrypt content

### Implications for Client

- After signup, the client must handle the "pending key" state gracefully (show loading/placeholder)
- The client should call `fulfillPendingWraps()` on app foreground/login to catch any missed requests
- There is NO server-side retry or persistent queue for missed WS messages

### Related Endpoints

- `GET /api/groups/:groupId/pending-wraps` — list members needing wrapped keys
- `POST /api/groups/:groupId/members/:userId/wrapped-key` — submit a wrapped key

**Why:** This async key delivery model enables offline joins without requiring all members to be online simultaneously. The tradeoff is potential delay in key delivery if no members are active.

**How to apply:** The client must be resilient to NULL `wrappedGroupKey` in group responses. Always call `fulfillPendingWraps()` during app initialization/foreground. See [[issue-95-wrapped-key-contract]] for type details and [[signup-auto-join]] for the signup trigger.
