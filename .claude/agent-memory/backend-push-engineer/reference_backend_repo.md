---
name: Backend repo location
description: Orbital backend is at Pure-Karma-Labs/Orbital-Backend, deployed via PM2 on droplet 134.199.230.235
type: reference
---

Backend repo: `Pure-Karma-Labs/Orbital-Backend` (https://github.com/Pure-Karma-Labs/Orbital-Backend)
Local clone: `/Users/alexg/Documents/GitHub/Orbital-Backend`

Structure:
- `src/server.js` — Express entry point, 8 route modules + WebSocket
- `src/routes/` — auth.js, signal-relay.js, threads.js, groups.js, media.js, mediaSync.js, users.js, invites.js (~52 endpoints)
- `src/websocket/signalWebSocket.js` — WebSocket server; `broadcastToConversation()` and `sendToUser()` are the push integration points
- `src/middleware/auth.js` — JWT auth, 30d expiry
- `schema.sql` — PostgreSQL schema
- `migrations/` — 19 migration files (node-pg-migrate)

Deployment:
- PM2 at `/home/orbital/apps/orbital/orbital-backend/src/server.js` on `134.199.230.235`
- PostgreSQL: `orbital` user, `orbital` database
- API URL: https://api.orbitl.org

Previous location (sunsetted): `alexg-g/Orbital-Desktop/orbital-backend/`
