---
name: Backend Database Access
description: SSH and PostgreSQL connection details for orbital-backend; groups table uses `id` not `group_id`, columns include encrypted_name and created_by
type: reference
---

## Connection

- SSH: `ssh root@134.199.230.235`
- PostgreSQL: `sudo -u postgres psql -d orbital`

## Schema gotchas

- Groups table primary key is `id`, NOT `group_id` (despite the API returning `groupId`)
- Relevant columns: `id`, `encrypted_name`, `created_by`
- Members table tracks group membership (separate from groups table)

## When to use

- Diagnosing legacy data issues (plaintext orbit names, placeholder keys)
- Re-provisioning test accounts by deleting stale orbits: `DELETE FROM groups WHERE id IN (...)`
- After DB deletion, create fresh orbits through mobile app to get proper AES-256-GCM encrypted data
- Verifying that API responses match actual DB state when debugging crypto failures
