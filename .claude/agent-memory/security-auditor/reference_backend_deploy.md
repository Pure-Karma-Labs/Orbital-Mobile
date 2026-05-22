---
name: reference-backend-deploy
description: "Backend deploy procedure — prod at 134.199.230.235, pm2 managed, git pull + migrate + restart"
metadata:
  type: reference
---

## Backend Deploy Procedure

- **Production server:** 134.199.230.235
- **Process manager:** pm2
- **Deploy steps:** `git pull` -> run migrations -> `pm2 restart`
- **Repo:** Pure-Karma-Labs/Orbital-Backend

**Why:** Needed when security fixes require backend deployment (e.g., IDOR fixes, rate limiting, wrapped_keys schema changes).
**How to apply:** When a security finding requires a backend change, reference this procedure and note that deployment is a separate step from merging the backend PR.
