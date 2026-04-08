---
name: Cross-compilation setup for 5 mobile targets
description: Target configuration, toolchain pins, and CI caching strategy for building orbital_signal across iOS and Android
type: project
---

Issue #9 established cross-compilation for all 5 targets on 2026-04-07.

**Targets and tooling:**
- iOS: aarch64-apple-ios, aarch64-apple-ios-sim, x86_64-apple-ios (built by ubrn via cargo directly)
- Android: arm64-v8a, x86_64 (built by ubrn via cargo-ndk v4.1.2)
- Rust toolchain: 1.94.1 pinned in rust-toolchain.toml at repo root
- Android NDK: 27.1.12297006 (must match CI runner's installed version)

**Build commands:**
- `cd packages/orbital-signal && npm run build:ios` (wraps `ubrn build ios --config ubrn.config.yaml --and-generate`)
- `cd packages/orbital-signal && npm run build:android` (wraps `ubrn build android --config ubrn.config.yaml --and-generate`)

**Release profile:** thin LTO, codegen-units=1, strip=symbols (Cargo.toml [profile.release])

**CI caching:** .github/workflows/build.yml caches ~/.cargo/registry, ~/.cargo/git, and packages/orbital-signal/rust/orbital_signal/target keyed by Cargo.lock + rust-toolchain.toml hash. Separate cache keys for iOS and Android builds.

**Why this matters:** First clean build is slow (5-10 min) due to BoringSSL. Caching brings incremental builds to ~1-2 min. The self-hosted macOS ARM64 runner handles both iOS and Android builds.

**How to apply:** When modifying the Rust crate, test with `cargo test` locally first (fast), then trigger CI for full cross-compilation validation.
