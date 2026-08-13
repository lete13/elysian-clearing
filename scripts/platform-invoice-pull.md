# Platform invoice pull (Airbnb / Booking.com portals)

## What this is

Monthly **Airbnb** and **Booking.com** invoices are PDFs the platforms issue **to Elysian**
(ενδοκοινοτικά / intra-EU). They do **not** appear in Greek expense or myDATA imports.
They are **not** Oxygen ΑΠΥ/ΤΠΥ documents (those are what Elysian issues to owners).

The app **pulls** them automatically from the host portals (Platform Invoices), then packs and emails. Manual PDF upload is emergency-only.

## Dating rules (ASAP — do not wait for the 20th/25th)

| Channel | Document | Issue / file month |
|---|---|---|
| Booking.com | Invoice | **Month after** the bookings (June stays → July invoice). **One invoice per apartment**, not per booking. |
| Airbnb | VAT invoice | Hosthub **`created` / `createdOnChannel`** (confirmation) |
| Airbnb | Credit note | Hosthub **`cancelledAt`** (must download on cancel) |

Confirm in month A and cancel in month B → keep **both** documents.

Default Elysian-tax recipients: `info@e-newgeneration.gr`, `info@elysianproperties.eu`.

## Airbnb = Hosthub reservation codes (VAT Invoicer workflow)

Same idea as [VAT Invoicer](https://vatinvoicer.com/): while logged into Airbnb hosting, take **reservation confirmation codes** and open each reservation to capture the VAT invoice / credit note PDF.

1. Hosthub sync stores each booking’s channel **`reservation_id`** as `reservationId` (Airbnb confirmation code).
2. Platform Invoices → **Expect** builds the month’s Airbnb invoice + credit-note lists from Hosthub dates.
3. **Pull** sends those codes to the worker as `PI_AIRBNB_RESERVATIONS_JSON`.
4. Worker opens `https://www.airbnb.com/hosting/reservations/details/{CODE}` for each code and saves PDFs.

No manual pasting of codes. Booking.com remains available but is secondary while Airbnb Hosthub pull is the focus.

## Railway variables

| Variable | Purpose |
|---|---|
| `PLATFORM_INVOICE_ACCOUNTANT_EMAIL` | Override default recipients |
| `AIRBNB_HOST_EMAIL` / `AIRBNB_HOST_PASSWORD` | Airbnb host login |
| `BOOKING_HOST_EMAIL` / `BOOKING_HOST_PASSWORD` | **admin.booking.com** Login name + password (not www.booking.com) |
| `BOOKING_STORAGE_STATE_B64` | Optional fallback. Prefer **Connect Booking** in the app (session vault) |
| `AIRBNB_STORAGE_STATE_B64` | Optional fallback. Prefer **Connect Airbnb** in the app |
| `PLAYWRIGHT_PROXY_SERVER` | Optional HTTP(S) proxy if datacenter IPs hit captcha often |

## Worker

`scripts/platform-invoice-pull.js` (Playwright + Chromium):

1. Reuses Airbnb / Booking session vault (or password login).
2. **Airbnb:** for each Hosthub confirmation code → reservation page → VAT invoice / credit note PDF.
3. **Booking.com (optional):** admin.booking.com Finance → Invoices, one PDF per property.
4. `POST /api/platform-invoices/pull` stores them in `platform_invoices` with `source=portal`.

CLI with codes:

```bash
PI_AIRBNB_RESERVATIONS_JSON='[{"code":"HMXXXXXXX","kind":"invoice","aptName":"Birdhouse"}]' \
  npm run pull:platform-invoices -- --month=2026-07 --channel=airbnb --out=/tmp/pi-out
```

Airbnb may ask for an **email/SMS code** on password login. Connect once:

```bash
npm i playwright@1.62.1 && npx playwright install chromium
AIRBNB_HOST_EMAIL='…' AIRBNB_HOST_PASSWORD='…' \
  node scripts/platform-invoice-save-session.js --channel=airbnb --headed
# → Connect Airbnb in the app (or AIRBNB_STORAGE_STATE_B64 on Railway)
```

**Deploy:** Railway uses the `Dockerfile` based on `mcr.microsoft.com/playwright:v1.62.1-jammy` (keep in sync with `package.json`).

## Automated collect

1. **Sync Hosthub** so bookings carry `reservationId`.
2. **Connect Airbnb once** if password login hits OTP.
3. Platform Invoices → Expect (codes listed) → Collect → **Pull Airbnb (Hosthub codes)**.
4. Review → Ship.

If Pull returns 0 PDFs, reconnect Airbnb and confirm Hosthub codes are present — do not treat monthly manual PDF upload as the process.
