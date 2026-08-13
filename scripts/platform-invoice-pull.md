# Platform invoice pull (Airbnb / Booking.com portals)

## What this is

Monthly **Airbnb** and **Booking.com** invoices are PDFs the platforms issue **to Elysian**
(ενδοκοινοτικά / intra-EU). They do **not** appear in Greek expense or myDATA imports.
They are **not** Oxygen ΑΠΥ/ΤΠΥ documents (those are what Elysian issues to owners).

The app can **upload**, **pack**, **email**, and **pull** them (Tools → Platform Invoices).

## Dating rules (ASAP — do not wait for the 20th/25th)

| Channel | Document | Issue / file month |
|---|---|---|
| Booking.com | Invoice | **Month after** the bookings (June stays → July invoice) |
| Airbnb | VAT invoice | Hosthub **`created` / `createdOnChannel`** (confirmation) |
| Airbnb | Credit note | Hosthub **`cancelledAt`** (must download on cancel) |

Confirm in month A and cancel in month B → keep **both** documents.

Default Elysian-tax recipients: `info@e-newgeneration.gr`, `info@elysianproperties.eu`.

## Railway variables

| Variable | Purpose |
|---|---|
| `PLATFORM_INVOICE_ACCOUNTANT_EMAIL` | Override default recipients |
| `AIRBNB_HOST_EMAIL` / `AIRBNB_HOST_PASSWORD` | Airbnb host login |
| `BOOKING_HOST_EMAIL` / `BOOKING_HOST_PASSWORD` | **admin.booking.com** Login name + password (not www.booking.com) |
| `BOOKING_STORAGE_STATE_B64` | Optional. Playwright cookies after a headed login — bypasses captcha |
| `AIRBNB_STORAGE_STATE_B64` | Optional. Same for Airbnb when OTP/MFA blocks password login |

## Worker

`scripts/platform-invoice-pull.js` (Playwright + Chromium):

1. Logs into Airbnb hosting and **https://admin.booking.com/** (or reuses `*_STORAGE_STATE_B64`).
2. Opens Finance → Invoices (extranet) for the requested `YYYY-MM`.
3. Downloads PDFs (invoices + Airbnb credit notes when visible).
4. `POST /api/platform-invoices/pull` stores them in `platform_invoices` with `source=portal`.

Booking.com often shows a **human/captcha** check from datacenter IPs. Airbnb may ask for an **email/SMS code**. In those cases, on a laptop with a display:

```bash
npm i playwright@1.62.1 && npx playwright install chromium
BOOKING_HOST_EMAIL='…' BOOKING_HOST_PASSWORD='…' \
  node scripts/platform-invoice-save-session.js --channel=booking --headed
# → paste BOOKING_STORAGE_STATE_B64=… into Railway Variables
```

```bash
npm run pull:platform-invoices -- --month=2026-07 --channel=all --out=/tmp/pi-out
# Booking only:
npm run pull:platform-invoices -- --month=2026-07 --channel=booking --out=/tmp/pi-out
```

**Deploy:** Railway uses the `Dockerfile` based on `mcr.microsoft.com/playwright:v1.62.1-jammy` (keep in sync with `package.json`).
