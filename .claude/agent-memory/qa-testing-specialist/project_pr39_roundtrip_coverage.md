---
name: PR #39 roundtrip test coverage findings
description: Test coverage analysis for PR #39 — Issue #11 PoC encrypt/decrypt round-trip Rust tests and Jest mocks
type: project
---

PR #39 adds `testEncryptDecryptRoundtrip` / `testEncryptDecryptRoundtripN` functions plus 3 new Rust integration tests and 2 Jest mock tests.

Key findings:

**Rust types (types.rs):**
- `RoundtripResult.elapsed_ms` is `u64`
- `RoundtripBatchResult.total_elapsed_ms` and `avg_elapsed_ms` are both `u64`
- `ciphertext_len` is `u32`
- `success_count` is `u32`

**BigInt correctness in Jest mocks:**
- `elapsedMs: BigInt(42)` in testEncryptDecryptRoundtrip mock — CORRECT, u64 maps to bigint via uniffi
- `totalElapsedMs: BigInt(420)`, `avgElapsedMs: BigInt(42)` — CORRECT
- The Jest tests only check `toHaveProperty` without asserting typeof, so the BigInt type is not verified by the test assertions

**Jest test for testEncryptDecryptRoundtripN passes `iterations: number` but the Rust type is `u32`:**
- uniffi maps `u32` to `number` in TS, so this is fine
- However, mock return has `successCount` matching `iterations` (10), not derived from actual iteration logic

**Gaps identified:**
1. No large payload test in Rust (only 22-byte "Hello Signal Protocol!", empty, 11-byte "repeat test")
2. `_repeated` uses 5 iterations — acceptable for a PoC but should be increased to 50-100 for performance baselines
3. No error-path test — the functions return `Result<_, SignalError>` but no test exercises the failure branch
4. Jest: `typeof result.elapsedMs === 'bigint'` never asserted; only `toHaveProperty` shape check
5. Jest: `testEncryptDecryptRoundtripN` mock ignores `_plaintext` entirely — mock plausibility is weak
6. `test_encrypt_decrypt_roundtrip_empty` has no assertion on `ciphertext_len > 0` or `elapsed_ms`; both could be zero without detection
7. Timeout assertion in `_basic` uses 30_000ms (30s) — very loose; a real performance regression would pass undetected

**Why:** This is a PoC, so the bar is deliberately lower. The critical gaps are the missing error case and the loose BigInt type assertion in Jest.
**How to apply:** In follow-up issues, recommend: error-path test (corrupt ciphertext), large payload Rust test (1MB), tighter elapsed_ms bound, and typeof bigint assertion in Jest.
