# Deployment Guide

This app is ready to run behind a permanent HTTPS URL. The temporary `loca.lt` link failed because tunnel services are disposable and can go away at any time.

## Temporary verified test link

If you want a short-lived public link just for checking the app, use the repo-owned command below:

```bash
pnpm run deploy:test-link
```

What it does:

1. builds the production frontend and API
2. starts the real production app locally
3. creates a Cloudflare quick tunnel to that app
4. verifies `/api/healthz`, `/admin/login`, and `/api/public-config` on the public URL
5. prints the URL only after those checks pass

If any stage fails, the command stops immediately and prints the failing step plus the log file paths under `artifacts/deploy-link/` instead of hanging for hours.

Optional survey-route check:

```bash
pnpm run deploy:test-link -- --survey-token YOUR_SURVEY_TOKEN
```

That adds a public verification request for `/respond/YOUR_SURVEY_TOKEN`.

Press `Ctrl+C` when you are done so the local server and tunnel shut down cleanly.

## Recommended production path

Use a hosted app platform with a built-in public URL and PostgreSQL database.

Recommended:

1. Railway for the most reliable setup here
2. Render if you want a simple dashboard-managed deployment and are comfortable with its plan limits

## Stable URL options

You have two practical choices:

1. Provider subdomain
   Example shapes:
   - `front-desk-allocator.up.railway.app`
   - `ihouse-front-desk.onrender.com`

2. Custom domain
   Example:
   - `frontdesk.ihousewashington.org`
   - `ihousefrontdesk.org`

Provider subdomains are the cheapest way to get a stable public link. A truly branded permanent domain requires buying a domain name.

## True no-cost option

If you want a stable public deployment with full functionality and no monthly hosting bill, the practical path is:

1. self-host the app on a computer you control
2. use a free Duck DNS hostname
3. put Caddy in front of the app for HTTPS

Duck DNS describes itself as free dynamic DNS, and Caddy automatically provisions and renews HTTPS certificates for public hostnames.

- Duck DNS: https://www.duckdns.org/
- Caddy automatic HTTPS: https://caddyserver.com/docs/automatic-https
- Caddy reverse proxy: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy

This option keeps ownership in your hands, but it does require:

- a machine that stays on
- router port forwarding for `80` and `443`
- a public Duck DNS hostname pointing at your home or office IP

This is the best match for "no-cost" if you want the full app, PostgreSQL, admin login, and public survey form all working continuously.

## Admin login setup

Admin access now requires:

- `SESSION_SECRET`
- `ADMIN_USERS_JSON`
- a local `.env.production` or equivalent secret store that stays out of Git

Generate a password hash:

```bash
pnpm run hash:admin-password
```

That command prints:

- a secure password hash
- an example `ADMIN_USERS_JSON` value

Example:

```json
[{"email":"admin@example.com","name":"Front Desk Admin","passwordHash":"scrypt$..."}]
```

You can include multiple admins in the same JSON array.

For self-hosting from this repo, copy `.env.production.example` to `.env.production`, fill in the real values, and keep that file local.

## Required environment variables

Set these in your hosting platform:

```bash
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://...
SESSION_SECRET=replace-with-a-long-random-secret
ADMIN_USERS_JSON=[{"email":"admin@example.com","name":"Front Desk Admin","passwordHash":"scrypt$..."}]
PUBLIC_APP_URL=https://your-public-app-url
```

Optional for local HTTP-only testing:

```bash
COOKIE_SECURE=false
```

Leave `COOKIE_SECURE` unset in production so the admin session cookie stays HTTPS-only.

If you deploy behind a managed reverse proxy, also set:

```bash
TRUST_PROXY=true
```

`PUBLIC_APP_URL` should be the full public base URL where the app is reachable. The admin desk uses it when you click `Copy Link`, so copied survey links stay externally shareable even if you are managing surveys from a different local address.

## Railway steps

1. Push this repo to GitHub.
2. Create a Railway project from the repo.
3. Add a PostgreSQL service.
4. Add these variables to the app service:
   - `NODE_ENV=production`
   - `PORT=3000`
   - `DATABASE_URL`
   - `SESSION_SECRET`
   - `ADMIN_USERS_JSON`
   - `PUBLIC_APP_URL`
5. Deploy using the existing `Dockerfile`.
6. Open the service settings and use `Generate Domain`.
7. Choose a service name close to your preferred keywords so the generated URL is close to your final name.

Important: Railway is convenient, but it is not a permanent zero-cost production host. Their current pricing docs show the stable always-on route is paid.

## Render with Neon

The managed deployment uses a Render Free web service and a separate Neon Free PostgreSQL database, subject to each provider's usage limits. The app's database connection is configured in the Render Dashboard rather than derived from a Render database.

1. Back up the existing database and verify the target Neon database contains the expected surveys, responses, shifts and allocations before changing a live connection.
2. Use the existing Render web service for this deployment. For a new deployment, create a Free web service from this repo and the existing `Dockerfile`.
3. Set these variables on the web service:
   - `NODE_ENV=production`
   - `PORT=3000`
   - `DATABASE_URL` (the Neon connection string, including its required SSL parameters)
   - `SESSION_SECRET`
   - `ADMIN_USERS_JSON`
   - `PUBLIC_APP_URL`
4. Deploy the web service, then verify real survey and allocation reads. `/api/healthz` alone does not check database connectivity.
5. Use the generated `onrender.com` URL or attach a custom domain.

`render.yaml` deliberately sets `DATABASE_URL` to `sync: false`. Existing Blueprint syncs preserve the value configured in the Dashboard. Never replace it with `fromDatabase`: that would redirect the app to Render PostgreSQL on the next sync, making the Neon surveys disappear from the app.

No Render PostgreSQL database is declared in this Blueprint. Removing the legacy database declaration does not delete the existing database; it stops Blueprint management and prevents later syncs from recreating it. Do not delete an old database as part of a connection change. Provider expiry and retention policies still apply independently.

Before syncing, check the Blueprint's linked branch and preview the changes to the existing service. Do not create a replacement Blueprint. `autoDeployTrigger: off` controls web-service code deploys; Blueprint Auto Sync is a separate setting and can still apply configuration changes after a push.

Keep independent database backups outside either provider and verify their contents before relying on them for recovery.

References: [Render secret values](https://render.com/docs/blueprint-spec#prompting-for-secret-values), [Blueprint resource retention](https://render.com/docs/infrastructure-as-code#deleting-resources), and [Blueprint Auto Sync](https://render.com/docs/infrastructure-as-code#disabling-automatic-sync).

## Self-hosted path

Use the existing Docker stack in this repo, then place Caddy in front of it.

1. Point your Duck DNS hostname to your network IP.
2. Forward ports `80` and `443` from your router to the machine running Docker.
3. Copy `.env.production.example` to `.env.production` and fill in the real secrets.
4. Start this app with Docker Compose:

```bash
docker compose --env-file .env.production up --build -d
```

5. Apply the current schema:

```bash
docker compose --env-file .env.production exec app pnpm --filter @workspace/db run push
```

6. Run Caddy with a site block that reverse proxies your Duck DNS hostname to this app on port `3000`.

Example Caddyfile:

```caddyfile
your-subdomain.duckdns.org {
  reverse_proxy 127.0.0.1:3000
}
```

With that setup, your permanent admin URL becomes:

```text
https://your-subdomain.duckdns.org/admin/login
```

and your public survey links become:

```text
https://your-subdomain.duckdns.org/respond/<token>
```

## First login

Once deployed:

1. Open `/admin/login`
2. Sign in with one of the configured admin emails and passwords
3. The rest of the admin desk stays protected behind that login
