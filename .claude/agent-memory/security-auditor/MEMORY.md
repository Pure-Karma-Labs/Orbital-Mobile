# Security Auditor Memory Index

- [Established security patterns (2026-04-09)](security_patterns_phase1.md) — 5 mandatory patterns: BEGIN IMMEDIATE, per-address locks, no privkey in FFI, no console in crypto, pre-key atomicity
- [Preloaded store architecture (2026-04-09)](preloaded_store_architecture.md) — uniffi 0.31 forces preloaded store (3/5 security); identity key migration to Keychain completed (PR #83)
- [Audit coverage — Phase 1 complete (2026-04-09)](audit_coverage.md) — 8 PRs reviewed, 14 findings (all Critical/High resolved), 23 positive verifications, clean for Phase 2
- [Resolved findings (2026-04-09)](resolved_findings_phase1.md) — 19 verified fixes across PRs #41, #45, #47, #50, #51, #69, #83, #84; all Critical/High resolved
- [Open security items (2026-04-09)](open_security_items.md) — 0 Critical/High remaining; 5 Medium/Low deferred to Phase 2-3
- [Phase 2 audit coverage (2026-05-14)](audit_coverage_phase2.md) — Media upload pipeline, attachment crypto FFI, backend fixes; 10 positive verifications, 5 open items
