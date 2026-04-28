---
name: Established security patterns — Phase 1
description: Five mandatory security patterns validated during Phase 1 audit that must be preserved in all future crypto code
type: feedback
---

## Established Security Patterns (Phase 1)

These patterns were validated and confirmed correct during the Phase 1 security audit. Any regression is a security finding.

1. **`BEGIN IMMEDIATE` for all crypto transactions** — Never use `BEGIN TRANSACTION` or bare `BEGIN` for operations touching Signal Protocol state. `BEGIN IMMEDIATE` acquires a reserved lock immediately, preventing TOCTOU races in the preloaded store architecture.
   **Why:** F-03 found `BEGIN TRANSACTION` in three places in `keyGenerationService.ts`. With SQLCipher WAL mode and the preloaded store pattern (read from SQLCipher -> process in Rust -> write back), a deferred lock allows another operation to interleave between read and write-back.
   **How to apply:** Flag any new `BEGIN TRANSACTION` or `BEGIN` (without IMMEDIATE) in crypto or Signal Protocol code as High severity.

2. **Per-address lock map for operation serialization** — All protocol operations to the same address (recipient) must be serialized. No concurrent encrypt/decrypt for the same session.
   **Why:** The Double Ratchet is stateful — concurrent operations would corrupt ratchet state. React Native's single JS thread helps, but async yields between read and write-back can still interleave.
   **How to apply:** When reviewing message encryption/decryption, verify that operations to the same recipient cannot run concurrently.

3. **No private key material in FFI Result types** — Only public keys should cross the Rust/TS boundary in function return values. Private keys stay in Rust or go directly to secure storage.
   **Why:** The FFI boundary is a serialization point — private key material transiting through JS heap increases exposure surface, especially with the preloaded store pattern.
   **How to apply:** Review any new uniffi function signatures. If a return type contains private key bytes, flag as High.

4. **No console.log in crypto code paths** — Zero console.log/warn/error in `src/services/crypto/`.
   **Why:** Console output on mobile can be captured by system logs, crash reporters, and diagnostic tools. Crypto state in logs is a data leak vector.
   **How to apply:** Grep `src/services/crypto/` for console.* in any PR touching that directory. Any match is Medium severity.

5. **Pre-key consumption atomicity** — Session creation + identity key trust check + pre-key deletion must happen in a single `BEGIN IMMEDIATE` transaction.
   **Why:** Partial completion (e.g., session saved but pre-key not deleted) would allow pre-key reuse, breaking forward secrecy guarantees.
   **How to apply:** When reviewing session establishment code, verify all three operations are within the same transaction boundary.
