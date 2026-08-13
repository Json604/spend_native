# Spend

One repo: the Android app and the sync server.

| Path | What |
|---|---|
| `/` | React Native Android app (`npm start`, `npx react-native run-android`) |
| `server/` | Fastify + Postgres API (`https://spend.kartikey.xyz`) |

App talks to the server over HTTPS for Google sign-in, sync, and SMS classification. The phone still owns the SQLite ledger.

Server local checks: `cd server && npm install && npm test`. Deploy: `cd server && docker compose up -d --build`. Do not commit `server/.env`.
