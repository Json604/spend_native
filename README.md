# Spend

Android expense tracker plus its sync server. The phone owns the SQLite ledger (SMS ingest, budgets, UI). The server is Google sign-in, multi-device sync, SMS classification, and self-hosted APK updates.

```
app/       React Native + Kotlin (the phone)
server/    Fastify + Postgres (https://spend.kartikey.xyz)
```

GitHub: `https://github.com/Json604/spend_native`

---

## What talks to what

```
Phone app  --HTTPS-->  Caddy (TLS)  -->  127.0.0.1:8080  (Docker app)
                                         Postgres in Docker (not public)
Phone app  --HTTPS-->  /downloads/latest.json + APKs  (Caddy static)
```

Package id is `com.lym.spend`. Updates are **not** Play Store: the app fetches `https://spend.kartikey.xyz/downloads/latest.json` and installs a signed APK. Same signing key must be used forever.

---

## App (local)

Needs Node 20+, Android SDK, a device or emulator. From a laptop:

```sh
cd app
npm install
npm start
# other terminal
cd app
npx react-native run-android
```

Tests (no Android needed):

```sh
cd app/tests
node --test coordinator.test.mjs spendQueries.test.mjs backupOps.test.mjs syncClient.test.mjs wireCommands.test.mjs budgetPaste.test.mjs smsPermissions.test.mjs
```

`parser.test.mjs` needs a local SMS corpus (`node generate_sms_corpus.mjs`). That file is gitignored — real bank SMS must not be committed.

Release signing lives in `~/.gradle/gradle.properties` on the machine that builds APKs (`SPEND_RELEASE_STORE_FILE`, `SPEND_RELEASE_STORE_PASSWORD`, `SPEND_RELEASE_KEY_ALIAS`, `SPEND_RELEASE_KEY_PASSWORD`). Never put those in the repo.

---

## Publish an app update (devices pick it up themselves)

On the laptop that has the release keystore and SSH to the droplet (`ssh droplet`):

```sh
# working tree must be clean
app/scripts/release.sh 2.3.13 "What the user will see in the update dialog"
```

That script:

1. Bumps `versionCode` / `versionName` in `app/android/app/build.gradle`
2. Builds a signed release APK
3. Checks the APK’s real version with `aapt`
4. Commits + tags `v<version>`
5. Uploads to the droplet at `/var/www/spend/downloads/spend-<version>-<code>.apk`
6. Atomically writes `/var/www/spend/downloads/latest.json`

Then push the commit and tag:

```sh
git push origin main
git push origin v2.3.13
```

Phones already running the app check `latest.json` on launch and when returning to the foreground. Users confirm the Android installer.

If Gradle fails after moving files under `app/`, wipe stale autolink cache and rebuild:

```sh
rm -rf app/android/build app/android/app/build app/android/.gradle
cd app/android && ./gradlew assembleRelease
```

---

## Server (local)

Node 25. From `server/`:

```sh
cd server
cp .env.example .env
# edit .env — see variables below
npm install
npx tsc --noEmit
npm test
docker compose up --build    # optional full stack
```

`GROQ_API_KEY` is optional. If it is missing, `POST /v1/classify/transaction` returns 204 and the phone skips suggestions. Everything else still works.

---

## Production server (this droplet)

| What | Where |
|---|---|
| SSH | `ssh droplet` (root on `ubuntu-s-1vcpu-1gb-blr1`) |
| Running code | `/opt/spend_server` (Docker Compose project `spend_server`) |
| Secrets | `/opt/spend_server/.env` (mode 600, never commit) |
| Postgres data | Docker volume `spend_server_pgdata` |
| Public HTTPS | Caddy → `https://spend.kartikey.xyz` → `127.0.0.1:8080` |
| APKs + update manifest | `/var/www/spend/downloads/` |

This directory is **not** a git checkout. Deploy by copying `server/` from this repo onto `/opt/spend_server` **without overwriting `.env`**.

### Ship a new server build

From a laptop that can `ssh droplet`:

```sh
# from the monorepo root
rsync -az --exclude '.env' --exclude 'node_modules' --exclude 'dist' --exclude '.git' \
  server/ droplet:/opt/spend_server/

ssh droplet 'cd /opt/spend_server && docker compose up -d --build'
ssh droplet 'curl -fsS http://127.0.0.1:8080/health'
```

Postgres stays up. Only the app container is rebuilt.

### Environment file

`/opt/spend_server/.env` (same keys as `server/.env.example`):

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | App → Postgres inside Compose |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | yes | Must match `DATABASE_URL` |
| `GOOGLE_CLIENT_ID` | yes | Same web client the Android app uses |
| `ACCESS_TOKEN_SECRET` | yes | ≥32 chars. Changing it signs everyone out |
| `ACCESS_TOKEN_TTL` | no | Default `15m` |
| `REFRESH_TOKEN_TTL_DAYS` | no | Default `90` |
| `GROQ_API_KEY` | no | Groq key (`gsk_…`). Empty = no classification |
| `LOG_LEVEL` | no | Default `info` |

Edit:

```sh
ssh droplet
nano /opt/spend_server/.env
# Ctrl+O, Enter, Ctrl+X
```

After changing `.env`, recreate the **app** container (Postgres can stay):

```sh
cd /opt/spend_server
docker compose up -d --force-recreate app
curl -fsS http://127.0.0.1:8080/health
```

### Groq classification

1. Create a key at https://console.groq.com → API Keys.
2. On the droplet, set `GROQ_API_KEY=` in `/opt/spend_server/.env`.
3. Recreate `app` as above.

Check the route exists (401 without a user token is success):

```sh
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8080/v1/classify/transaction
# expect 401
```

The phone calls `POST https://spend.kartikey.xyz/v1/classify/transaction` with the user’s access token. It never holds the Groq key.

### Health and logs

```sh
curl -fsS https://spend.kartikey.xyz/health
cd /opt/spend_server && docker compose ps
cd /opt/spend_server && docker compose logs -f app
```

### Database backup / restore

See `server/README.md`. Nightly script: `server/scripts/nightly-pg-dump.sh`.

---

## HTTP API

All `/v1/*` except `/health` and `/downloads/*` need `Authorization: Bearer <access>` unless noted.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/health` | no | `{ "status": "ok" }` |
| `POST` | `/v1/auth/google` | no | body `{ "id_token" }` |
| `POST` | `/v1/auth/refresh` | no | body `{ "refresh" }` — rotates refresh token |
| `POST` | `/v1/sync/push` | yes | body `{ "ops", "deviceId" }` |
| `GET` | `/v1/sync/pull?since=<n>` | yes | cursor is a number |
| `POST` | `/v1/classify/transaction` | yes | 200 suggestion, 204 if no key / Groq fail |
| `GET` | `/downloads/latest.json` | no | APK update manifest |
| `GET` | `/downloads/spend-*.apk` | no | APK files |

---

## Data on the phone

Updating the APK (same package + signing cert) does **not** wipe SQLite. Uninstall or “clear storage” does.

Sign-out does not delete local spends.

---

## Don’t

- Commit `.env`, `*.sqlite`, `tests/fixtures/sms_corpus.json`, or the release keystore
- Change `applicationId` or the release signing cert (updates would stop)
- Expose Postgres on a public port
- Put `GROQ_API_KEY` in the Android app
