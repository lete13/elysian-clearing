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

## Architecture (read this before editing)

```
npm start
   └─ srv-boot.js
        ├─ apply srv/patches.json → patches-2…N  (exact string replace + sha256 gates)
        ├─ write server.gen.js  (gitignored)
        └─ require(server.gen.js)   OR fall back to unpatched server.js on any failure
               │
               ▼
         (effective) Express server
               ├─ apply fe/patches.json → patches-2…N to index.html at boot
               ├─ serve patched SPA from memory (+ gzip)
               ├─ PostgreSQL (app_data, proofs, leads, platform sessions, …)
               └─ Playwright workers for portal invoice pulls
```

**Committed `server.js` and `index.html` are a frozen base, not the live app.** Almost every recent feature lives in the patch chains:

| Chain | Files | Applied by |
|-------|-------|------------|
| Server | `srv/patches.json` … `srv/patches-68.json` | `srv-boot.js` |
| Frontend | `fe/patches.json` … `fe/patches-100.json` | effective server (base FE bootstrap is extended by srv patches) |

Each patch file has `baseSha256` (input) and `expectedSha256` (output). Releases are small new `patches-N.json` files. Any mismatch is all-or-nothing: the process logs the reason and starts the **unpatched** base so the site never goes down on a bad release.

Live FE state: `GET /api/fe-info`.

### Do not edit base files casually

Changing a single character in `server.js` or `index.html` breaks every subsequent patch hash and the app falls back to the old base (missing Leads, Platform Invoices, Cash Flow, session auth, …).

**Ship a change** as a new chain file (`fe/patches-101.json` or `srv/patches-69.json`) whose `baseSha256` equals the previous file’s `expectedSha256`.

**Consolidate** when the chain gets painful: bake the fully patched result into `server.js` / `index.html` (e.g. via GitHub web upload), reset `patches.json` to `{"patches":[]}`, and delete `patches-2…N` in the **same** release. The base-drift gate makes a missed reset safe (boot refuses the old chain).

## Base `server.js` map (unpatched)

Line ranges are approximate anchors in the **repo** file; srv patches inject more after these sections.

| Section | Approx. lines | Role |
|---------|---------------|------|
| Header + FE bootstrap | 1–80 | Env docs; apply `fe/patches.json` only (chain added by srv) |
| PostgreSQL + session/DB | ~90–400 | `app_data` CRUD, anti-wipe merge, `/api/session`, `/api/db/*`, `/api/history` |
| Proof files | ~410–520 | Monthly-close / Law 5170 attachments |
| Daily Ops AI | ~521–600 | `/api/ops/schedule-check` (Anthropic vision) |
| Hosthub sync | ~600–1040 | Snapshot, `/api/sync`, auto-sync cron, `/`, `/health`, `/api/fe-info` |
| Deprecated / debug | ~1042–1160 | `/api/sync-cancelled` no-op; `/api/debug-checkin`, `/api/debug-cancelled` |
| Email SMTP | ~1169–1250 | `/api/email/*` |
| Oxygen | ~1254–1810 | Greek e-invoicing issue / PDF / ledger |
| Viva bank | ~1816–end | Payments Check + Saturday Athens cron (`vivaWalletStrategy` = historical fallback) |

Features **only** in the srv chain (not in the base map): session cookie login (`USERS_JSON`), Leads + Meta pull, Platform Invoices + Airbnb Connect/OTP, Viva Cash Flow, changelog API, rental-info, in-memory FE serve, etc.

## Frontend

Single-page app in `index.html` (“Elysian Command Center”). Nav tabs and empty shells are filled by scripts and FE patches (Daily Ops, Monthly Tasks, Leads, Platform Invoices, Cash Flow, …). Financial core (`calcBase`, remittance, myDATA) is treated as locked by `tests/monthly-close-patches.test.js`.

Patch notes live on each op in `fe/patches-*.json` (`note` field) — that is the feature changelog.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/platform-invoice-pull.js` | Headless Airbnb/Booking PDF pull (spawned by the API) |
| `scripts/platform-invoice-save-session.js` | Headed login → save `storageState` for Railway |
| `scripts/platform-invoice-pull.md` | Operational SOP for invoice pull |
| `scripts/build-brochures.py` | EN/GR management brochures → `assets/` |

## Tests

```bash
npm test                      # monthly-close + airbnb-auth + daily-ops check-in + clean-persist
npm run test:platform-invoices
```

Most tests apply the full FE/SRV chains in-process (same rules as boot) and assert behavior on the **effective** source. They do not need a running server or live Airbnb.

## Dead ends / intentionally kept

| Item | Status |
|------|--------|
| `POST /api/sync-cancelled` | Deprecated no-op for old cached clients — keep until those are gone |
| `POST /api/debug-*` | Hosthub inspectors; require app auth — leave for ops, do not expose publicly without password |
| `vivaWalletStrategy` | Historical Viva fallback; merchants strategy is primary |
| Root `patches.json` / `files2.zip` | Removed — orphaned (boot never loaded them) |

## Related docs

- [`DEPLOY.md`](DEPLOY.md) — Railway deploy
- [`fe/manifest.json`](fe/manifest.json) — FE patch scheme
- [`scripts/platform-invoice-pull.md`](scripts/platform-invoice-pull.md) — portal invoice pull
- Private product memory: `elysian-brain` repo (not this codebase)
