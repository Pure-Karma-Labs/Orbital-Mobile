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
    OrbitalSignalFramework.xcframework/   # Compiled xcframework, both slices (gitignored, rebuilt locally)
    rust-profile-ios.txt  # iOS provenance marker: profile + input digest (gitignored)
    android/src/main/jniLibs/             # Compiled Android .a + rust-profile.txt (gitignored)
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

### Manual (from packages/orbital-signal/) — UNSUPPORTED
```bash
cd packages/orbital-signal
npx ubrn build ios --config ubrn.config.yaml --and-generate
npx ubrn build android --config ubrn.config.yaml --and-generate
```

A raw `ubrn build ios` does **not** write the iOS provenance marker
(`packages/orbital-signal/rust-profile-ios.txt`), so the next Xcode build fails the
**[Orbital] Verify Rust release profile** phase on a missing or digest-less marker (see
[Build Guards](#build-guards)). Use `npm run build:rust:ios` / `npm run build:rust:ios:release`.
The Android line likewise leaves `rust-profile.txt` untouched, so the Gradle gate reads
whichever profile the *previous* npm build recorded — stale, and wrong in both directions
(a raw debug build under a `release` marker passes; a Release variant under a missing or
`debug` marker fails). Use `npm run build:rust:android[:release]`.

## When to Re-run Codegen

Re-run after any changes to:
- `packages/orbital-signal/rust/orbital_signal/src/lib.rs` (or any Rust source file)
- `packages/orbital-signal/ubrn.config.yaml`
- `packages/orbital-signal/rust/orbital_signal/Cargo.toml` (dependency changes)

Generated bindings are **committed to git** for reproducible builds. After re-running codegen, commit the updated generated files.

Moving a dependency in `Cargo.toml` — including the libsignal git tag — now **requires**
regenerating and committing `Cargo.lock` in the same change. Every CI cargo invocation runs
`--locked` (#812), so a `Cargo.toml` edit without the matching lock update fails CI instead
of re-resolving the graph silently.

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
| `OrbitalSignalFramework.xcframework/` | Compiled xcframework (`ios-arm64/`, `ios-arm64_x86_64-simulator/`) | No (gitignored) |
| `rust-profile-ios.txt` | iOS provenance marker (profile + input digest) | No (gitignored) |
| `android/src/main/jniLibs/` | Compiled Android `.a` + `rust-profile.txt` | No (gitignored) |

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

**"error: cannot update the lock file ... because --locked was passed to prevent this"** —
`Cargo.lock` no longer matches `Cargo.toml`. Every CI cargo invocation, and ubrn's
`cargoExtras` on both platforms, pass `--locked` (#812), so a drifted lock is a hard failure
rather than a silent re-resolve. Regenerate the lock and **commit it**: from
`packages/orbital-signal/rust/orbital_signal`, either `cargo update -p <crate> --precise <version>`
or a plain `cargo check` without `--locked`, then commit `Cargo.lock`.

## Build Profiles

By default, `ubrn build` uses cargo's dev profile (unoptimized, debug symbols). For store
builds, use the `:release` script variants which pass `--release` to ubrn, triggering
the release profile configured in `Cargo.toml` (thin LTO, codegen-units=1, symbol stripping,
overflow-checks enabled).

### Commands

| Task | Dev (default) | Release (store builds) |
|------|--------------|----------------------|
| iOS only | `npm run build:rust:ios` | `npm run build:rust:ios:release` |
| Android only | `npm run build:rust:android` | `npm run build:rust:android:release` |
| Both platforms | `npm run build:rust` | `npm run build:rust:release` |
| Shell script | `./scripts/build-ios.sh` | `./scripts/build-ios.sh --release` |
| Shell script | `./scripts/build-android.sh` | `./scripts/build-android.sh --release` |

### Marker Files

Each build script writes a marker file recording the profile used:

| Platform | Marker path | Contents |
|----------|------------|----------|
| iOS | `packages/orbital-signal/rust-profile-ios.txt` | Line 1: `debug` or `release`. Then the `scripts/rust-input-digest.sh` output — one `<sha256>  <relpath>` line per Rust input. |
| Android | `packages/orbital-signal/android/src/main/jniLibs/rust-profile.txt` | `debug` or `release` |

Both markers are gitignored (iOS explicitly, Android via the `jniLibs/` pattern).

One script writes the iOS marker — `scripts/write-rust-marker-ios.sh <debug|release>` —
called by `build:ios`, `build:ios:release` **and** the test harness, so writer drift shows
up on a PR (`build-ios` only runs on main). It runs **after** a successful `ubrn build`:
ubrn runs an unlocked `cargo metadata` before compiling, which can itself rewrite
`Cargo.lock`, so the digest has to be taken afterwards to describe what was actually
compiled. The write is staged through a `.tmp` file and an atomic `mv`, and the `.tmp` is
removed on any failure, so a failed digest leaves no marker at all and the gate below fails
closed.

The npm scripts also `rm -f` the live marker *before* invoking ubrn. That is deliberate: if
ubrn dies part-way through rewriting the xcframework, a surviving marker could validate a
half-written artefact.

### Build Guards

Both platforms gate the compiled Rust before it links: the cargo profile must match the
build configuration, and the binaries must not be older than the Rust inputs. The two gates
are deliberately **asymmetric** — they agree on which inputs matter, not on how staleness is
detected:

| | Android (`android/check-rust-freshness.gradle`) | iOS (`scripts/verify-rust-profile-ios.sh`) |
|---|---|---|
| Staleness signal | file **mtime** vs the oldest `.a` | **sha256 content digest** vs the marker |
| Escape hatch | opt-in auto-rebuild (`orbital.autoRebuildRust=true`, commented out at `android/gradle.properties:47`) | none — always fails closed |
| Staleness check runs on | every Gradle build (`outputs.upToDateWhen { false }`) | every Xcode configuration |
| Profile check runs on | Release variants only | `CONFIGURATION=Release` only |

Freshness inputs:

| Input | Android | iOS | Required? |
|---|---|---|---|
| crate `src/**/*.rs` | yes | yes | yes |
| crate `Cargo.toml`, `Cargo.lock` | yes | yes | yes |
| root `rust-toolchain.toml` | yes | yes | yes |
| `packages/orbital-signal/ubrn.config.yaml` | — | yes | yes |
| `packages/orbital-signal/package.json` | — | yes | yes |
| crate `build.rs` | — | yes | optional |
| crate `.cargo/config.toml` | — | yes | optional |

The last four are gated on iOS only. Only `ubrn.config.yaml` is genuinely iOS-specific;
`package.json`, `build.rs` and `.cargo/config.toml` affect the Android `.a` identically,
but Android's mtime gate does not watch them yet — that coverage is deliberately deferred
with the Android-digest follow-up, not an assertion that they are iOS-specific.
`ubrn.config.yaml` selects the xcframework slices;
`package.json` is both the sole pin of the ubrn toolchain version (an exact spec, so the
root lockfile adds no pin of its own) and the home of the `build:ios` command lines, so a
ubrn bump — which regenerates the C++/TS glue and its uniffi checksums without touching a
single `.rs` file — or a new cargo `--features` flag invalidates the marker. Hashing the
root `package-lock.json` instead would drag ~1 MB of unrelated JS churn into the digest and
condemn a good xcframework on every Dependabot bump. The file is hashed whole, so an edit
that touches only its Android scripts or comment fields also invalidates the iOS marker.
That over-triggering is expected; the response is a rebuild, never removing the input.
The two **optional** inputs do not
exist today; they are hashed when present, their absence is not an error, and adding or
removing one changes the file set and so correctly invalidates the marker.

`tests/` is excluded on both platforms, as is `.cargo/audit.toml` on iOS: neither enters the
compiled artefacts, so that churn must not invalidate a good binary.

Security invariant 18 `[rust-provenance-locked]` asserts that both gates still **name** the
shared inputs in executable code (it strips comments first, so a gate's own header cannot
satisfy it) and that each still contains its comparison machinery. That both gates actually
**use** those inputs is proven behaviourally only on iOS, by the harness cases below; the
Android harness is profile-only, so Android's use is asserted, not tested.

1. **Android (Gradle):** The `checkRustBinaries` task in `android/check-rust-freshness.gradle`
   fails when either `.a` is missing, when any input's mtime is newer than the oldest `.a`,
   or when the task graph holds a Release variant task and `rust-profile.txt` does not read
   `release`. `outputs.upToDateWhen { false }` keeps it from being skipped. With
   `orbital.autoRebuildRust=true` it runs the matching
   `npm run build:rust:android[:release]` instead of failing.

2. **iOS (Xcode):** A `script_phase` in the Podfile named **[Orbital] Verify Rust release profile**
   runs `scripts/verify-rust-profile-ios.sh` before compilation. Four checks, in order:

   1. Both xcframework slices hold `liborbital_signal.a`
      (`packages/orbital-signal/OrbitalSignalFramework.xcframework/ios-arm64/` and
      `.../ios-arm64_x86_64-simulator/`).
   2. The marker exists **and** carries digest lines. A profile-only marker means the
      xcframework came from an old or raw `ubrn` invocation.
   3. Release configurations only: the marker's profile line must be `release`.
   4. **Every** configuration: recompute the digest and compare it with the marker's. A
      mismatch names the `changed:` / `added:` / `removed:` paths, then the rebuild command
      for the marker's own profile. See
      [release-builds.md](release-builds.md) for the failure text.

   The script's filename and the Xcode phase name both date from #541/#550, when the only
   check was the cargo profile. They are historical misnomers, kept deliberately so the
   staleness gate needed zero `ios/Podfile` or `project.pbxproj` churn.

   Because iOS compares content rather than mtimes, a bare `touch` — or a branch switch that
   restores identical bytes — no longer trips the gate. There is **no escape hatch**: iOS
   always fails closed and prints the command to run. Hand-editing the marker still defeats
   the check; this is a developer safety net against linking stale crypto, not a security
   boundary.

   `scripts/rust-input-digest.sh` is the single owner of the iOS input list. It emits one
   `<sha256>  <relpath>` line per input, `LC_ALL=C`-sorted by path and relative to the repo
   root, using `shasum -a 256` (present on macOS and on the ubuntu runners). It fails closed
   — non-zero, message on stderr — when the crate `src` directory is missing or holds no
   `*.rs` file, when a REQUIRED input is missing, or when `find`/`sort`/`shasum` fails; the
   Xcode phase then refuses the build rather than linking an unverified xcframework.

   `npm run test:rust-gate:ios` (`scripts/test-rust-profile-gate-ios.sh`) unit-tests all four
   checks across 25 cases, including one content-change case per input and one for each
   optional input appearing or changing. It is read-only — every case runs in a throwaway
   `mktemp -d` tree, written by the real marker writer — which is why it is part of
   `npm run gut-check`. The Android harness drives a real Gradle build and stays out.

   **One-time migration:** a marker written before the digest format existed holds only the
   profile line and fails check 2 once. A single `npm run build:rust:ios[:release]` rewrites
   it.

## Cross-Compilation Targets

| Target | Platform | ABI | Build Script |
|--------|----------|-----|-------------|
| `aarch64-apple-ios` | iOS device | ARM64 | `scripts/build-ios.sh` |
| `aarch64-apple-ios-sim` | iOS simulator (Apple Silicon) | ARM64 | `scripts/build-ios.sh` |
| `x86_64-apple-ios` | iOS simulator (Intel) | x86_64 | `scripts/build-ios.sh` |
| `aarch64-linux-android` | Android device/emulator | arm64-v8a | `scripts/build-android.sh` |
| `x86_64-linux-android` | Android emulator | x86_64 | `scripts/build-android.sh` |

ARM32 (`armv7-linux-androideabi`) is intentionally excluded — <5% of modern Android devices, and it doubles build time.

### Binary Sizes (per target)

| Target | Debug (.a) | Release (.a) | Reduction |
|--------|-----------|-------------|-----------|
| Android arm64-v8a | 135 MB | 42 MB | 3.2x |
| Android x86_64 | 141 MB | 44 MB | 3.2x |
| aarch64-apple-ios | ~19 MB | TBD | |
| aarch64-apple-ios-sim | ~19 MB | TBD | |
| x86_64-apple-ios | ~19 MB | TBD | |
| iOS simulator lipo (combined) | ~37 MB | TBD | |

Release profile: thin LTO, `codegen-units = 1`, `strip = "symbols"`, `overflow-checks = true`.
Android sizes measured from `ubrn build android --release` (issue #541). iOS release sizes
to be measured after the first iOS release build.

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
libsignal-protocol v0.104.0
```

## References

- [uniffi-bindgen-react-native](https://github.com/jhugman/uniffi-bindgen-react-native) (Mozilla-backed)
- [Mozilla announcement](https://hacks.mozilla.org/2024/12/introducing-uniffi-for-react-native-rust-powered-turbo-modules/)
- [uniffi-rs](https://github.com/mozilla/uniffi-rs) (upstream)
