---
name: Three-repo architecture
description: Backend extracted from Orbital-Desktop into standalone Pure-Karma-Labs/Orbital-Backend repo; Desktop being sunsetted; Orbital is mobile-first
type: project
---

Orbital now has three repos: Pure-Karma-Labs/Orbital-Mobile (primary client), Pure-Karma-Labs/Orbital-Backend (Node.js backend API, https://github.com/Pure-Karma-Labs/Orbital-Backend), and alexg-g/Orbital-Desktop (being sunsetted).

**Why:** The backend was extracted from Orbital-Desktop into its own standalone repo as part of a shift to mobile-first architecture. Desktop is being sunsetted.

**How to apply:** When any agent references the backend repo, it should point to Pure-Karma-Labs/Orbital-Backend, not alexg-g/Orbital-Desktop. The Desktop repo remains readable for historical reference only.

## Deployment

- PM2 at `/home/orbital/apps/orbital/orbital-backend/src/server.js` on `134.199.230.235`
- PostgreSQL: `orbital` user, `orbital` database
- API URL: https://api.orbitl.org
