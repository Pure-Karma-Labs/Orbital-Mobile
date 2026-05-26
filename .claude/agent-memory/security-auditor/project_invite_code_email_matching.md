---
name: invite-code-email-matching
description: Backend enforces email matching on join only when normalized_target_email is non-NULL; orbit-creation codes are general-purpose, Manage Orbits codes are email-targeted
metadata:
  type: project
---

## Invite Code Email Matching Logic

**Repo:** Pure-Karma-Labs/Orbital-Backend

### Two Types of Invite Codes

1. **Orbit-creation codes** — Generated during initial orbit setup. `normalized_target_email` is NULL. These are general-purpose and can be used by anyone with the code.

2. **Manage Orbits codes** — Generated from the Manage Orbits screen when inviting a specific person. `normalized_target_email` is set to the target's email. These enforce email matching at join time.

### Enforcement Logic

```
IF invite_code.normalized_target_email IS NOT NULL:
    THEN joining_user.email MUST match normalized_target_email
    ELSE reject with appropriate error
IF invite_code.normalized_target_email IS NULL:
    THEN any authenticated user can use the code (no email check)
```

### Security Implications

1. **Email normalization:** The `normalized_target_email` must use the same normalization as the joining user's email (lowercase, trim, potentially Gmail dot-stripping). Inconsistent normalization = bypass.
2. **Enumeration risk:** Error messages should not reveal whether a code exists but is email-restricted vs. does not exist. Use a generic "invalid or expired code" message.
3. **Code reuse:** Verify codes are single-use or have a use-count limit. A general-purpose code (NULL email) with no use limit could be shared beyond the intended family.
4. **Race condition:** If email matching is checked and then the join is processed in separate steps, a TOCTOU race could allow bypass. Should be atomic (single query with WHERE clause).

**Why:** The dual-mode invite system means some codes have no email restriction. Understanding this prevents false-positive audit findings while focusing attention on the actual enforcement boundaries.
**How to apply:** When auditing the join/signup flow, verify: (a) email normalization consistency, (b) atomic check-and-use, (c) generic error messages, (d) code expiration/use-limits. See [[backend-signup-field-naming]] for the wire format.
