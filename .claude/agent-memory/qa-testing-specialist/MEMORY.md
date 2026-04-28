# QA Testing Specialist Memory Index

- [PR #35 test coverage findings](project_pr35_test_gaps.md) — DeviceId validation has no test; `to_protocol_address` is dead code with `#[allow(dead_code)]`, no test needed yet
- [PR #39 roundtrip test coverage findings](project_pr39_roundtrip_coverage.md) — BigInt shape not typeof-asserted in Jest; no error-path test; _repeated uses 5 iterations; no large payload Rust test
