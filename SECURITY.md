# Security Policy

Orbital is an end-to-end encrypted family social network built on the Signal Protocol. We take security reports seriously — findings that touch the cryptography (key management, encryption stores, the `packages/orbital-signal` libsignal wrapper) are especially welcome.

## Reporting a Vulnerability

Please report vulnerabilities through **GitHub private vulnerability reporting**: go to the repository's **Security** tab and click **"Report a vulnerability"**. (This option becomes available once the repository is public.)

Please do **not** open a public issue for security problems.

## Scope

- **In scope:** this repository — the Orbital mobile client (React Native app, native modules, and the Rust crypto wrapper in `packages/orbital-signal`).
- **Out of scope:** the backend server (`api.orbitl.org`) lives in a separate private repository. If you find a server-side issue, you can still report it here privately and we'll route it.

## Supported Versions

Only the **latest released version** of the app receives security fixes. Older builds are not supported.

## What to Expect

We're a small team, so response is best-effort: we aim to acknowledge reports within a week and will keep you updated as we investigate. Please give us a reasonable window to fix confirmed issues before public disclosure.
