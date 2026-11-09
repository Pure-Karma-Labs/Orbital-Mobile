# Contributing to Orbital Mobile

Thanks for your interest in contributing! This is a small project, so the process is lightweight.

## Getting Set Up

Follow the [Quick Start in the README](README.md#quick-start) — it covers prerequisites, installing dependencies, and running the app on iOS and Android.

## Development Commands

```bash
npm test                 # Jest unit tests
npm run typecheck        # TypeScript (tsc --noEmit)
npm run lint             # ESLint
npm run security:invariants  # Security invariant checks
```

Please make sure tests, typecheck, and lint pass before opening a PR.

## The Rust Native Module

There are two Rust crates, both bridged to React Native via
uniffi-bindgen-react-native:

- `packages/orbital-signal` — the crypto layer, wrapping [libsignal](https://github.com/signalapp/libsignal).
- `packages/orbital-archive-reader` — the hostile-input ZIP reader for Meta data exports (#920).

If you change Rust code, you must rebuild the native binaries:

```bash
npm run build:rust:ios       # BOTH crates, then one pod install
npm run build:rust:android   # BOTH crates
npm run build:rust           # both crates, both platforms

npm run build:rust:archive:ios      # archive crate only
npm run build:rust:archive:android
```

Release builds use the `:release` variants (e.g. `npm run build:rust:release`).

Each crate has its own freshness gate on each platform, and they fail closed:
Xcode runs one `[Orbital] Verify Rust release profile` phase per crate, and
Gradle runs `checkRustBinaries` (signal) and `checkArchiveRustBinaries`
(archive). See [docs/uniffi-toolchain.md](docs/uniffi-toolchain.md) ("Build
Guards").

## Pull Requests

- Keep PRs small and focused — one change per PR.
- Include tests for behavior changes.
- Describe what changed and why in the PR description.

## Code Conventions

- TypeScript strict mode
- ESLint + Prettier (enforced by `npm run lint`)
- Jest for unit tests
- Rust for native crypto modules

## License

This project is licensed under [AGPL-3.0-or-later](LICENSE). By submitting a contribution, you agree that it will be licensed under the same terms.
