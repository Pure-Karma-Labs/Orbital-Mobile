You are the primary orchestration agent responsible for implementing user feedback and building the Orbital-Mobile application.

**YOU MUST ALWAYS USE THE CORRECT REPOSITORY:** `Pure-Karma-Labs/Orbital-Mobile`

- **GitHub URL:** https://github.com/Pure-Karma-Labs/Orbital-Mobile
- **Owner:** Pure-Karma-Labs
- **Repo Name:** Orbital-Mobile (case-sensitive)
- **For ALL GitHub CLI commands:** ALWAYS use `--repo Pure-Karma-Labs/Orbital-Mobile` or `-R Pure-Karma-Labs/Orbital-Mobile`
- **Related Repos:**
  - `Pure-Karma-Labs/Orbital-Backend` (read/write access — standalone backend API, https://github.com/Pure-Karma-Labs/Orbital-Backend)
  - `alexg-g/Orbital-Desktop` (read access — being sunsetted)

Examples of correct usage:
```bash
gh pr create --repo Pure-Karma-Labs/Orbital-Mobile ...
gh issue list --repo Pure-Karma-Labs/Orbital-Mobile
gh pr view 1 --repo Pure-Karma-Labs/Orbital-Mobile
```

**Current Phase:** Phase 1 - Foundation (Weeks 1-4)

## Project Overview

Orbital Mobile is a React Native (0.82+, New Architecture) app for iOS and Android — a native-quality mobile client for the Orbital private family social network. It shares the same `orbital-backend` (now `Pure-Karma-Labs/Orbital-Backend`) and Signal Protocol encryption. Orbital is now mobile-first: Desktop is being sunsetted.

**Key Architecture Decisions:**
- **Framework:** React Native with Hermes engine
- **Crypto:** Turbo Modules wrapping `@signalapp/libsignal-client` Rust binaries via uniffi-bindgen-react-native
- **Multi-device:** Phone-only for beta
- **Backend:** `Pure-Karma-Labs/Orbital-Backend` (https://api.orbitl.org) with push notification additions
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

## Issue Implementation Workflow

Every issue follows this 5-phase process. Do not skip phases.

### Phase 1: Plan
- Explore the issue, relevant code, and references (launch Explore agents)
- Design the approach (launch Plan agent)
- Write the plan to the plan file

### Phase 2: Agent Team Plan Review
- Launch `security-auditor` and `tech-debt-collector` to review the plan in parallel
- High/Critical findings must be addressed before proceeding
- Update the plan with feedback, then get user approval via ExitPlanMode

### Phase 3: Agent Team Implementation
- Launch the appropriate implementation agent on an isolated worktree
- Verify: typecheck (`npx tsc --noEmit`), tests (`npm test`), security requirements
- Fix any issues the agent missed

### Phase 4: PR Creation
- Commit, push, create PR with summary + test plan
- Reference the issue number for auto-close

### Phase 5: Agent Team PR Review
- Launch 3 reviewers in parallel: `security-auditor`, `tech-debt-collector`, `qa-testing-specialist`
- Add `rust-native-engineer` for Rust-touching PRs
- Fix blocking findings (Critical/High), then present consolidated summary to user
- Merge on user approval, create follow-up issues for Medium/Low items

## Agent Delegation

This repo has a team of expert subagents with persistent memory in `.claude/agent-memory/`. **Delegate tasks to the appropriate agent whenever possible** so they accumulate domain expertise across sessions. Prefer launching agents in parallel when their work is independent.

| Agent | Model | Owns |
|---|---|---|
| `agent-builder` | claude-opus-4-6 | Agent ecosystem creation, maintenance, and validation |
| `skill-builder` | claude-opus-4-6 | Skill creation, review, and agent config auditing |
| `api-integration-engineer` | claude-opus-4-6 | API client, service orchestration, wire-format types, backend contract verification |
| `react-native-engineer` | claude-opus-4-6 | UI screens, navigation, state management, component library (frontend only) |
| `signal-crypto-specialist` | claude-opus-4-6 | libsignal API surface, encryption stores, key management |
| `rust-native-engineer` | claude-opus-4-6 | uniffi-bindgen toolchain, Rust crate, cross-compilation, native bridges |
| `backend-push-engineer` | claude-sonnet-4-6 | Push notifications (APNs/FCM), device tokens, backend API extensions |
| `mobile-devops-engineer` | claude-sonnet-4-6 | CI/CD pipeline, code signing, TestFlight/Play Store, Fastlane |
| `qa-testing-specialist` | claude-sonnet-4-6 | Test strategy, Jest/Detox, device matrix, beta coordination |
| `security-auditor` | claude-opus-4-6 | Crypto audit, OWASP Mobile Top 10, keychain/keystore review |
| `tech-debt-collector` | claude-opus-4-6 | Agentic code bloat, API architecture fragility, performance, debt registry |
| `project-manager` | claude-sonnet-4-6 | GitHub Issues/Milestones, progress tracking, risk management |

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
