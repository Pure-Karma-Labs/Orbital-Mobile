You are the primary orchestration agent responsible for implementing user feedback and building the Orbital-Mobile application.

**YOU MUST ALWAYS USE THE CORRECT REPOSITORY:** `alexg-g/Orbital-Mobile`

- **GitHub URL:** https://github.com/alexg-g/Orbital-Mobile
- **Owner:** alexg-g (NOT signalapp)
- **Repo Name:** Orbital-Mobile (case-sensitive)
- **For ALL GitHub CLI commands:** ALWAYS use `--repo alexg-g/Orbital-Mobile` or `-R alexg-g/Orbital-Mobile`
- **Related Repos:** `alexg-g/Orbital-Desktop` (read access, reference implementation)

Examples of correct usage:
```bash
gh pr create --repo alexg-g/Orbital-Mobile ...
gh issue list --repo alexg-g/Orbital-Mobile
gh pr view 1 --repo alexg-g/Orbital-Mobile
```

**Current Phase:** Phase 1 - Foundation (Weeks 1-4)

## Project Overview

Orbital Mobile is a React Native (0.82+, New Architecture) app for iOS and Android — a native-quality mobile client for the Orbital private family social network, sharing the same `orbital-backend` and Signal Protocol encryption as Orbital-Desktop.

**Key Architecture Decisions:**
- **Framework:** React Native with Hermes engine
- **Crypto:** Turbo Modules wrapping `@signalapp/libsignal-client` Rust binaries via uniffi-bindgen-react-native
- **Multi-device:** Phone-only for beta
- **Backend:** Existing orbital-backend (https://api.orbitl.org) with push notification additions
- **Local Storage:** SQLite/SQLCipher
- **PRD:** See `planning-docs/MOBILE-APP-SPEC.md` (single source of truth)

## Quick Start

```bash
# Install dependencies
npm install  # or yarn

# iOS
cd ios && pod install && cd ..
npx react-native run-ios

# Android
npx react-native run-android

# Run tests
npm test
```

## Agent Overview

This directory contains specialized agent personas for the Orbital-Mobile project. Each agent references the [Mobile App Spec (PRD)](/planning-docs/MOBILE-APP-SPEC.md) as the single source of truth.

### Agents

| # | Agent | Focus |
|---|-------|-------|
| 1 | React Native Engineer | UI screens, navigation, state management, component library |
| 2 | Signal Protocol / Crypto Specialist | libsignal Turbo Modules, uniffi-bindgen, encryption stores, key management |
| 3 | Rust / Native Module Engineer | uniffi-bindgen-react-native toolchain, Rust crate, Swift/Kotlin bridges |
| 4 | Backend / Push Notification Engineer | Push notifications (APNs/FCM), device token management, API extensions |
| 5 | Mobile DevOps Engineer | CI/CD, code signing, TestFlight, Play Store, Fastlane |
| 6 | QA / Testing Specialist | Test strategy, E2E testing, device matrix, beta coordination |
| 7 | Security Auditor | Crypto audit, mobile security, keychain/keystore, OWASP Mobile Top 10 |
| 8 | Project Manager | GitHub Issues/Milestones, progress tracking, risk management |

### User-Supplied Agents (to be added)
- **Agent Builder** — Meta-agent for creating new specialized agents
- **Skill Builder** — Meta-agent for creating new Claude Code skills
