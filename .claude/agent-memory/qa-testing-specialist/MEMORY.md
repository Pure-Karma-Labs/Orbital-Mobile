# QA Testing Specialist Memory Index

- [PR #35 test coverage findings](project_pr35_test_gaps.md) — DeviceId validation has no test; `to_protocol_address` is dead code with `#[allow(dead_code)]`, no test needed yet
- [PR #39 roundtrip test coverage findings](project_pr39_roundtrip_coverage.md) — BigInt shape not typeof-asserted in Jest; no error-path test; _repeated uses 5 iterations; no large payload Rust test
- [Media Chunk 3 coverage fix](feedback_media_chunk3_coverage.md) — How we crossed the coverage thresholds after Media Chunk 3: mediaSlice + processMediaMetadata tests
- [FTS5 search test patterns](project_fuse_search_test_patterns.md) — PR #348 patterns: renderHook helper, debounce w/ fake timers, makeDb factory; gaps: error paths, conversationId change, search-active screen state
