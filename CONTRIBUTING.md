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

The crypto layer lives in `packages/orbital-signal` — a Rust crate wrapping [libsignal](https://github.com/signalapp/libsignal), bridged to React Native via uniffi-bindgen-react-native. If you change Rust code, you must rebuild the native binaries:

```bash
npm run build:rust:ios       # rebuild iOS (also runs pod install)
npm run build:rust:android   # rebuild Android
npm run build:rust           # both
```

Release builds use the `:release` variants (e.g. `npm run build:rust:release`).

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
