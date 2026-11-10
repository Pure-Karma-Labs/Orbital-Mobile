# uniffi-bindgen-react-native Toolchain

Setup and usage guide for the Rust-to-React-Native binding toolchain.

There are **two** ubrn packages, each wrapping one Rust crate:

| Package | Crate | What it is |
|---------|-------|------------|
| `packages/orbital-signal` | `orbital_signal` | libsignal wrapper (Signal Protocol, group keys) |
| `packages/orbital-archive-reader` | `orbital_archive_reader` | Hostile-input ZIP reader for Meta data exports (#920) |

Everything below is per-crate unless it says otherwise. The toolchain pin, the
pinned `uniffi-bindgen-react-native` and the uniffi Rust version are shared; the
build scripts, provenance markers and freshness gates exist once per crate.

## Project Structure

Each crate and its generated bindings live in their own library package, consumed
by the app as a local dependency:

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
        Cargo.lock
        src/lib.rs
    src/                  # Generated TypeScript bindings (committed)
    cpp/                  # Generated C++ bindings (committed)
    ios/                  # Generated iOS module code (committed)
    android/              # Generated Android module code (committed)
    OrbitalSignalFramework.xcframework/   # Compiled xcframework, both slices (gitignored, rebuilt locally)
    rust-profile-ios.txt  # iOS provenance marker: profile + input digest (gitignored)
    android/src/main/jniLibs/             # Compiled Android .a + rust-profile.txt (gitignored)

  orbital-archive-reader/
    package.json          # Library package (name: orbital-archive-reader)
    ubrn.config.yaml
    react-native.config.js
    OrbitalArchiveReader.podspec
    rust/
      orbital_archive_reader/
        Cargo.toml        # Own workspace root; no path/git/[patch] deps (see below)
        Cargo.lock
        src/              # ZIP reader modules
        tests/            # Hostile matrix + fixtures — deliberately NOT a freshness input
        .cargo/audit.toml # cargo-audit config — deliberately NOT a freshness input
    src/ cpp/ ios/ android/               # Generated bindings (committed)
    OrbitalArchiveReaderFramework.xcframework/  # Compiled xcframework, both slices (gitignored)
    rust-profile-ios.txt  # iOS provenance marker: profile + input digest (gitignored)
    android/src/main/jniLibs/             # Compiled Android .a + rust-profile.txt (gitignored)
```

The app depends on both via `"orbital-signal": "file:./packages/orbital-signal"`
and `"orbital-archive-reader": "file:./packages/orbital-archive-reader"` in the
root `package.json`.

### Two crates, one toolchain

Three things must stay single-valued across both packages, and security
invariant 18 `[rust-provenance-locked]` enforces each:

1. **One toolchain pin, at the repo root.** `rust-toolchain.toml` at the project
   root pins the channel and the cross-compilation targets for both crates. A
   `rust-toolchain*` file anywhere under `packages/**` is a **violation**: the
   two static libraries are linked into one app process and export ~1,805 shared
   uniffi/JNI symbols between them, so two pins would split the Android toolchain
   across those symbols — an ODR-style mismatch nobody sees until a device crash.
   The root pin is also an input to every freshness gate, so a per-crate override
   would additionally be undigested.
2. **One uniffi, resolved identically in both locks.** Both crates declare
   `uniffi = "0.31.0"` and both `Cargo.lock` files must resolve the **same**
   version (0.31.2 today). One pinned `uniffi-bindgen-react-native` generates
   both crates' bindings, and uniffi's metadata format and `UNIFFI_META` symbol
   layout are version-coupled: a split resolves green on CI and fails at runtime
   (or, on Android, during symbol extraction). A uniffi bump is therefore a
   deliberate two-crate lockstep edit.
3. **No `path =` / `git =` / `[patch` in the archive crate's `Cargo.toml`.** See
   [Freshness inputs](#freshness-inputs) for why either would defeat both gates.

## Prerequisites

1. **Rust** (pinned in `rust-toolchain.toml`):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
   The `rust-toolchain.toml` at project root pins the exact version and cross-compilation targets for **both** crates. Running any `cargo` command from the project root will auto-install them.

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

### Build both crates (compiles Rust + generates bindings)
```bash
npm run build:rust:ios       # both crates, then ONE trailing pod install
npm run build:rust:android   # both crates
npm run build:rust           # both crates, both platforms
```

### Build only the archive crate
```bash
npm run build:rust:archive:ios      # archive crate, then pod install
npm run build:rust:archive:android
npm run build:rust:archive
```

These are the commands the **archive** freshness gates name in their error
messages. There is no `build:rust:signal:*` pair: the signal gates still name
`build:rust:ios[:release]` / `build:rust:android[:release]`, which are now a
superset (they rebuild the archive crate too), so those gates' message strings
and the gate harness's expected-output cases stayed unchanged.

### Build one crate only (the per-package path, used by CI)
```bash
cd packages/orbital-signal         && npm run build:ios      # or build:android[:release]
cd packages/orbital-archive-reader && npm run build:ios      # or build:android[:release]
```

Each package's own `build:ios[:release]` / `build:android[:release]` are the
single-crate path: the root scripts above are thin wrappers over them, and the CI
Rust steps `cd` into a package and call them directly so each crate gets its own
cargo cache workspace. **Never run `npm install` inside a package** — both are
`file:` dependencies of the app root, so their one dependency
(`uniffi-bindgen-react-native`) resolves into the ROOT `package-lock.json` and
`ubrn` runs from the root `node_modules/.bin`.

### Manual (raw `ubrn` from a package directory) — UNSUPPORTED
```bash
cd packages/orbital-signal          # or packages/orbital-archive-reader
npx ubrn build ios --config ubrn.config.yaml --and-generate
npx ubrn build android --config ubrn.config.yaml --and-generate
```

A raw `ubrn build ios` does **not** write that package's iOS provenance marker
(`packages/<pkg>/rust-profile-ios.txt`), so the next Xcode build fails that
crate's **[Orbital] Verify Rust release profile** phase on a missing or
digest-less marker (see [Build Guards](#build-guards)). Use the npm scripts.
The Android line likewise leaves that package's `jniLibs/rust-profile.txt`
untouched, so the Gradle gate reads whichever profile the *previous* npm build
recorded — stale, and wrong in both directions (a raw debug build under a
`release` marker passes; a Release variant under a missing or `debug` marker
fails). Use `npm run build:rust:android[:release]` or
`npm run build:rust:archive:android[:release]`.

## When to Re-run Codegen

Re-run the affected crate's build after any changes to:
- `packages/<pkg>/rust/<crate>/src/**/*.rs` (any Rust source file)
- `packages/<pkg>/ubrn.config.yaml`
- `packages/<pkg>/rust/<crate>/Cargo.toml` (dependency changes)
- `packages/<pkg>/package.json` (the ubrn pin or the build command lines)
- the repo-root `rust-toolchain.toml` (affects **both** crates)

Generated bindings are **committed to git** for reproducible builds. After re-running codegen, commit the updated generated files.

Moving a dependency in either `Cargo.toml` — including the libsignal git tag —
now **requires** regenerating and committing that crate's `Cargo.lock` in the
same change. Every CI cargo invocation runs `--locked` (#812), so a `Cargo.toml`
edit without the matching lock update fails CI instead of re-resolving the graph
silently.

## Generated Files

`packages/orbital-signal/`:

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

`packages/orbital-archive-reader/`:

| Directory (relative to packages/orbital-archive-reader/) | Contents | Committed? |
|-----------|----------|------------|
| `src/generated/` | TypeScript bindings | Yes |
| `src/bindings.tsx` | ubrn's loader (`turboModule.entrypoint`) | Yes |
| `cpp/generated/`, `cpp/orbital-archive-reader.*` | C++ bindings + Turbo Module | Yes |
| `ios/OrbitalArchiveReader.*` | iOS native module | Yes |
| `android/` | Android native module + gradle | Yes |
| `OrbitalArchiveReader.podspec` | CocoaPods spec | Yes |
| `rust/orbital_archive_reader/target/` | Rust build cache | No (gitignored) |
| `OrbitalArchiveReaderFramework.xcframework/` | Compiled xcframework (`ios-arm64/`, `ios-arm64_x86_64-simulator/`) | No (gitignored) |
| `rust-profile-ios.txt` | iOS provenance marker (profile + input digest) | No (gitignored) |
| `android/src/main/jniLibs/` | Compiled Android `.a` + `rust-profile.txt` | No (gitignored) |

This package's `main` is a hand-written wrapper, so `ubrn.config.yaml` moves
ubrn's own loader to `src/bindings.tsx` and lists the hand-edited files under
`noOverwrite` — including `OrbitalArchiveReader.podspec`. Everything else in the
table above is regenerated by `--and-generate`.

### Local-only artefacts (never committed, rebuilt per machine)

For **each** package, these are gitignored build inputs/outputs — they do not
exist on a fresh clone, and every machine (and CI job) rebuilds them:

| Path (per package) | Why it is local-only |
|---|---|
| `rust-profile-ios.txt` (+ its `.tmp` staging file) | Describes *this machine's* xcframework; the glob `rust-profile-ios.txt*` covers both |
| `*.xcframework/` | Compiled iOS slices (root `.gitignore`) |
| `android/src/main/jniLibs/` | Compiled Android `.a` pair **and** `rust-profile.txt` |
| `rust/<crate>/target/` | Cargo build cache |
| `node_modules/`, `package-lock.json` | Deliberately absent: see the per-package `.gitignore`. A sub-lock would be an orphan peer closure pinned at a different react-native than the app, installed by nothing and audited by nothing |

Consequence: a clean checkout fails every freshness gate until the Rust is built,
which is the intended fail-closed state, not a bug.

## Version Pinning

| Component | Version | Location |
|-----------|---------|----------|
| uniffi-bindgen-react-native | 0.31.0-2 | `packages/orbital-signal/package.json` **and** `packages/orbital-archive-reader/package.json` (exact specs) |
| uniffi (Rust crate) | `0.31.0` requirement, 0.31.2 resolved | both crates' `Cargo.toml`; parity enforced across both `Cargo.lock` files |
| Rust toolchain | 1.94.1 | `rust-toolchain.toml` (repo root, covers both crates) |

The uniffi npm and Rust crate versions **must stay in sync**, and both crates
must be on the same ones. Everything is on the 0.31.x line.

## Troubleshooting

**"cargo not found"** — Install Rust via rustup (see Prerequisites). Ensure `~/.cargo/bin` is in your PATH.

**iOS build fails with "xcodebuild requires Xcode"** — Install full Xcode from the App Store, then run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.

**iOS build fails with missing targets** — Run `rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim` or let `rust-toolchain.toml` handle it.

**Android build fails with NDK errors** — Ensure `ANDROID_NDK_HOME` is set and the NDK version matches `android/build.gradle`.

**"ContractVersionMismatch"** — The uniffi npm package and Rust crate versions are out of sync. Ensure both crates are on 0.31.x and that both `Cargo.lock` files resolve the same uniffi.

**"missing field `repository`"** — The library's `package.json` must have a `repository` field (ubrn CLI requires it).

**"error: cannot update the lock file ... because --locked was passed to prevent this"** —
That crate's `Cargo.lock` no longer matches its `Cargo.toml`. Every CI cargo
invocation, and ubrn's `cargoExtras` on both platforms, pass `--locked` (#812),
so a drifted lock is a hard failure rather than a silent re-resolve. Regenerate
the lock and **commit it**: from the crate directory
(`packages/<pkg>/rust/<crate>`), either `cargo update -p <crate> --precise <version>`
or a plain `cargo check` without `--locked`, then commit `Cargo.lock`.

**"uniffi resolves to X here but Y in …"** — A security-invariant violation, not
a build error: the two crates' locks disagree on uniffi. Bump both in lockstep.

**"per-package Rust toolchain pin"** — Delete it. The repo-root
`rust-toolchain.toml` is the only pin either crate may have.

## Build Profiles

By default, `ubrn build` uses cargo's dev profile (unoptimized, debug symbols). For store
builds, use the `:release` script variants which pass `--release` to ubrn, triggering
the release profile configured in that crate's `Cargo.toml` (thin LTO,
codegen-units=1, symbol stripping, overflow-checks enabled — both crates
configure the same four).

### Commands

| Task | Dev (default) | Release (store builds) |
|------|--------------|----------------------|
| iOS, both crates | `npm run build:rust:ios` | `npm run build:rust:ios:release` |
| Android, both crates | `npm run build:rust:android` | `npm run build:rust:android:release` |
| Both platforms, both crates | `npm run build:rust` | `npm run build:rust:release` |
| iOS, archive crate only | `npm run build:rust:archive:ios` | `npm run build:rust:archive:ios:release` |
| Android, archive crate only | `npm run build:rust:archive:android` | `npm run build:rust:archive:android:release` |
| Both platforms, archive crate only | `npm run build:rust:archive` | `npm run build:rust:archive:release` |
| Shell script (**orbital-signal only**) | `./scripts/build-ios.sh` | `./scripts/build-ios.sh --release` |
| Shell script (**orbital-signal only**) | `./scripts/build-android.sh` | `./scripts/build-android.sh --release` |

The two shell scripts predate the second crate: they `cd` into
`packages/orbital-signal` and run its per-package script, so they do **not**
build `orbital_archive_reader`. Use the npm scripts for a two-crate build.

### Marker Files

Each build script writes a marker file recording the profile used. One marker
pair per crate:

| Crate | Platform | Marker path | Contents |
|-------|----------|------------|----------|
| `orbital_signal` | iOS | `packages/orbital-signal/rust-profile-ios.txt` | Line 1: `debug` or `release`. Then the `scripts/rust-input-digest.sh` output — one `<sha256>  <relpath>` line per Rust input. |
| `orbital_signal` | Android | `packages/orbital-signal/android/src/main/jniLibs/rust-profile.txt` | `debug` or `release` |
| `orbital_archive_reader` | iOS | `packages/orbital-archive-reader/rust-profile-ios.txt` | Line 1: `debug` or `release`. Then the `scripts/rust-input-digest-archive.sh` output. |
| `orbital_archive_reader` | Android | `packages/orbital-archive-reader/android/src/main/jniLibs/rust-profile.txt` | `debug` or `release` |

All four markers are gitignored (the iOS ones via each package's
`rust-profile-ios.txt*` glob, which also covers the `.tmp` staging file; the
Android ones via the `jniLibs/` pattern).

One script writes **both** iOS markers —
`scripts/write-rust-marker-ios.sh <debug|release> [signal|archive]` — called by
each package's `build:ios` / `build:ios:release` **and** the test harness, so
writer drift shows up on a PR (`build-ios` only runs on main). It runs **after**
a successful `ubrn build`: ubrn runs an unlocked `cargo metadata` before
compiling, which can itself rewrite `Cargo.lock`, so the digest has to be taken
afterwards to describe what was actually compiled. The write is staged through a
`.tmp` file and an atomic `mv`, and the `.tmp` is removed on any failure, so a
failed digest leaves no marker at all and the gates below fail closed.

Each package's npm scripts also `rm -f` that package's live marker *before*
invoking ubrn. That is deliberate: if ubrn dies part-way through rewriting that
crate's xcframework, a surviving marker could validate a half-written artefact.

### Build Guards

Both platforms gate the compiled Rust before it links: the cargo profile must match the
build configuration, and the binaries must not be older than the Rust inputs. Since
#920 there are **four** gates — one per crate per platform:

| Crate | Android Gradle task | iOS Xcode phase | iOS digest script | Rebuild command the gate names |
|---|---|---|---|---|
| `orbital_signal` | `checkRustBinaries` | `[Orbital] Verify Rust release profile` | `scripts/rust-input-digest.sh` | `npm run build:rust:{ios,android}[:release]` |
| `orbital_archive_reader` | `checkArchiveRustBinaries` | `[Orbital] Verify Rust release profile (archive)` | `scripts/rust-input-digest-archive.sh` | `npm run build:rust:archive:{ios,android}[:release]` |

The two **platforms** are deliberately asymmetric — they agree on which inputs
matter for a crate, not on how staleness is detected:

| | Android (`android/check-rust-freshness.gradle`) | iOS (`scripts/verify-rust-profile-ios.sh`) |
|---|---|---|
| Staleness signal | file **mtime** vs the oldest `.a` | **sha256 content digest** vs the marker |
| Escape hatch | opt-in auto-rebuild (`orbital.autoRebuildRust=true`, commented out at `android/gradle.properties:47`) | none — always fails closed |
| Staleness check runs on | every Gradle build (`outputs.upToDateWhen { false }`) | every Xcode configuration |
| Profile check runs on | Release variants only | `CONFIGURATION=Release` only |

#### The crate-selector convention

Two scripts take an **optional** crate selector, which defaults to `signal`:

```bash
scripts/verify-rust-profile-ios.sh [signal|archive]          # $1
scripts/write-rust-marker-ios.sh <debug|release> [signal|archive]   # $2
```

The default exists precisely so every pre-#920 call site keeps working
unchanged: `ios/Podfile`'s first script phase and
`packages/orbital-signal/package.json` still invoke these scripts with no
selector at all, and the gate harness keeps explicit no-argument cases that
prove the default still resolves to `signal`. An unknown selector exits 2.

Inside each script, every per-crate value (package dir, marker path, digest
script, xcframework name, static-library name, label, rebuild command) is a
**literal inside a `case`**, not an interpolation. For the same reason,
`scripts/rust-input-digest-archive.sh` is a **sibling** of
`scripts/rust-input-digest.sh` rather than a parameterised version of it:
security invariant 18 reads each gate's input list out of the **executable**
code after stripping comments, so interpolated paths would read as drift and the
parity clause would stop proving anything. The duplication is load-bearing.

**Third-crate trigger:** do not paste a third copy. At three crates,
parameterise the whole chain from one table — both `scripts/rust-input-digest*.sh`,
`scripts/write-rust-marker-ios.sh`, `scripts/verify-rust-profile-ios.sh`, both
Gradle tasks in `android/check-rust-freshness.gradle`, both gate harnesses, and
invariant 18's `FRESHNESS_GATES` rows.

#### iOS: one Podfile script phase per crate

`ios/Podfile` holds two phases, both `:execution_position => :before_compile`
with `:always_out_of_date => '1'`:

```ruby
script_phase :name => '[Orbital] Verify Rust release profile',
  :script => 'exec bash "${SRCROOT}/../scripts/verify-rust-profile-ios.sh"'
script_phase :name => '[Orbital] Verify Rust release profile (archive)',
  :script => 'exec bash "${SRCROOT}/../scripts/verify-rust-profile-ios.sh" archive'
```

One phase per crate rather than one phase with two invocations, so Xcode
attributes the failure to the crate that is actually stale. The first phase needs
no edit because the selector defaults to `signal`.

The archive check **cannot** live in `OrbitalArchiveReader.podspec`: ubrn
regenerates that podspec (it is only kept hand-edited at all via the
`noOverwrite` list in the package's `ubrn.config.yaml`), so a check added there
would be one regeneration away from vanishing. The Podfile is the only durable
home.

#### Android: one Gradle task per crate

`android/check-rust-freshness.gradle` registers `checkRustBinaries` (signal) and
`checkArchiveRustBinaries` (archive). Both are wired into `preBuild` as separate
`dependsOn` edges in `android/app/build.gradle`, and both declare
`outputs.upToDateWhen { false }` so neither can be skipped — listing them
separately keeps a failure attributed to the crate that is stale. This file lives
in the app module because the canonical
`packages/<pkg>/android/build.gradle` is ubrn-generated and must not be modified.

Each task fails when either `.a` is missing, when any watched input's mtime is
newer than the oldest `.a`, or when the task graph holds a Release variant task
and that crate's `rust-profile.txt` does not read `release`. With
`orbital.autoRebuildRust=true` a task runs the matching rebuild instead of
failing: `npm run build:rust:android[:release]` for signal,
`npm run build:rust:archive:android[:release]` for archive.

**Deliberate asymmetry between the two tasks:** `checkArchiveRustBinaries` is the
*stronger* one. It additionally watches the package's `ubrn.config.yaml` and
`package.json` — i.e. the full input set of `scripts/rust-input-digest-archive.sh`
— so the archive crate's Android and iOS gates agree on inputs.
`checkRustBinaries` deliberately keeps its narrower historical set (crate `src`,
`Cargo.toml`, `Cargo.lock`, root `rust-toolchain.toml`); widening it is the
DEBT-408 follow-up, and doing it inside the second-crate change would have
altered signal's local-rebuild behaviour. Invariant 18 requires each crate's
Gradle task and digest script to agree with **each other**, not with the other
crate's.

#### Freshness inputs

Per crate, the iOS digest hashes exactly:

| Input | Required? |
|---|---|
| `packages/<pkg>/rust/<crate>/src/**/*.rs` | yes (and the set must be non-empty) |
| `packages/<pkg>/rust/<crate>/Cargo.toml` | yes |
| `packages/<pkg>/rust/<crate>/Cargo.lock` | yes |
| repo-root `rust-toolchain.toml` | yes |
| `packages/<pkg>/ubrn.config.yaml` | yes |
| `packages/<pkg>/package.json` | yes |
| `packages/<pkg>/rust/<crate>/build.rs` | optional (hashed when present) |
| `packages/<pkg>/rust/<crate>/.cargo/config.toml` | optional (hashed when present) |

Android watches the first four for both crates, plus `ubrn.config.yaml` and
`package.json` for the archive crate (the asymmetry above). Only
`ubrn.config.yaml` is genuinely iOS-leaning; `package.json`, `build.rs` and
`.cargo/config.toml` affect the Android `.a` identically, and signal's mtime gate
simply does not watch them yet. `ubrn.config.yaml` selects the xcframework
slices and carries `cargoExtras`; `package.json` is both the sole pin of the ubrn
toolchain version (an exact spec, so the root lockfile adds no pin of its own)
and the home of the `build:ios` command lines, so a ubrn bump — which regenerates
the C++/TS glue and its uniffi checksums without touching a single `.rs` file —
or a new cargo `--features` flag invalidates the marker. Hashing the root
`package-lock.json` instead would drag ~1 MB of unrelated JS churn into the
digest and condemn a good xcframework on every Dependabot bump. Each
`package.json` is hashed whole, so an edit that touches only its Android scripts
or comment fields also invalidates that crate's iOS marker. That over-triggering
is expected; the response is a rebuild, never removing the input. The two
**optional** inputs do not exist for either crate today; they are hashed when
present, their absence is not an error, and adding or removing one changes the
file set and so correctly invalidates the marker.

**Deliberately excluded**, per crate: the crate's `tests/` directory (for the
archive crate, the hostile matrix and its ZIP fixtures) and `.cargo/audit.toml`
(it configures `cargo audit`). Neither enters the compiled slices, so that churn
must not invalidate a good binary.

**Why a `path =` / `git =` / `[patch` dependency is banned in the archive crate's
`Cargo.toml`:** it would defeat *both* freshness gates. A path dependency's
sources are in none of the input sets above, and `Cargo.lock` records a path
crate with no source or checksum, so editing one would leave a stale `.a` and
xcframework looking fresh to the mtime gate, the digest gate and `cargo --locked`
alike. `[patch` is the same trap by another spelling. Invariant 18 forbids all
three in that crate's `Cargo.toml` with anchored regexes (`git =` is allowed in
`orbital_signal`, whose libsignal dependency is a git dep pinned to a tag the
lock resolves to a rev — content-addressed, so the digest covers it). Do not
relax the ban without teaching both digest scripts to walk `cargo metadata`.

#### What invariant 18 actually proves

Security invariant 18 `[rust-provenance-locked]` asserts that a freshness gate
still **names** its inputs in executable code (it strips comments first — Groovy
and shell strippers respectively — so a gate's own header cannot satisfy it) and
that it still contains its comparison machinery. Its tables today:

- **`FRESHNESS_GATES` — four rows, one per (gate, crate) pair.**
  `android/check-rust-freshness.gradle` twice (the signal task
  `checkRustBinaries`, and the archive task `checkArchiveRustBinaries`), plus
  `scripts/rust-input-digest.sh` and `scripts/rust-input-digest-archive.sh`.
  Each row names the gate's inputs and its exec anchors — `staleFiles.add` and
  `lastModified` for Gradle, `shasum -a 256` for the digest scripts. The two
  ARCHIVE rows name the SAME six inputs on both platforms (the crate's `src`,
  `Cargo.toml` and `Cargo.lock`, the root `rust-toolchain.toml`, and the
  package's `ubrn.config.yaml` and `package.json`), by full relpath rather than
  by tail, so they pin that crate specifically now that two crates' paths are in
  play. That pair is deliberately stronger than signal's narrower historical
  set; widening signal's to match is DEBT-408.
- **`UBRN_CONFIGS` — two entries**, one per crate, each checked for its
  `crateName`. The archive entry additionally pins a `noOverwrite` list
  (`OrbitalArchiveReaderPackage.kt`, `AndroidManifestNew.xml`,
  `OrbitalArchiveReader.podspec`): those three are hand-written, and a
  regeneration that overwrote them would silently drop the glue module's
  registration, the zero-permission manifest, or the podspec's script phases.
- **`CARGO_CRATE_EXPECTED` — per crate, per job.** `security.yml` must still run
  `cargo test`, `cargo clippy` and `cargo audit` in BOTH crate directories, and
  `build.yml` must still run at least two `cargo build` invocations per crate
  (the device and simulator Apple slices in rust-apple-targets).
- **`MARKER_WRITER_CALLERS` — three rows.** Each package's own `build:ios*`
  scripts must call the shared marker writer — the archive package with its
  `archive` selector, so its marker cannot describe the wrong crate — and
  `scripts/test-rust-profile-gate-ios.sh` must still exercise the real writer,
  so writer drift surfaces on a PR rather than at an Xcode build.

The same invariant also asserts the SINGLE root toolchain pin (no second
`rust-toolchain.toml` under `packages/`), cross-crate uniffi parity, and the
archive crate's `path =` / `git =` / `[patch` dependency bans described above.

That a gate actually **uses** those inputs is proven behaviourally only on iOS,
by the harness cases below; the Android harness is profile-only, so Android's use
is asserted, not tested.

1. **Android (Gradle):** `checkRustBinaries` / `checkArchiveRustBinaries` in
   `android/check-rust-freshness.gradle`, as described above.

2. **iOS (Xcode):** each `script_phase` runs
   `scripts/verify-rust-profile-ios.sh [crate]` before compilation. Four checks,
   in order, against that crate's artefacts:

   1. Both xcframework slices hold the crate's static library
      (`liborbital_signal.a` under
      `packages/orbital-signal/OrbitalSignalFramework.xcframework/ios-arm64/` and
      `.../ios-arm64_x86_64-simulator/`; `liborbital_archive_reader.a` under
      `packages/orbital-archive-reader/OrbitalArchiveReaderFramework.xcframework/…`).
   2. That crate's marker exists **and** carries digest lines. A profile-only
      marker means the xcframework came from an old or raw `ubrn` invocation.
   3. Release configurations only: the marker's profile line must be `release`.
   4. **Every** configuration: recompute the digest with that crate's digest
      script and compare it with the marker's. A mismatch names the `changed:` /
      `added:` / `removed:` paths, then the rebuild command for the marker's own
      profile. See [release-builds.md](release-builds.md) for the failure text.

   The script's filename and the first Xcode phase name both date from #541/#550,
   when the only check was the cargo profile. They are historical misnomers, kept
   deliberately so the staleness gate — and later the second crate — needed zero
   `ios/Podfile` or `project.pbxproj` churn beyond adding one phase.

   Because iOS compares content rather than mtimes, a bare `touch` — or a branch switch that
   restores identical bytes — no longer trips the gate. There is **no escape hatch**: iOS
   always fails closed and prints the command to run. Hand-editing a marker still defeats
   the check; this is a developer safety net against linking stale crypto or a stale
   hostile-input parser, not a security boundary.

   Each digest script is the single owner of its crate's iOS input list. Each
   emits one `<sha256>  <relpath>` line per input, `LC_ALL=C`-sorted by path and
   relative to the repo root, using `shasum -a 256` (present on macOS and on the
   ubuntu runners). Each fails closed — non-zero, message on stderr — when the
   crate `src` directory is missing or holds no `*.rs` file, when a REQUIRED
   input is missing, or when `find`/`sort`/`shasum` fails; the Xcode phase then
   refuses the build rather than linking an unverified xcframework.

   `npm run test:rust-gate:ios` (`scripts/test-rust-profile-gate-ios.sh`)
   unit-tests all four checks for **both** crates across 56 cases: every
   behavioural case is written once and run for `signal` and for `archive`
   (labels carry the crate, `F1 [signal]` / `F1 [archive]`), including one
   content-change case per input and one for each optional input appearing or
   changing. On top of those it proves the selector plumbing itself — the
   no-argument defaults of the writer and the verifier, an unknown selector
   exiting 2, and two isolation pairs where tampering with one crate fails only
   that crate's gate — and its Podfile-wiring case asserts both phase names and
   the literal `archive` argument. It is read-only — every case runs in a
   throwaway `mktemp -d` tree mirroring both packages, written by the real marker
   writer — which is why it is part of `npm run gut-check`. The Android harness
   drives a real Gradle build and stays out of `gut-check`.

   **One-time migration:** a marker written before the digest format existed holds only the
   profile line and fails check 2 once. A single rebuild of that crate rewrites it.

## Cross-Compilation Targets

Both crates build the same five targets, from the same repo-root
`rust-toolchain.toml`:

| Target | Platform | ABI | Build Script (orbital-signal) |
|--------|----------|-----|-------------|
| `aarch64-apple-ios` | iOS device | ARM64 | `scripts/build-ios.sh` |
| `aarch64-apple-ios-sim` | iOS simulator (Apple Silicon) | ARM64 | `scripts/build-ios.sh` |
| `x86_64-apple-ios` | iOS simulator (Intel) | x86_64 | `scripts/build-ios.sh` |
| `aarch64-linux-android` | Android device/emulator | arm64-v8a | `scripts/build-android.sh` |
| `x86_64-linux-android` | Android emulator | x86_64 | `scripts/build-android.sh` |

The Build Script column is the signal-only shell path; the archive crate is built
through `npm run build:rust:archive:*` or its per-package scripts. Each crate's
target list is declared in its own `ubrn.config.yaml`.

ARM32 (`armv7-linux-androideabi`) is intentionally excluded — <5% of modern Android devices, and it doubles build time.

### Binary Sizes (per target)

`orbital_signal`:

| Target | Debug (.a) | Release (.a) | Reduction |
|--------|-----------|-------------|-----------|
| Android arm64-v8a | 135 MB | 42 MB | 3.2x |
| Android x86_64 | 141 MB | 44 MB | 3.2x |
| aarch64-apple-ios | ~19 MB | TBD | |
| aarch64-apple-ios-sim | ~19 MB | TBD | |
| x86_64-apple-ios | ~19 MB | TBD | |
| iOS simulator lipo (combined) | ~37 MB | TBD | |

Release profile (both crates): thin LTO, `codegen-units = 1`, `strip = "symbols"`,
`overflow-checks = true`. `orbital_archive_reader` keeps overflow checks on in
release deliberately — it parses untrusted archives, so an arithmetic overflow
must abort rather than wrap.
`orbital_signal` Android sizes measured from `ubrn build android --release`
(issue #541). iOS release sizes to be measured after the first iOS release
build. `orbital_archive_reader` is a far smaller crate (four crates.io
dependencies, ~25 s to build) and its sizes are not yet recorded.

### Build Times (CI, self-hosted macOS ARM64)

| Step | Time | Notes |
|------|------|-------|
| Rust for Android (2 targets) | ~8 min | `orbital_signal`, first build; cached rebuilds ~2 min |
| Rust for iOS (3 targets) | ~10 min (est.) | `orbital_signal`, includes xcframework bundling |
| Gradle assembleDebug | ~3 min | After Rust build |
| Xcode build | ~5 min (est.) | After pod install |

`orbital_archive_reader` adds ~25 s of cargo time per platform and has its own
Rust cache workspace, so it does not share or thrash the signal cache key.

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
libsignal-protocol v0.106.1
```

`packages/orbital-archive-reader/` has the same shape — generated TS bindings, a
C++ Turbo Module over JSI, and `orbital_archive_reader` as a Rust static lib
behind uniffi proc macros — with crates.io dependencies (pure-Rust inflate via
`flate2`'s `rust_backend`, plus `crc32fast`) in place of libsignal.

## References

- [uniffi-bindgen-react-native](https://github.com/jhugman/uniffi-bindgen-react-native) (Mozilla-backed)
- [Mozilla announcement](https://hacks.mozilla.org/2024/12/introducing-uniffi-for-react-native-rust-powered-turbo-modules/)
- [uniffi-rs](https://github.com/mozilla/uniffi-rs) (upstream)
