# API Integration Engineer Memory Index

- [Issue #92 cleanup findings](issue-92-cleanup-findings.md) — API client cleanup items from Phase 1
- [Media upload pipeline (2026-05-14)](project_media_upload_pipeline.md) — End-to-end upload flow, Hermes Blob workaround, backend contract, DB guard pattern
- [processMediaMetadata pattern](project_process_media_metadata.md) — 7 call sites, session dedup Set, store-before-DB invariant
- [DB resilience pattern](project_db_resilience_pattern.md) — isDatabaseInitialized() guard for Metro Fast Refresh; fall through to store-only
- [Media download service](project_media_download_service.md) — Download/decrypt/cache pipeline with semaphore, inflight dedup, atomic writes
- [Media state ownership](project_media_state_ownership.md) — Upload service owns initial state; Zustand authoritative at runtime; DB for persistence
- [Client 429 retry](project_429_retry_client.md) — Global 429 retry in _executeRequest: 3 retries, exp backoff capped 10s, distinct from uploadChunk retry
- [Push device endpoints](project_push_device_endpoints.md) — Device register/deregister API, content-free push payloads, backend dispatch hooks
