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
| Airbnb | VAT invoice / debit note | Hosthub **`created` / `createdOnChannel`** (which stay to open). Airbnb may issue **several** debit notes on one confirmation code (book, then extend). |
| Airbnb | Credit note | Hosthub **`cancelledAt`**, and also when Airbnb credits the previous debit on **extend**. Pull saves every credit note on that stay. |

Confirm in month A and cancel in month B → keep **both** documents.
Extend in month B → original debit + credit of that debit + new debit; Expect is still **one stay to open**, not three expected PDFs.

Default Elysian-tax recipients: `info@e-newgeneration.gr`, `info@elysianproperties.eu`.

## Airbnb = Hosthub reservation codes (VAT Invoicer workflow)

Same idea as [VAT Invoicer](https://vatinvoicer.com/privacy/): while logged into Airbnb hosting, take **reservation confirmation codes**, open each reservation, **find the VAT invoice ID on that page**, open Airbnb’s **VAT invoice HTML page**, and print it to PDF.

1. Hosthub sync stores each booking’s channel **`reservation_id`** as `reservationId` (Airbnb confirmation code).
2. Platform Invoices → **Expect** lists **stays to open** this month (not a PDF count). Cancel/extend stays still count as one code.
3. **Test pull (5 codes)** first (latest 5 Hosthub `created` / `createdOnChannel` ids), then **Pull Airbnb (Hosthub codes)** for the full month. **Stop pull** kills a running job (SIGTERM). Codes go to the worker as `PI_AIRBNB_RESERVATIONS_JSON` (`PI_AIRBNB_LIMIT` slices a test run).
4. Worker opens `https://www.airbnb.com/hosting/stay/{CODE}` (Airbnb's current host reservation page; older `/hosting/reservations/details/{CODE}` redirects here). It waits for GraphQL, clicks the **total price** then **every VAT invoice / credit note** on that stay, searches HTML/JSON for VAT invoice IDs, opens each invoice HTML, and `page.pdf()`s it. The stay-page shell is never saved as a PDF.
5. PDFs are **stored by platform / month / apartment**: `Airbnb/2026-07/Birdhouse/invoice-HMXXXX-VATID.pdf` (one file per Airbnb VAT document; a stay can have several). The vault `partner` field is the apartment name (credit notes stay under that apartment; kind is in the filename).

Airbnb does not expose a labeled download link on the reservation details page — that is why looking only for `a[href]` with the word “invoice” saved 0 PDFs.

No manual pasting of codes. Booking.com remains available but is secondary while Airbnb Hosthub pull is the focus.

## Railway variables

| Variable | Purpose |
|---|---|
| `PLATFORM_INVOICE_ACCOUNTANT_EMAIL` | Override default recipients |
| `AIRBNB_HOST_EMAIL` / `AIRBNB_HOST_PASSWORD` | Airbnb host login |
| `BOOKING_HOST_EMAIL` / `BOOKING_HOST_PASSWORD` | **admin.booking.com** Login name + password (not www.booking.com) |
| `BOOKING_STORAGE_STATE_B64` | Optional fallback. Prefer **Connect Booking** in the app (session vault) |
| `AIRBNB_STORAGE_STATE_B64` | Optional fallback. Prefer **Connect Airbnb** in the app |
| `PI_AIRBNB_LIMIT` | Optional max reservation codes (Collect **Test pull (5 codes)** takes the **latest** N by Hosthub created) |

## Worker

`scripts/platform-invoice-pull.js` (Playwright + Chromium):

1. Reuses Airbnb / Booking session vault (or password login).
2. **Airbnb:** for each Hosthub confirmation code → reservation page → **every** VAT invoice / credit note HTML → PDF stored as `Airbnb/{month}/{apartment}/{kind}-{code}-{vatId}.pdf`.
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

1. **Sync Hosthub** so bookings carry `reservationId` (Expect can also backfill from Hosthub).
2. **Connect Airbnb once** (in the app — no terminal):

   Platform Invoices → Collect → **Connect Airbnb**.  
   The server signs in with `AIRBNB_HOST_EMAIL` / `AIRBNB_HOST_PASSWORD`.  
   Connect uses a stealth browser and **Try another way → email OTP** (not SMS).  
   When Airbnb emails a code, enter it in the same screen → Submit code.  
   Session is stored in the vault; then **Pull Airbnb**.

   If Airlock/bot checks keep blocking login, set optional `PLAYWRIGHT_PROXY_SERVER`
   (residential proxy).

3. Review → Ship.

If Pull returns 0 PDFs with “session expired”, Connect Airbnb again (sessions expire) — do not fall back to monthly manual PDF upload.
