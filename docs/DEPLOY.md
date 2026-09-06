# Deploying DealFlow360

The app is a single Node.js process (API + built React client) that needs one PostgreSQL database. It reads
`DATABASE_URL` (TLS on automatically for hosted databases) or the `PG*` variables, listens on `PORT`, and seeds
the demo dataset on first start. Sessions live in the database, so it is stateless and restart-safe.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | `postgres://user:pass@host:5432/dbname` — preferred on hosted platforms |
| `PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE` | alternative to `DATABASE_URL` (local development) |
| `PGSSL` | `1` / `0` to force TLS on or off (auto: on for non-local `DATABASE_URL`) |
| `PORT` | listening port (default 4300; Render/Railway set it for you) |
| `COOKIE_SECURE` | `1` on any HTTPS host — adds the `Secure` flag to session cookies |
| `PUBLIC_URL` | optional, e.g. `https://dealflow360.onrender.com` — used in portal links (otherwise the request origin) |
| `DF_RESET` | `1` for one start to drop and reseed the database |

Health check: `GET /api/health` → `{ ok, db, version, uptime_s }`.

---

## Option 1 — Render (recommended, free, ~5 minutes)

1. Push the repo to GitHub (already done: `Gangadhar017/DealFlow`).
2. Sign in at https://dashboard.render.com with GitHub.
3. **New → Blueprint** → select the `DealFlow` repository → Render reads [`render.yaml`](../render.yaml) and shows
   one web service (`dealflow360`, Node) and one PostgreSQL database (`dealflow360-db`). Click **Apply**.
4. Wait for the first build (≈3–4 min: `npm run setup` installs both packages and builds the React client, then
   `npm start` creates the schema and seeds the demo data). The service URL looks like `https://dealflow360.onrender.com`.
5. Open `https://<your-service>.onrender.com/api/health` — you should see `{"ok":true,"db":true,…}` — then the app itself.
6. Optional: in the service's **Environment** tab add `PUBLIC_URL=https://<your-service>.onrender.com` so copied portal links use the public host.

Notes for the free plan:
- The web service **sleeps after 15 minutes without traffic**; the first request then takes ~30–60 s. Open the app a few
  minutes before your demo (or set up a free uptime pinger hitting `/api/health` every 10 min).
- Render's free PostgreSQL is valid for **30 days**, then must be recreated. If you need longer, create a free database at
  https://neon.tech, paste its connection string as `DATABASE_URL` in the web service's Environment tab, and delete the
  Render database from the blueprint.
- To reset the demo data on the server: sign in as **admin@dealflow.io** → Configuration → Settings → **↺ Reset demo data**
  (drops and reseeds in ~3 s; everyone is signed out). Alternative: Environment → add `DF_RESET=1` → save → remove it again.
- To run the automated suite against the deployment: `DF_BASE=https://<your-service>.onrender.com npm test` (it creates test
  quotations — reset the demo data afterwards).

## Option 2 — Railway

1. https://railway.app → **New Project → Deploy from GitHub repo** → select `DealFlow`. Railway detects the `Dockerfile`.
2. **+ New → Database → PostgreSQL** in the same project.
3. On the web service → **Variables**: add `DATABASE_URL = ${{Postgres.DATABASE_URL}}` (reference), `COOKIE_SECURE = 1`.
4. **Settings → Networking → Generate Domain**. Done.

## Option 3 — Fly.io

```bash
fly launch --no-deploy            # accepts the Dockerfile; say yes to a Postgres cluster when asked
fly secrets set COOKIE_SECURE=1   # DATABASE_URL is attached automatically by the Postgres add-on
fly deploy
```

## Option 4 — any VPS with Docker (DigitalOcean, EC2, a lab server)

```bash
git clone https://github.com/Gangadhar017/DealFlow.git && cd DealFlow
docker compose up -d --build      # app on :4300 + PostgreSQL in a volume
```
Put nginx or Caddy in front for HTTPS and set `COOKIE_SECURE=1` in `docker-compose.yml` once TLS terminates upstream.

## After deploying — demo checklist

- `GET /api/health` returns `ok: true`.
- Sign in as `rep@dealflow.io / Rep@123`; the dashboard shows ~270 quotations of history.
- Open `/#/portal` in a second tab and sign in as `buyer@deltalog.com / Customer@123`.
- Warm the service up 5 minutes before you present if you are on a free plan.
