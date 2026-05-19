# Security Auditor Memory Index

- [Established security patterns (2026-05-18)](security_patterns_phase1.md) — 11 mandatory patterns: includes envelope key distribution, op-sqlite quoting, path injection, atomic plaintext write, upload key preservation
- [Preloaded store architecture (2026-04-09)](preloaded_store_architecture.md) — uniffi 0.31 forces preloaded store (3/5 security); identity key migration to Keychain completed (PR #83)
- [Audit coverage — Phase 1 complete (2026-04-09)](audit_coverage.md) — 8 PRs reviewed, 14 findings (all Critical/High resolved), 23 positive verifications, clean for Phase 2
- [Resolved findings (2026-05-18)](resolved_findings_phase1.md) — 22 verified fixes; all Critical/High resolved; includes SQLCipher quoting fix and envelope key distribution
- [Open security items (2026-05-18)](open_security_items.md) — 0 Critical/High remaining; 10 Medium/Low across Phase 1-2 and Media Chunk 3
- [Phase 2 audit coverage (2026-05-15)](audit_coverage_phase2.md) — Media upload + download pipelines, attachment crypto FFI, backend fixes; 20 positive verifications, 6 open items
- [Backend rate-limit config](reference_backend_ratelimit.md) — express-rate-limit v7 needs validate.xForwardedForHeader:false behind nginx
- [SQLCipher quoting bug (2026-05-18)](project_sqlcipher_quoting_bug.md) — op-sqlite C++ bridge wraps key in single quotes; never pre-quote with x'...' or passphrase mode breaks silently
