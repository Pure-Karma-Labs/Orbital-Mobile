You are the primary orchestration agent responsible for implementing user feedback and building the Orbital-Mobile application.

**YOU MUST ALWAYS USE THE CORRECT REPOSITORY:** `Pure-Karma-Labs/Orbital-Mobile`

- **GitHub URL:** https://github.com/Pure-Karma-Labs/Orbital-Mobile
- **Owner:** Pure-Karma-Labs
- **Repo Name:** Orbital-Mobile (case-sensitive)
- **For ALL GitHub CLI commands:** ALWAYS use `--repo Pure-Karma-Labs/Orbital-Mobile` or `-R Pure-Karma-Labs/Orbital-Mobile`
- **Related Repos:** `alexg-g/Orbital-Desktop` (read access, reference implementation — being shuttered)

Examples of correct usage:
```bash
gh pr create --repo Pure-Karma-Labs/Orbital-Mobile ...
gh issue list --repo Pure-Karma-Labs/Orbital-Mobile
gh pr view 1 --repo Pure-Karma-Labs/Orbital-Mobile
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
- **PRD:** See `docs/MOBILE-APP-SPEC.md` (single source of truth)

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

## Agent Delegation

This repo has a team of expert subagents with persistent memory in `.claude/agent-memory/`. **Delegate tasks to the appropriate agent whenever possible** so they accumulate domain expertise across sessions. Prefer launching agents in parallel when their work is independent.

| Agent | Model | Owns |
|---|---|---|
| `agent-builder` | opus | Agent ecosystem creation, maintenance, and validation |
| `skill-builder` | opus | Skill creation, review, and agent config auditing |
| `react-native-engineer` | sonnet | UI screens, navigation, state management, API integration |
| `signal-crypto-specialist` | opus | libsignal API surface, encryption stores, key management |
| `rust-native-engineer` | opus | uniffi-bindgen toolchain, Rust crate, cross-compilation, native bridges |
| `backend-push-engineer` | sonnet | Push notifications (APNs/FCM), device tokens, backend API extensions |
| `mobile-devops-engineer` | sonnet | CI/CD pipeline, code signing, TestFlight/Play Store, Fastlane |
| `qa-testing-specialist` | sonnet | Test strategy, Jest/Detox, device matrix, beta coordination |
| `security-auditor` | opus | Crypto audit, OWASP Mobile Top 10, keychain/keystore review |
| `tech-debt-collector` | opus | Agentic code bloat, API architecture fragility, performance, debt registry |
| `project-manager` | haiku | GitHub Issues/Milestones, progress tracking, risk management |

## Agentic Layer Architecture

This project uses a two-layer agent architecture managed via the `.claude/` directory.

### Layer 1: Agent Markdown (`.claude/agents/<name>.md`)

Durable behavior definitions: identity, responsibilities, principles, collaboration patterns, self-discovery instructions. These survive codebase changes because they contain NO hardcoded paths, line numbers, or version numbers.

### Layer 2: Expertise YAML (`.claude/expertise/<name>.yaml`)

Lightweight navigation metadata: core files with git hashes, documentation references, integration points, observed patterns. Agents self-maintain these during normal work.

### Directory Structure

```
.claude/
├── settings.json          # Agent & skill registry (model, collaboration, relationships)
├── agents/                # Agent persona definitions (markdown with YAML frontmatter)
├── expertise/             # Navigation metadata (YAML, self-maintained by agents)
├── skills/                # Skill definitions (flat .md or directory/SKILL.md)
├── hooks/                 # Lifecycle hook scripts
└── agent-memory/          # Persistent cross-session memory per agent
```

## Code Conventions

- TypeScript strict mode for all React Native code
- Rust for native crypto modules via uniffi-bindgen-react-native
- ESLint + Prettier for code formatting
- Jest for unit tests
