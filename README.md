# Elysian Clearing

Property-management command center for Elysian Properties: Hosthub sync, monthly close / owner remittance, Daily Ops, Leads, Platform Invoices (Airbnb / Booking.com), Oxygen e-invoicing, and Viva bank checks.

## Quick start

```bash
cp .env.example .env   # fill HOSTHUB_API_KEY, APP_PASSWORD, DATABASE_URL, …
npm install
npm start              # → http://localhost:3000  (srv-boot.js)
npm test
```

Production runs the Playwright Docker image on Railway (`Dockerfile` → `node srv-boot.js`). See [`DEPLOY.md`](DEPLOY.md).

## Architecture

```
npm start
   └─ srv-boot.js
        ├─ apply srv/patches*.json if any (exact string replace + sha256 gates)
        ├─ write server.gen.js when patches exist (gitignored)
        └─ require effective server
               │
               ▼
         Express server (server.js is the live base as of 2026-08-14 consolidation)
               ├─ apply fe/patches*.json if any to index.html at boot
               ├─ serve SPA (in-memory + gzip when patches applied; else repo file)
               ├─ PostgreSQL (app_data, proofs, leads, platform sessions, …)
               └─ Playwright workers for portal invoice pulls
```

### Patch chains (empty after consolidation)

On **2026-08-14** the accumulated FE (100 files / 590 ops) and SRV (68 files / 241 ops) chains were baked into `index.html` and `server.js`. Both `fe/patches.json` and `srv/patches.json` are empty placeholders.

New releases can again ship as small `fe/patches-2.json` / `srv/patches-2.json` files (or refill `patches.json`) with `baseSha256` / `expectedSha256` gates. Any mismatch is all-or-nothing: boot logs the reason and uses the unpatched base.

Live FE state: `GET /api/fe-info`.

Pre-consolidation patch notes: [`docs/patch-history-consolidated.md`](docs/patch-history-consolidated.md).

**Ship a change** either by editing `server.js` / `index.html` directly, or by adding a new patch file on top of the current base hash.

**Consolidate again** when a new chain gets long: bake the patched result into the base files, reset `patches.json` to `{"patches":[]}`, delete `patches-2…N` in the same release.

## `server.js` map (post-consolidation)

The committed file now includes former patch-only features (session login, Leads, Platform Invoices, Cash Flow, rental-info, …). Rough layout:

| Area | Role |
|------|------|
| Header + FE bootstrap | Env docs; apply `fe/patches*.json` chain when present |
| Auth / session | Cookie login, `USERS_JSON`, `/api/whoami` |
| PostgreSQL + session/DB | `app_data` CRUD, anti-wipe merges |
| Proofs, Daily Ops AI, Hosthub sync | Core ops APIs + cron |
| Leads + Meta | Lead CRM + Graph pull |
| Platform Invoices | Airbnb Connect/OTP, pull jobs, vault PDFs |
| Email / Oxygen / Viva | SMTP, e-invoicing, Payments Check + Cash Flow |
| Deprecated / debug | `/api/sync-cancelled` no-op; `/api/debug-*` |

## Frontend

Single-page app in `index.html` (“Elysian Command Center”). Financial core (`calcBase`, remittance, myDATA) is locked by `tests/golden-financial-core.snap.json` via `tests/monthly-close-patches.test.js`.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/platform-invoice-pull.js` | Headless Airbnb/Booking PDF pull (spawned by the API) |
| `scripts/platform-invoice-save-session.js` | Headed login → save `storageState` for Railway |
| `scripts/platform-invoice-pull.md` | Operational SOP for invoice pull |
| `scripts/build-brochures.py` | EN/GR management brochures → `assets/` |

## Tests

```bash
npm test                      # monthly-close + airbnb-auth + daily-ops (+ clean-persist)
npm run test:platform-invoices
```

Declared feature assertions from the old chains live in `tests/consolidated-assertions.json`.

## Dead ends / intentionally kept

| Item | Status |
|------|--------|
| `POST /api/sync-cancelled` | Deprecated no-op for old cached clients |
| `POST /api/debug-*` | Hosthub inspectors; require app auth |
| `vivaWalletStrategy` | Historical Viva fallback; merchants strategy is primary |

## Related docs

- [`DEPLOY.md`](DEPLOY.md) — Railway deploy
- [`fe/manifest.json`](fe/manifest.json) — FE patch scheme
- [`scripts/platform-invoice-pull.md`](scripts/platform-invoice-pull.md) — portal invoice pull
- [`docs/patch-history-consolidated.md`](docs/patch-history-consolidated.md) — baked patch notes
- Private product memory: `elysian-brain` repo (not this codebase)
