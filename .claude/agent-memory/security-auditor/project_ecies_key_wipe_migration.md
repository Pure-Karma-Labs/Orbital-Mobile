---
name: ecies-key-wipe-migration
description: Migration 024 wiped all v1 ECIES keys; without self-wrap endpoint (issue #14) this creates unrecoverable state for production users — acceptable for test data only
metadata:
  type: project
---

## ECIES Key Wipe — Migration 024

Migration 024 performed a destructive wipe of all v1 ECIES-wrapped group keys. This was necessary for the v2 ECIES format upgrade (XEdDSA auth, HKDF binding).

### Risk Assessment

- **Without a self-wrap endpoint** (tracked as issue #14), users who run this migration lose access to all previously-encrypted group messages. There is no recovery path — the old ECIES-wrapped keys are deleted, and the v1 format cannot be re-derived from the new v2 parameters.
- **Acceptable for current state:** All existing data is test data. No production users exist yet.
- **Before production launch:** Issue #14 (self-wrap / key re-encryption endpoint) MUST be implemented, or an alternative migration strategy that re-wraps existing keys in v2 format must be provided.

### Audit Implications

- If this migration ships to production users with real data, it is a **Critical** data-loss vulnerability (permanent loss of message decryption capability).
- The migration itself is irreversible — no down-migration path for the deleted keys.
- The `self-wrap` endpoint (issue #14) would allow the client to re-encrypt its own group keys under the new format before the migration runs.

**Why:** Destructive migrations of crypto material are acceptable during pre-production but become Critical severity in production. This needs explicit gating or resolution before any production deployment.
**How to apply:** Before any beta/production release milestone, verify issue #14 is resolved or this migration is guarded by a pre-production-only gate. See [[project-ecies-construction]] for the v2 format details.
