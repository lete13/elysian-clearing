# Elysian Clearing — Railway Deployment Guide

## What you need
- A GitHub account (free)
- A Railway account (free to start) → railway.app
- 15 minutes

---

## Step 1 — Push to GitHub

1. Go to **github.com → New repository**
2. Name it `elysian-clearing`, set to **Private**, click Create
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
4. Railway auto-detects Node.js and starts deploying ✓

---

## Step 3 — Add PostgreSQL database

1. In your Railway project, click **+ New** (top right)
2. Select **Database → Add PostgreSQL**
3. Railway creates the database and sets `DATABASE_URL` automatically ✓

---

## Step 4 — Set environment variables

In Railway → your service → **Variables** tab, add:

| Variable | Value |
|---|---|
| `HOSTHUB_API_KEY` | Your Hosthub API key |
| `APP_PASSWORD` | A team password (e.g. `elysian2025`) |

`DATABASE_URL` is already set by the PostgreSQL add-on.

---

## Step 5 — Get your URL

1. Railway → your service → **Settings → Networking → Generate Domain**
2. Share `https://your-app.up.railway.app` with your team
3. Everyone uses the **same password** to log in

---

## Updating the app

Every time you push code to GitHub, Railway auto-redeploys in ~60 seconds:

```bash
git add .
git commit -m "Update: description of change"
git push
```

---

## Cost estimate

| Item | Cost |
|---|---|
| Railway Hobby plan (app server) | $5/month |
| PostgreSQL (1 GB) | ~$5/month |
| **Total** | **~$10/month** |

The free Trial gives you enough credits to test everything first.

---

## How shared data works

- All teammates open the same URL
- Any change (import, config, sync) is saved to the database within 2 seconds
- The app polls for team updates every 60 seconds
- Click **↻ Refresh** in the top-right to pull the latest immediately
- The ☁ badge shows sync status (green = saved, amber = saving, red = error)

