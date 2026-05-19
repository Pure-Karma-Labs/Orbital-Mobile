---
name: project-sqlcipher-quoting-bug
description: op-sqlite wraps encryptionKey in single quotes at C++ bridge layer; double-quoting with x'...' caused 0-byte DB with no WAL/SHM — silent data loss
metadata:
  type: project
---

## SQLCipher 0-byte DB Bug (resolved 2026-05-18, commit `5102ac6`)

### Root Cause

op-sqlite's C++ bridge (`cpp/bridge.cpp`) issues `PRAGMA key = '<encryptionKey>'` — wrapping the value in single quotes. Our code passed `x'<hex>'` as the encryption key, producing:

```
PRAGMA key = 'x'<hex>''
```

This broke SQL quoting. SQLCipher silently fell back to an unencrypted in-memory mode. The `orbital.db` file was always 0 bytes with no WAL (`-wal`) or SHM (`-shm`) files.

### Symptoms

- Database operations appeared to work (queries returned data within the same session)
- App data disappeared on every restart
- `orbital.db` was 0 bytes on disk
- No WAL or SHM files created alongside the DB file

### Fix

Pass the hex string directly to `open({ encryptionKey: hexString })` without any `x'...'` wrapper. SQLCipher receives the passphrase through `PRAGMA key = '<hexString>'` and uses PBKDF2 key derivation in passphrase mode.

File: `src/database/connection.ts:25`

### Detection

This bug is invisible to functional tests because SQLite operations succeed against the in-memory database. Only persistence tests (kill app, relaunch, verify data) or file system checks (verify DB file size > 0) can catch it.

**Why:** Third-party native module bridge implementations add their own formatting/escaping that is not visible from the TypeScript API surface. The op-sqlite `encryptionKey` option's C++ implementation determines the actual PRAGMA syntax.

**How to apply:** When wrapping any native module that handles sensitive configuration (encryption keys, connection strings), verify how the bridge layer formats parameters before adding application-level escaping. Read the module's native source (C++/ObjC/Java), not just the TypeScript/JS API docs. See also [[security-patterns-phase1]] pattern 11.
