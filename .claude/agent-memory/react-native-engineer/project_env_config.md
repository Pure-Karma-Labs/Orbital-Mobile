---
name: env-config
description: react-native-config centralizes env vars (SENTRY_DSN, API_URL) in src/config/env.ts; hardcoded URLs removed from client.ts and websocketManager.ts
metadata:
  type: project
---

PR #344 externalized Sentry DSN and API base URL via `react-native-config` before repo goes public.

Key files:
- `src/config/env.ts` — single import point for all env vars. Validates API_URL format and HTTPS in prod. Derives WS_URL from API_BASE_URL. Dev default: `http://localhost:3000`.
- `src/config/react-native-config.d.ts` — TypeScript declarations for `react-native-config` module
- `.env.example` — template with SENTRY_DSN and API_URL (`.env` is gitignored)
- `__mocks__/react-native-config.ts` — Jest mock returning test DSN + production API URL

Changes to existing files:
- `src/services/api/client.ts` — removed hardcoded `API_BASE_URL` constant and HTTPS guard; now imports + re-exports from `config/env`
- `src/services/websocket/websocketManager.ts` — removed hardcoded `WS_URL`; imports from `config/env`
- `index.js` — Sentry.init now conditional on SENTRY_DSN being set; imports from `config/env`
- `jest.config.js` — added `react-native-config` to `transformIgnorePatterns` whitelist
- CI workflows (`ci.yml`, `build.yml`) — create `.env` from GitHub secrets before build

**Why:** Repo going public (#337, #338) — hardcoded Sentry DSN and API URL would leak infrastructure details.

**How to apply:** Never hardcode URLs or secrets. Import from `src/config/env.ts`. Add new env vars to `.env.example`, the mock, and the CI workflow secrets step. Note: react-native-config has Gradle caching issues — `.env` changes may not invalidate Android build cache.
