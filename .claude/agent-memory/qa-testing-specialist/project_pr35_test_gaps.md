---
name: PR #35 test coverage gaps
description: Test coverage analysis for PR #35 Rust fixes — DeviceId validation gap, dead code status of to_protocol_address
type: project
---

PR #35 fixes: generate_kyber_pre_key returns KyberPreKeyResult, DeviceId validation errors instead of clamping, removal of addr_to_data/data_to_addr aliases.

Key findings:
- `to_protocol_address` is marked `#[allow(dead_code)]` and `store_adapters` module is `#[allow(dead_code)]` in lib.rs — the function is not yet reachable from any public API. No test needed until store adapters are activated.
- `create_protocol_address` in util.rs does NOT use `to_protocol_address` — it constructs a plain ProtocolAddressData struct with no validation. The DeviceId validation only fires when store adapters call `to_protocol_address`, which is currently dead code.
- The one integration test for `create_protocol_address` (test_create_protocol_address) passes device_id=1, which is valid, but does not test the error path because that path is not yet reachable from the public API.

**Why:** When store adapters are activated (unblocked by uniffi FfiConverterArc), `to_protocol_address` becomes live and the validation gap matters.
**How to apply:** File a follow-up issue for DeviceId boundary tests to be added when store adapters are activated.
