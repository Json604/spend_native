# spend_native sync backend

Small offline-first sync companion for the Android expense tracker. It is a TypeScript Fastify service backed by PostgreSQL. The phone remains the day-to-day source of truth; the server supplies durable storage, an ordered outbox, and sessions.

## Local checks

Node 25 is expected.

```sh
npm install
npx tsc --noEmit
node --test
```

Docker is not required for the checks above. To run the complete stack locally, copy `.env.example` to `.env`, set a real `ACCESS_TOKEN_SECRET`, `POSTGRES_PASSWORD`, `GOOGLE_CLIENT_ID`, and `DATABASE_URL=postgres://spend:<password>@postgres:5432/spend`, then run `docker compose up --build`.

## Deploy on the DigitalOcean droplet

1. Install Docker Engine and the Compose plugin on Ubuntu 24.04, and install `git`.
2. Clone this repository, enter it, and create the environment file:

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

3. Set a long random `ACCESS_TOKEN_SECRET`, the production Google OAuth client ID, and a long random `POSTGRES_PASSWORD`. Keep `DATABASE_URL` consistent with those Postgres values. Do not commit `.env`.
4. Start and verify the service:

   ```sh
   docker compose up -d --build
   curl -fsS https://spend.kartikey.xyz/health
   docker compose logs -f app
   ```

The compose file binds the app only to `127.0.0.1:8080`, which is the upstream for the already-running Caddy site. Caddy should proxy `https://spend.kartikey.xyz` to `http://127.0.0.1:8080`; TLS and public firewall exposure remain Caddy's responsibility.

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
