# Elysian Clearing — Railway Deployment Guide

## What you need
- A GitHub account
- A Railway account → railway.app
- ~15 minutes

---

## Step 1 — Push to GitHub

1. Go to **github.com → New repository**
2. Name it `elysian-clearing`, set to **Private** (recommended), click Create
3. On your computer, open the `elysian-clearing` folder in a terminal:

```bash
git init
git add .
git commit -m "Initial deployment"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/elysian-clearing.git
git push -u origin main
```

---

## Step 2 — Create Railway project

1. Go to **railway.app** → Log in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select `elysian-clearing`
4. Railway builds with the **Dockerfile** (Playwright + Chromium). Start command is `node srv-boot.js` (see `railway.toml`).

The boot script applies `srv/patches*.json` to `server.js`, then the server applies `fe/patches*.json` to the SPA. See [`README.md`](README.md) before editing base files.

---

## Step 3 — Add PostgreSQL database

1. In your Railway project, click **+ New** (top right)
2. Select **Database → Add PostgreSQL**
3. Railway creates the database and sets `DATABASE_URL` automatically ✓

---

## Step 4 — Set environment variables

In Railway → your service → **Variables** tab. Minimum to open the app:

| Variable | Value |
|---|---|
| `HOSTHUB_API_KEY` | Your Hosthub API key |
| `APP_PASSWORD` | A team password |

`DATABASE_URL` is already set by the PostgreSQL add-on.

Useful next: `USERS_JSON` (named logins + roles), `SMTP_*` (owner reports / lead welcome), `VIVA_TX_USER` / `VIVA_TX_PASS` (Payments Check + Cash Flow), `OXYGEN_*` (e-invoicing), Airbnb/Booking session vars for Platform Invoices.

Full annotated list: [`.env.example`](.env.example).

---

## Step 5 — Get your URL

1. Railway → your service → **Settings → Networking → Generate Domain**
2. Share `https://your-app.up.railway.app` with your team
3. Open `/login` (session cookie) when `USERS_JSON` / session auth is live; otherwise Basic Auth uses `APP_PASSWORD`

---

## Updating the app

Every push to GitHub redeploys (~1–2 minutes with the Playwright image):

```bash
git add .
git commit -m "Update: description of change"
git push
```

**Frontend / server feature changes** usually ship as a new `fe/patches-N.json` or `srv/patches-N.json` — not by rewriting `index.html` / `server.js`. See README → Architecture.

---

## Cost estimate

| Item | Cost |
|---|---|
| Railway Hobby plan (app server) | $5/month |
| PostgreSQL (1 GB) | ~$5/month |
| **Total** | **~$10/month** |

The free Trial gives you enough credits to test everything first. Playwright image uses more RAM than a plain Node nixpack build — stay on Hobby or above for Platform Invoices.

---

## How shared data works

- All teammates open the same URL
- Any change (import, config, sync) is saved to the database within 2 seconds
- The app polls for team updates every 60 seconds
- Click **↻ Refresh** in the top-right to pull the latest immediately
- The ☁ badge shows sync status (green = saved, amber = saving, red = error)
