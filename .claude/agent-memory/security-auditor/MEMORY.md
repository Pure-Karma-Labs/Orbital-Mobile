# Security Auditor Memory Index

- [Established security patterns (2026-05-20)](security_patterns_phase1.md) — 14 mandatory patterns: includes push payload allowlist, deep link type switch, image onError retry counter
- [Preloaded store architecture (2026-04-09)](preloaded_store_architecture.md) — uniffi 0.31 forces preloaded store (3/5 security); identity key migration to Keychain completed (PR #83)
- [Audit coverage — Phase 1 complete (2026-04-09)](audit_coverage.md) — 8 PRs reviewed, 14 findings (all Critical/High resolved), 23 positive verifications, clean for Phase 2
- [Resolved findings (2026-05-18)](resolved_findings_phase1.md) — 22 verified fixes; all Critical/High resolved; includes SQLCipher quoting fix and envelope key distribution
- [Open security items (2026-05-20)](open_security_items.md) — 0 Critical/High remaining; 11 Medium/Low across Phase 1-2, Media Chunk 3, and Push Notifications
- [Phase 2 audit coverage (2026-05-20)](audit_coverage_phase2.md) — Media upload/download pipelines, attachment crypto FFI, push notifications, backend fixes; 28 positive verifications
- [Push notification security audit (2026-05-20)](phase2_push_notification_audit.md) — Zero-knowledge payloads, IDOR fix, rate limiting, deep link safety, APNs-via-FCM tradeoff
- [Backend rate-limit config](reference_backend_ratelimit.md) — express-rate-limit v7 needs validate.xForwardedForHeader:false behind nginx
- [SQLCipher quoting bug (2026-05-18)](project_sqlcipher_quoting_bug.md) — op-sqlite C++ bridge wraps key in single quotes; never pre-quote with x'...' or passphrase mode breaks silently
- [Phase 2 PRs #129 #132 #138 #137 audit (2026-05-19)](audit_2026_05_19.md) — key zeroization verified, identityChanged gap fixed, SQL allowlist, File Library reviewed
- [Image onError retry counter](feedback_image_onerror_retry.md) — Image auto-retry on corrupt files needs useRef counter (max 1) to prevent infinite render loops
- [FK constraint follow-up #149](project_fk_constraint_followup.md) — orbital_media FK constraints cause errors; saveMedia retries with null FKs; #149 will drop constraints
