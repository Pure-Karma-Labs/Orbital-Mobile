---
name: Preloaded store architecture — security constraints
description: uniffi 0.31 spike (Issue #58) confirmed preloaded store is the only viable architecture; security rating 3/5 with mandatory transaction and serialization requirements; identity key migration completed (PR #83)
type: project
---

## Confirmed Architecture: Preloaded Store (as of 2026-04-09)

### Decision Context

Issue #58 spike confirmed that **uniffi 0.31 cannot pass `Arc<dyn CallbackInterface>` as function parameters**. The preferred Option B (sync callbacks from Rust into TypeScript store impls) is not viable with the current toolchain.

The **preloaded store approach** is now the confirmed architecture: TypeScript reads all needed store data from SQLCipher, passes it to Rust as plain data, Rust runs the protocol operation in-memory, and returns updated state for TypeScript to persist.

### Security Rating: 3/5

The rating reflects that protocol state (keys, sessions, ratchet chains) briefly exists in JS heap memory rather than staying exclusively within Rust/native memory. This is an acceptable trade-off given the uniffi constraint, but imposes strict requirements below.

### Mandatory Security Requirements

These MUST be enforced during implementation review. Violations are High severity.

1. **Transaction wrapping by the caller**
   - TypeScript must wrap the entire protocol operation in `BEGIN IMMEDIATE ... COMMIT`.
   - The pattern is: BEGIN IMMEDIATE -> read store data -> call Rust -> write updated state -> COMMIT (or ROLLBACK on error).
   - Individual store implementations (`IdentityKeyStoreImpl`, `SessionStoreImpl`, etc.) do NOT wrap in transactions themselves — the caller provides the transaction boundary.
   - This ensures atomicity: if Rust succeeds but the write-back fails, the entire operation rolls back.

2. **Operation serialization**
   - All protocol operations to the same address (recipient) MUST be serialized — no concurrent encrypt/decrypt for the same session.
   - This is inherent to the Double Ratchet (concurrent operations would corrupt ratchet state) and is naturally mitigated by React Native's single JS thread.
   - However, if async operations yield between read and write-back, interleaving is still possible. The transaction wrapping with `BEGIN IMMEDIATE` provides the database-level lock that prevents this.

3. **Stale-snapshot mitigation**
   - Risk: TypeScript reads store data, another operation modifies it before write-back.
   - Mitigation: React Native's single JS thread + `BEGIN IMMEDIATE` (which acquires a write lock on read) + operation serialization make this safe.
   - If the architecture ever moves to multi-threaded (e.g., worklets, JSI threads), this mitigation breaks and must be re-evaluated as Critical.

4. **Identity key in Keychain/Keystore — RESOLVED (PR #83)**
   - The identity private key has been moved from the SQLCipher `items` table to iOS Keychain / Android Keystore with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`.
   - Cache-on-load pattern: key is read from Keychain once at startup and cached in memory for protocol operations. Cache cleared on logout.
   - Migration path handles upgrading from SQLCipher storage to Keychain.
   - The preloaded pattern still means the private key transits through JS to reach Rust, but at-rest storage is now hardware-backed.

### Anti-Patterns to Flag in Review

- Store impl that wraps its own read/write in a transaction (breaks caller's transaction boundary)
- Protocol operation that does not acquire `BEGIN IMMEDIATE` before reading store data
- Any use of `setTimeout` or `await` between store read and write-back that could yield to other protocol operations
- Identity private key logged, serialized to JSON, or passed through any channel other than the direct Rust FFI call

**Why:** The preloaded store is a security-sensitive architectural constraint forced by toolchain limitations. These requirements prevent the known risks (race conditions, partial updates, key exposure) from becoming exploitable vulnerabilities.
**How to apply:** Reference these requirements when reviewing any PR that implements or modifies Signal Protocol operations, store adapters, or the Rust FFI boundary. Any violation of requirements 1-3 is High severity.
