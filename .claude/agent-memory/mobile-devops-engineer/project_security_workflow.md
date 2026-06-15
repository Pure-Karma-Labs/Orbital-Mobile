---
name: project_security_workflow
description: Security scanning workflow (Phase 1) -- SHA pins, design decisions, known gotchas
metadata:
  type: project
---

Security workflow added in branch ci/security-workflow-phase1 (commit b1a975f).
Files: .github/workflows/security.yml, .github/dependabot.yml

**Why:** Phase 1 of the approved security-CI plan. Establishes scanning baseline before Phase 2 hardens rules.

**How to apply:** When refreshing pins quarterly or extending to Phase 2, see SHA table below and the inline TODO comments in security.yml.

## SHA Pin Table (as of 2026-06-10)

| Action | SHA | Tag | Notes |
|---|---|---|---|
| trufflesecurity/trufflehog | d411fff7b8879a62509f3fa98c07f247ac089a51 | v3.95.5 | lightweight tag |
| dorny/paths-filter | fbd0ab8f3e69293af611ebaee6363fc25e6d187d | v4.0.1 | lightweight tag |
| Swatinem/rust-cache | c19371144df3bb44fab255c43d04cbc2ab54d1c4 | v2.9.1 | annotated tag -- use dereferenced commit SHA, not tag-object SHA (23869a5b) |
| taiki-e/install-action | 899b013517f9e7774591216672bf75a46bb9a481 | v2.9.4 | lightweight tag |
| semgrep/semgrep (Docker) | N/A (image tag) | 1.165.0 | container image, not an action |

## Key Design Decisions

1. **npm-audit threshold: critical-only on PR/push.**
   RN dependency tree has chronic high-severity advisories in unreachable dev-adjacent deps.
   Gating on high would normalize red CI and train the team to ignore it.
   Full all-severity audit runs report-only on Monday schedule.

2. **Semgrep continue-on-error: true (Phase 1).**
   Burn-in period to establish false-positive baseline.
   TODO comment in file: Phase 2 removes this after vendoring confirmed true-positive rules into .github/semgrep-rules/.

3. **rust-test/rust-audit on ubuntu-latest with RUSTUP_TOOLCHAIN override.**
   rust-toolchain.toml lists 5 Apple/Android targets that break Linux setup.
   RUSTUP_TOOLCHAIN=1.94.1 env var overrides it without modifying the file.
   If the first run still attempts Apple targets, fallback: rustup override set 1.94.1 && rustup target add x86_64-unknown-linux-gnu.

4. **paths-filter no-ops on schedule events.**
   Schedule events have no diff context, so paths-filter outputs empty strings.
   rust-test/rust-audit if-guards explicitly check schedule/workflow_dispatch BEFORE checking needs.changes.outputs.rust to avoid silently skipping scheduled runs.

5. **libsignal-check: report-only, never fails.**
   cargo-audit cannot see git-dep advisories (libsignal is a git-dep, not crates.io).
   Weekly check compares pinned tag vs latest upstream tag, files a GH issue if behind.
   Issues-write permission scoped only to the libsignal-check job (workflow default is contents: read).

6. **Swatinem/rust-cache save-if: main only.**
   Avoids cache thrash across PR branches -- only main writes the shared cache.

## Dependabot Config

Three ecosystems, all weekly:
- npm at /
- cargo at /packages/orbital-signal/rust/orbital_signal
- github-actions at /
