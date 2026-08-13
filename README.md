# Spend

| Path | What |
|---|---|
| `app/` | React Native Android app |
| `server/` | Fastify + Postgres API (`https://spend.kartikey.xyz`) |

The phone owns the SQLite ledger. The server is sign-in, sync, and SMS classification.

## App

```sh
cd app
npm start
npx react-native run-android
cd tests && node --test coordinator.test.mjs spendQueries.test.mjs backupOps.test.mjs syncClient.test.mjs wireCommands.test.mjs
```

Release: `app/scripts/release.sh <version> [notes]`

## Server

```sh
cd server
npm install
npm test
# deploy
cp .env.example .env   # never commit
docker compose up -d --build
```
