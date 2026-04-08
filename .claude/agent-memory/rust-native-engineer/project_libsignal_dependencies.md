---
name: libsignal dependency configuration gotchas
description: Critical non-obvious dependency requirements for building libsignal-protocol v0.83.0 in the orbital_signal crate
type: project
---

libsignal-protocol is NOT published on crates.io. Must use git dependency pinned to tag.

**Why:** Signal does not publish libsignal-protocol as a standalone crate. The only way to depend on it is via git reference to https://github.com/signalapp/libsignal. Additionally, Signal maintains private forks of boring (BoringSSL) and curve25519-dalek that must be used via [patch.crates-io] to avoid duplicate symbol / version mismatch errors.

**How to apply:**
- Cargo.toml must have: `libsignal-protocol = { git = "https://github.com/signalapp/libsignal", tag = "v0.83.0" }`
- Also need: `libsignal-core` from the same git+tag for DeviceId, CurveError, etc.
- [patch.crates-io] MUST include:
  - `boring` and `boring-sys` from `signalapp/boring` tag `signal-v4.18.0`
  - `curve25519-dalek` from `signalapp/curve25519-dalek` tag `signal-curve25519-4.1.3`
- These patches are version-coupled to libsignal v0.83.0 — if upgrading libsignal, check what fork tags it uses in its own Cargo.toml
- First cargo build after clean takes 5-10 minutes due to BoringSSL compilation
