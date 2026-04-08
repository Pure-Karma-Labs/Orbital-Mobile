---
name: Rust cross-compilation CI setup
description: Key decisions, known pitfalls, and runner config from Issues #7/#9, PR #31
type: project
---

Rust cross-compilation CI was implemented in PR #31 (Issues #7 and #9). Covers all 5 mobile targets: 3 iOS (aarch64-apple-ios, aarch64-apple-ios-sim, x86_64-apple-ios) and 2 Android (aarch64-linux-android, x86_64-linux-android). ARM32 intentionally excluded.

**Why:** uniffi-bindgen-react-native requires Rust artifacts built before pod install (iOS) and Gradle (Android). CI step ordering is critical — ubrn build must run before any platform build tool.

**How to apply:** When adding new CI steps or dependencies, keep the ubrn build step immediately before the platform build tool (Gradle / xcodebuild). Always include rust-toolchain.toml in Rust cache key inputs.

---

## Runner Environment (alexg-mac, ARM64)

- Android SDK: `brew install --cask android-commandlinetools` — installed at `/opt/homebrew/share/android-commandlinetools`
- NDK version: 27.1.12297006 (at `$ANDROID_HOME/ndk/27.1.12297006`)
- Java: `brew install openjdk@17` — Temurin cask requires sudo which self-hosted runner lacks
- Rust: installed via rustup at `$HOME/.cargo`
- Self-hosted runner cache is local disk only — won't warm a second runner if one is ever added

## Pipeline Architecture

Android builds run on all PRs. iOS builds run on main only (expensive, ~45 min timeout vs 30 for Android).

Build flow per platform:
1. Checkout
2. Configure SDK env vars (Android: auto-detect from known paths)
3. Setup Rust + add targets
4. Setup Node + npm ci
5. Restore Rust cache (keyed on Cargo.lock + rust-toolchain.toml)
6. ubrn build (cargo cross-compilation + binding generation)
7. Platform build tool (Gradle assembleDebug / xcodebuild)

Library package lives at `packages/orbital-signal/`. App consumes it via `file:` dependency in root package.json.

## Key Pitfalls

1. **Tilde expansion fails in GitHub Actions `env:` blocks** — use `$HOME` or runtime detection, never `~`. The Android SDK Configure step uses a shell loop for exactly this reason.

2. **cargo-ndk v3.5.7 was yanked** — pinned to v4.1.2 in build.yml. Always check crates.io for latest non-yanked version before pinning.

3. **`cargo install cargo-ndk || true` silently swallows failures** — the current build.yml uses `cargo install cargo-ndk@4.1.2` without `|| true`, which is correct. Don't add `|| true` back.

4. **NDK path in ANDROID_NDK_HOME is hardcoded** in build.yml (`ndk/27.1.12297006`) but auto-discovered via `find` in build-android.sh. If the NDK version on the runner changes, both places must be updated together. Check `android/app/build.gradle` ndkVersion before hardcoding.

5. **Cache step order** — Setup Rust runs before Cache Rust restore in both jobs. A cold cache triggers redundant rustup work. Ideally Cache step should come before Setup Rust, but this is a minor inefficiency, not a correctness issue.

6. **ubrn CLI invocation** — build scripts call `npx ubrn` (correct for a local dep). The npm scripts in packages/orbital-signal/package.json also use `npx ubrn`. Do not strip `npx` — ubrn is not guaranteed to be on PATH.

## Build Time Benchmarks

- Lint/typecheck/test (ci.yml): ~1.5 min
- Android Rust cross-compilation: ~8-9 min (cold); cached subsequent runs significantly faster
- Full Android debug build: within 30 min timeout
- Full iOS debug build: within 45 min timeout

## Caching Strategy

| Cache | Key inputs | Path |
|---|---|---|
| Rust (Android) | Cargo.lock + rust-toolchain.toml | ~/.cargo/registry, ~/.cargo/git, packages/orbital-signal/rust/orbital_signal/target |
| Rust (iOS) | Cargo.lock + rust-toolchain.toml | same as above |
| Gradle | gradle-wrapper.properties + *.gradle + gradle.properties | ~/.gradle/caches, ~/.gradle/wrapper |
| CocoaPods | Podfile.lock + Podfile | ios/Pods, ~/Library/Caches/CocoaPods |
| npm | package-lock.json (via setup-node cache: npm) | managed by action |
