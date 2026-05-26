---
name: signup-auto-join
description: Backend signup auto-joins user to orbit group (NULL key) and sends wrap_key_request WS event; previously only marked invite code as used
metadata:
  type: project
---

## Signup Auto-Join Behavior (2026-05-23)

### Current Behavior (after fix)

When a user signs up with an invite code:
1. User record is created
2. Invite code is marked as used
3. User is automatically INSERTed into the `members` table for the orbit group with `wrapped_group_key = NULL`
4. Server sends `wrap_key_request` WebSocket event to online group members
5. An online member's client calls `fulfillPendingWraps()` to ECIES-wrap the group key for the new member

### Previous Behavior (broken)

Signup only marked the invite code as used. The user was NOT added to the group's members table. This meant:
- The user had no group membership after signup
- They couldn't see the orbit or its threads
- Manual intervention was needed to add them

### Key Detail: NULL wrapped_group_key

The new member row has `wrapped_group_key = NULL` until another member wraps it. The client must handle this null state gracefully — the user can see they belong to the group but cannot decrypt content until key delivery completes.

**Why:** The old flow required a separate "join" step after signup which was never implemented in the mobile client. Auto-join on signup simplifies the onboarding flow.

**How to apply:** After signup, the client should expect the user to already be a group member but with a pending key state. Poll or listen for `wrap_key_delivered` WS event. See [[issue-95-wrapped-key-contract]] for the wrapped key flow.
