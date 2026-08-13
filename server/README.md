# Spend server

Sync, auth, and classification for the Spend Android app. This directory is the backend half of the monorepo (`spend_native`). TypeScript Fastify + PostgreSQL. The phone is the day-to-day source of truth; this process is durable storage, sessions, and Groq classification.

## Local checks

From this directory (`server/`). Node 25 is expected.

```sh
npm install
npx tsc --noEmit
node --test
```

Docker is not required for the checks above. To run the complete stack locally, copy `.env.example` to `.env`, set a real `ACCESS_TOKEN_SECRET`, `POSTGRES_PASSWORD`, `GOOGLE_CLIENT_ID`, and `DATABASE_URL=postgres://spend:<password>@postgres:5432/spend`, then run `docker compose up --build` from this directory.

## Deploy on the DigitalOcean droplet

Production is already running. **Do not clone over it.** Live paths:

| What | Path |
|---|---|
| Compose project | `/opt/spend_server` |
| Secrets | `/opt/spend_server/.env` |
| Public URL | `https://spend.kartikey.xyz` (Caddy → `127.0.0.1:8080`) |

Update code from a laptop (never overwrite `.env`):

```sh
rsync -az --exclude '.env' --exclude 'node_modules' --exclude 'dist' --exclude '.git' \
  server/ droplet:/opt/spend_server/
ssh droplet 'cd /opt/spend_server && docker compose up -d --build'
```

### First-time install on a new VM

1. Install Docker Engine, the Compose plugin, Caddy, and `git` on Ubuntu 24.04.
2. Copy this `server/` directory to `/opt/spend_server`.
3. `cp .env.example .env && chmod 600 .env` and fill every required value.
4. Point Caddy at `127.0.0.1:8080` for `spend.kartikey.xyz`.
5. `docker compose up -d --build`
6. `curl -fsS https://spend.kartikey.xyz/health`

The compose file binds only to `127.0.0.1:8080`. TLS and the public firewall stay with Caddy.

### Groq

Set `GROQ_API_KEY` in `/opt/spend_server/.env`, then:

```sh
cd /opt/spend_server && docker compose up -d --force-recreate app
```

Empty key → classify returns 204. The Android app must not store this key.

## Backups and restore

Install `postgresql-client` on the droplet. Set `DATABASE_URL` in the shell and run the included script from a nightly cron job (the script keeps 14 days):

```sh
DATABASE_URL="postgres://spend:...@127.0.0.1:5432/spend" ./scripts/nightly-pg-dump.sh
```

To restore a dump, stop the app, recreate the database if necessary, and restore with:

```sh
docker compose stop app
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"'
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T postgres sh -c 'pg_restore --no-owner --no-privileges --dbname="$POSTGRES_DB"' \
  < /var/backups/spend/spend-YYYYMMDDTHHMMSSZ.dump
docker compose up -d app
```

## Sync contract

An operation is `{opId, entity, entityId, action, fields, source}`. `opId` is a client UUID and is the idempotency key. The server assigns `serverSeq` from one PostgreSQL sequence. Upserts use per-field server-order LWW clocks. Allocation `source: "manual"` always wins over machine sources (`learned`, `rule`, `similarity`, `llm`). Deletes set `deleted_at` and are included in the outbox. Push batches over `MAX_PUSH_OPS` are rejected with `push_batch_too_large`.

## Endpoints

- `GET /health`
- `POST /v1/auth/google`
- `POST /v1/auth/refresh`
- `POST /v1/sync/push` (Bearer access token)
- `GET /v1/sync/pull?since=<cursor>` (Bearer access token)
- `POST /v1/classify/transaction` (Bearer access token; 204 if `GROQ_API_KEY` is unset)
