# Deployment

## What this app needs

Three things, and the first one rules out several popular hosts:

1. **Local disk.** Every dataset is its own DuckDB file. Serverless platforms
   (Vercel Functions, Netlify Functions, Cloudflare Workers) have no
   persistent filesystem, so the API cannot run there. It needs a
   long-running container with a mounted volume.
2. **Postgres.** Required in production — the server refuses to boot without
   `DATABASE_URL`.
3. **One instance, for now.** BYOK keys live in server memory and rate limits
   are per-process. Two instances would mean a user's key exists on one and
   not the other. See [Scaling past one instance](#scaling-past-one-instance).

The frontend is **not** deployed separately. The API serves the built SPA from
the same origin. That is deliberate: the session cookie is `SameSite=Lax`,
which browsers will not send cross-site, so splitting the frontend onto its own
domain would force `SameSite=None` — a real weakening — or a reverse proxy in
front of both. One service avoids the choice and removes CORS entirely.

---

## Quickest path: Railway

Postgres, the container, and a volume all in one project. Roughly ten minutes.

1. **New project → Deploy from GitHub repo**, pick your VoiceQuery repo.
2. **Add Postgres**: *New → Database → PostgreSQL*.

3. **Reference the database from the app service.** This does **not** happen
   automatically — Railway creates `DATABASE_URL` on the *Postgres* service,
   and other services only see it if you reference it. In the app service's
   *Variables* tab add:

   ```
   DATABASE_URL = ${{ Postgres.DATABASE_URL }}
   ```

   Substitute your database service's name as it appears in the sidebar. Miss
   this and the deploy crashes on boot with `DATABASE_URL is required in
   production` — deliberately, rather than falling back to an embedded
   database and losing data on the next deploy.

4. **The build is pinned by `railway.json`** at the repo root, which sets the
   Dockerfile builder and the healthcheck. Without it Railway autodetects a
   Node app, runs `npm start`, and never builds the frontend — you get a
   working API serving no UI.
5. **Add a volume**: *Settings → Volumes → New Volume*, mount path `/data`.
   Without this, uploaded datasets vanish on every redeploy.
6. **Set the remaining variables**:

   ```
   NODE_ENV=production
   SESSION_SECRET=<paste the generated value — see below>
   COOKIE_SECURE=true
   DATA_DIR=/data
   ```

   Generate the secret with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

7. **Generate a domain**: *Settings → Networking → Generate Domain*.
8. Add a provider key when you want real AI answers (see below). Without one
   the app runs in clearly-labelled demo mode, which is a perfectly good
   public demo.

Railway's Hobby plan is about $5/month and covers this comfortably.

---

## Alternative: Fly.io

More CLI, cheaper at rest, good if you already use it.

```bash
fly launch --dockerfile apps/api/Dockerfile --no-deploy
fly postgres create --name voicequery-db
fly postgres attach voicequery-db          # sets DATABASE_URL
fly volumes create data --size 1

fly secrets set \
  SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" \
  COOKIE_SECURE=true

fly deploy
```

Add to `fly.toml`:

```toml
[env]
  PORT = "8787"
  DATA_DIR = "/data"
  NODE_ENV = "production"

[[mounts]]
  source = "data"
  destination = "/data"

[http_service]
  internal_port = 8787
  force_https = true
  auto_stop_machines = false   # DuckDB wants a warm instance with its disk
  min_machines_running = 1
```

`auto_stop_machines = false` matters. Scale-to-zero costs you the warm DuckDB
handles and adds a multi-second cold start to the first question — exactly the
moment you least want it during a demo.

---

## Alternative: a VPS you control

Cheapest and most transparent. Any $5 box (Hetzner, DigitalOcean) works.

```bash
# on the server, with Docker and the compose plugin installed
git clone https://github.com/<you>/VoiceQuery.git && cd VoiceQuery

cat > .env <<EOF
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
COOKIE_SECURE=true
EOF

docker compose --profile full up -d --build
```

That brings up Postgres and the app with both volumes. Put Caddy in front for
automatic HTTPS:

```
yourdomain.com {
    reverse_proxy localhost:8787
}
```

---

## Turning on real AI answers

Without a provider key the app answers from a local rule-based stand-in and
badges every response as simulated. To use a real model, set **one** of:

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...          # plus AI_MODEL, e.g. gpt-6.1-sol
OPENROUTER_API_KEY=sk-or-v1-...# plus AI_MODEL, e.g. anthropic/claude-sonnet-4.5
```

Set `AI_PROVIDER` as well if more than one key is present — the server refuses
to guess and will fail to boot rather than silently pick one.

Note that the platform key funds the **free credits** you give visitors. Each
question is two model calls, so watch the spend. Two ways to control it:

- Point `AI_MODEL` at a cheaper model.
- Leave the platform key unset entirely and let users bring their own key.
  Guests always get the demo provider regardless, so anonymous traffic can
  never reach a paid endpoint.

---

## Payments

Optional; billing stays disabled until both are set.

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
CREDIT_PACKAGES=[{"id":"pack20","name":"20 questions","credits":20,"amountMinor":900,"currency":"usd"}]
CHECKOUT_SUCCESS_URL=https://yourdomain.com/app?checkout=success
CHECKOUT_CANCEL_URL=https://yourdomain.com/app?checkout=cancelled
```

In the Stripe dashboard add an endpoint at
`https://yourdomain.com/api/billing/webhook` subscribed to
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed` and `checkout.session.expired`, then
copy its signing secret into `STRIPE_WEBHOOK_SECRET`.

Keep `sk_test_` keys until you genuinely intend to take money — the UI labels
test mode, and going live needs the merchant account owner's authorisation.

---

## Checklist before sharing the link

- [ ] `SESSION_SECRET` is a generated random value, not the dev default
      (the server refuses to start in production otherwise)
- [ ] `COOKIE_SECURE=true` — the cookie will not be sent over plain HTTP
- [ ] A volume is mounted at `DATA_DIR`, or uploads die on every deploy
- [ ] `GET /api/health` returns `{"status":"ok","driver":"postgres"}` —
      if it says `pglite`, `DATABASE_URL` did not reach the container
- [ ] Sign up, ask a question, upload a CSV, reload the page — the session
      should survive
- [ ] Decide whether `GUEST_MODE_ENABLED` should stay on for a public link

---

## Things that will bite you

**Crash on boot: `DATABASE_URL is required in production`.** The variable is
not set. On Railway that means you did not add the
`${{ Postgres.DATABASE_URL }}` reference to the *app* service — adding the
database alone is not enough.

**A working API with no UI.** The host built the app itself instead of using
the Dockerfile, so the frontend build stage never ran. Check the build log:
if it shows `npm start` rather than a Docker build, the builder was not
picked up. `railway.json` pins it; other hosts need the Dockerfile selected
explicitly.

**`driver: "pglite"` in production.** Means `DATABASE_URL` was not picked up
and the app silently fell back to the embedded database. Data will vanish on
the next deploy. Check the health endpoint after every deploy.

**No volume mounted.** Uploaded datasets are written to `DATA_DIR`; without a
volume that is container-local and disappears. The sample dataset regenerates
itself on boot, so the app will *look* fine while quietly losing user uploads.

**Scale-to-zero.** Render's free tier and Fly's `auto_stop_machines` both idle
the container. Nothing is lost (state is on disk and in Postgres), but the
first request after a sleep is slow.

**Two instances.** BYOK keys are held in memory per process, so a user's key
may exist on one instance and not the next request's. Keep it at one until the
note below is addressed.

---

## Scaling past one instance

Three things are per-process today and would need moving:

| What | Where it lives now | What it needs |
|---|---|---|
| BYOK keys | in-memory `Map`, session-scoped | Redis, or encrypted at rest with separately managed keys |
| Rate limits | in-memory per process | a shared store (`@fastify/rate-limit` supports Redis) |
| TTL sweep | `setInterval` in-process | a scheduled job, or leader election |

DuckDB files are the harder problem: they are local disk, so instances cannot
share them without shared storage or routing each dataset to a fixed instance.
For a portfolio demo none of this matters. For real traffic, deal with the
sweep and rate limits first — they are cheap — and only then the dataset
storage.
