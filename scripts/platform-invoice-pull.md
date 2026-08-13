# Platform invoice pull (Airbnb / Booking.com portals)

## What this is

Monthly **Airbnb** and **Booking.com** invoices are PDFs the platforms issue **to Elysian**
(ενδοκοινοτικά / intra-EU). They do **not** appear in Greek expense or myDATA imports.
They are **not** Oxygen ΑΠΥ/ΤΠΥ documents (those are what Elysian issues to owners).

Today the app can **upload**, **pack**, and **email** them (Tools → Platform Invoices).
Automated **portal download** is the next slice.

## Railway variables

| Variable | Purpose |
|---|---|
| `PLATFORM_INVOICE_ACCOUNTANT_EMAIL` | Default recipient for the leased pack (E-New Generation) |
| `AIRBNB_HOST_EMAIL` / `AIRBNB_HOST_PASSWORD` | Airbnb host login |
| `BOOKING_HOST_EMAIL` / `BOOKING_HOST_PASSWORD` | Booking.com extranet login |

`POST /api/platform-invoices/pull` already checks these and returns 501 until the browser worker lands.

## Planned worker

1. Headless browser (Playwright) logs into each portal with the env credentials.
2. Opens the tax/invoice area for the requested `YYYY-MM`.
3. Downloads PDFs into `platform_invoices` with `source=portal`.
4. UI then emails leased → accountant (20th) and B2B → partners (25th).

Selectors and MFA handling will be filled in against a live host session before enabling pull in production.
