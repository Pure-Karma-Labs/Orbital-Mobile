# Security Auditor Memory Index

- [ECIES construction (2026-05-22)](project_ecies_construction.md) — X25519 + AES-256-GCM + HKDF-SHA256 + XEdDSA; 190-byte wire format; channel binding; small-order rejection
- [Zero-knowledge group key model (2026-05-22)](project_zk_group_key_model.md) — Per-member ECIES wrapping; backend stores only ciphertext; send wired, receive scaffolded
- [PR #157 ECIES wrap audit (2026-05-22)](audit_pr157_ecies_wrap.md) — 2 Critical + 2 High resolved (XEdDSA, HKDF binding, sender key, envelope validation); 2 Medium deferred
- [Resolved findings (2026-05-22)](resolved_findings_phase1.md) — 26 verified fixes; all Critical/High resolved including ECIES wrapping auth + binding
- [Open security items (2026-05-22)](open_security_items.md) — 0 Critical/High; 13 Medium/Low including ECIES format downgrade, WS stubs, TOFU safety numbers
- [Established security patterns (2026-05-20)](security_patterns_phase1.md) — 14 mandatory patterns: push payload allowlist, deep link type switch, image onError retry counter
- [Phase 2 audit coverage (2026-05-22)](audit_coverage_phase2.md) — Media pipelines, attachment crypto, push notifications, ECIES wrapping; 36 positive verifications
- [Push notification security audit (2026-05-20)](phase2_push_notification_audit.md) — Zero-knowledge payloads, IDOR fix, rate limiting, deep link safety
- [Preloaded store architecture (2026-04-09)](preloaded_store_architecture.md) — uniffi 0.31 preloaded store; identity key migration to Keychain (PR #83)
- [Audit coverage — Phase 1 complete (2026-04-09)](audit_coverage.md) — 8 PRs reviewed, 14 findings, 23 positive verifications
- [Phase 2 PRs #129 #132 #138 #137 audit (2026-05-19)](audit_2026_05_19.md) — key zeroization, identityChanged gap, SQL allowlist, File Library
- [Backend rate-limit config](reference_backend_ratelimit.md) — express-rate-limit v7 needs validate.xForwardedForHeader:false behind nginx
- [Backend deploy procedure](reference_backend_deploy.md) — prod at 134.199.230.235, pm2 managed, git pull + migrate + restart
- [SQLCipher quoting bug (2026-05-18)](project_sqlcipher_quoting_bug.md) — op-sqlite wraps key in single quotes; never pre-quote
- [FK constraint follow-up #149](project_fk_constraint_followup.md) — orbital_media FK constraints cause errors; #149 will drop constraints
- [Image onError retry counter](feedback_image_onerror_retry.md) — useRef counter (max 1) to prevent infinite render loops
