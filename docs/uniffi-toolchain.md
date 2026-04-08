# uniffi-bindgen-react-native Toolchain

Setup and usage guide for the Rust-to-React-Native binding toolchain.

## Project Structure

The Rust crate and generated bindings live in a separate library package, consumed by the app as a local dependency:

```
packages/
  orbital-signal/
    package.json          # Library package (name: orbital-signal)
    ubrn.config.yaml      # uniffi-bindgen-react-native config
    react-native.config.js
    OrbitalSignal.podspec  # Generated CocoaPods spec
    rust/
      orbital_signal/     # Rust wrapper crate
        Cargo.toml
        src/lib.rs
    src/                  # Generated TypeScript bindings (committed)
    cpp/                  # Generated C++ bindings (committed)
    ios/                  # Generated iOS module code (committed)
    android/              # Generated Android module code (committed)
    build/                # Compiled xcframework (gitignored, rebuilt locally)
```

The app depends on this via `"orbital-signal": "file:./packages/orbital-signal"` in the root `package.json`.

## Prerequisites

1. **Rust** (pinned in `rust-toolchain.toml`):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
   The `rust-toolchain.toml` at project root pins the exact version and cross-compilation targets. Running any `cargo` command from the project root will auto-install them.

2. **Xcode** (for iOS builds):
   Full Xcode installation required (not just Command Line Tools) — needed for `xcodebuild -create-xcframework`.

3. **Android NDK** (for Android builds only):
   ```bash
   export ANDROID_NDK_HOME=$ANDROID_SDK_ROOT/ndk/27.1.12297006/
   ```
   Install via Android Studio SDK Manager. The NDK version must match `ndkVersion` in `android/build.gradle`.

4. **CocoaPods** (for iOS):
   ```bash
   gem install cocoapods
   ```

## Running Codegen

### Build for iOS (compiles Rust + generates bindings)
```bash
npm run build:rust:ios
```

### Build for Android
```bash
npm run build:rust:android
```

### Build both
```bash
npm run build:rust
```

### Manual (from packages/orbital-signal/)
```bash
cd packages/orbital-signal
npx ubrn build ios --config ubrn.config.yaml --and-generate
npx ubrn build android --config ubrn.config.yaml --and-generate
```

## When to Re-run Codegen

Re-run after any changes to:
- `packages/orbital-signal/rust/orbital_signal/src/lib.rs` (or any Rust source file)
- `packages/orbital-signal/ubrn.config.yaml`
- `packages/orbital-signal/rust/orbital_signal/Cargo.toml` (dependency changes)

Generated bindings are **committed to git** for reproducible builds. After re-running codegen, commit the updated generated files.

## Generated Files

| Directory (relative to packages/orbital-signal/) | Contents | Committed? |
|-----------|----------|------------|
| `src/generated/` | TypeScript bindings | Yes |
| `src/index.tsx` | Entry point re-exports | Yes |
| `src/NativeOrbitalSignal.ts` | Turbo Module spec | Yes |
| `cpp/generated/` | C++ bindings | Yes |
| `cpp/orbital-signal.*` | C++ Turbo Module | Yes |
| `ios/OrbitalSignal.*` | iOS native module | Yes |
| `OrbitalSignal.podspec` | CocoaPods spec | Yes |
| `rust/orbital_signal/target/` | Rust build cache | No (gitignored) |
| `build/` | Compiled xcframework | No (gitignored) |

## Version Pinning

| Component | Version | Location |
|-----------|---------|----------|
| uniffi-bindgen-react-native | 0.31.0-2 | `packages/orbital-signal/package.json` |
| uniffi (Rust crate) | 0.31.0 | `packages/orbital-signal/rust/orbital_signal/Cargo.toml` |
| Rust toolchain | 1.94.1 | `rust-toolchain.toml` |

The uniffi npm and Rust crate versions **must stay in sync**. Both are on the 0.31.x line.

## Troubleshooting

**"cargo not found"** — Install Rust via rustup (see Prerequisites). Ensure `~/.cargo/bin` is in your PATH.

**iOS build fails with "xcodebuild requires Xcode"** — Install full Xcode from the App Store, then run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.

**iOS build fails with missing targets** — Run `rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim` or let `rust-toolchain.toml` handle it.

**Android build fails with NDK errors** — Ensure `ANDROID_NDK_HOME` is set and the NDK version matches `android/build.gradle`.

**"ContractVersionMismatch"** — The uniffi npm package and Rust crate versions are out of sync. Ensure both are on 0.31.x.

**"missing field `repository`"** — The library's `package.json` must have a `repository` field (ubrn CLI requires it).

## Cross-Compilation Targets

| Target | Platform | ABI | Build Script |
|--------|----------|-----|-------------|
| `aarch64-apple-ios` | iOS device | ARM64 | `scripts/build-ios.sh` |
| `aarch64-apple-ios-sim` | iOS simulator (Apple Silicon) | ARM64 | `scripts/build-ios.sh` |
| `x86_64-apple-ios` | iOS simulator (Intel) | x86_64 | `scripts/build-ios.sh` |
| `aarch64-linux-android` | Android device/emulator | arm64-v8a | `scripts/build-android.sh` |
| `x86_64-linux-android` | Android emulator | x86_64 | `scripts/build-android.sh` |

ARM32 (`armv7-linux-androideabi`) is intentionally excluded — <5% of modern Android devices, and it doubles build time.

### Binary Sizes (debug, per target)

| Target | Static lib (.a) | Notes |
|--------|----------------|-------|
| aarch64-apple-ios | ~19 MB | Debug build with libsignal |
| aarch64-apple-ios-sim | ~19 MB | |
| x86_64-apple-ios | ~19 MB | |
| iOS simulator lipo (combined) | ~37 MB | arm64 + x86_64 |
| Android arm64-v8a | ~19 MB (est.) | .so via cargo-ndk |
| Android x86_64 | ~19 MB (est.) | |

Release builds with LTO will be significantly smaller. Exact sizes TBD after release build optimization.

### Build Times (CI, self-hosted macOS ARM64)

| Step | Time | Notes |
|------|------|-------|
| Rust for Android (2 targets) | ~8 min | First build; cached rebuilds ~2 min |
| Rust for iOS (3 targets) | ~10 min (est.) | Includes xcframework bundling |
| Gradle assembleDebug | ~3 min | After Rust build |
| Xcode build | ~5 min (est.) | After pod install |

## Architecture

```
TypeScript (React Native App)
    |
    | import { helloOrbital } from 'orbital-signal'
    v
packages/orbital-signal/
    |
    | Generated bindings (src/generated/)
    v
C++ Turbo Module (cpp/)
    |
    | JSI bridge (Hermes)
    v
orbital_signal (Rust static lib)
    |
    | uniffi proc macros
    v
libsignal-protocol v0.83.0
```

## References

- [uniffi-bindgen-react-native](https://github.com/jhugman/uniffi-bindgen-react-native) (Mozilla-backed)
- [Mozilla announcement](https://hacks.mozilla.org/2024/12/introducing-uniffi-for-react-native-rust-powered-turbo-modules/)
- [uniffi-rs](https://github.com/mozilla/uniffi-rs) (upstream)
