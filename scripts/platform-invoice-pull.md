# Platform invoice pull (Airbnb / Booking.com portals)

## What this is

Monthly **Airbnb** and **Booking.com** invoices are PDFs the platforms issue **to Elysian**
(ενδοκοινοτικά / intra-EU). They do **not** appear in Greek expense or myDATA imports.
They are **not** Oxygen ΑΠΥ/ΤΠΥ documents (those are what Elysian issues to owners).

The app **pulls Airbnb** invoices automatically from the host portal, then packs and emails.
**Booking.com** invoices are collected by uploading a **zip of PDFs** from admin.booking.com
Finance → Invoices. The server files each PDF by hotel id and issue month.
Portal Pull Booking.com is emergency-only (Railway IPs are often blocked).

## Dating rules (ASAP — do not wait for the 20th/25th)

| Channel | Document | Issue / file month |
|---|---|---|
| Booking.com | Invoice | **Month after** the bookings (June stays → July invoice). **One invoice per apartment**, not per booking. |
| Airbnb | VAT invoice / debit note / credit note | **Invoice issue date** on the VAT HTML. Hosthub `created` / `createdOnChannel` / `cancelledAt` still decide **which stay to open**. An extend reissues: original debit stays in its issue month; the credit of that debit and the new debit archive in the later issue month. |

Confirm in month A and cancel in month B → keep **both** documents (each in its issue-date month).
Extend in month B → original debit (issue date A) + credit of that debit + new debit (issue dates B). Each further extend adds another credit + new debit (**1 + 2n** across months). Pull still saves every VAT document on the stay; each PDF is archived under `Airbnb/{issue-month}/`.

**Expect** estimates how many invoices Pull should save:

| Stay | Estimated PDFs |
|---|---|
| Normal reservation | **1** (VAT debit) |
| Cancelled | **2** (debit + credit note) |
| 1 extend (Hosthub `created` more than 36h after Airbnb `createdOnChannel`, or one extra Hosthub event id) | **3** (original debit + credit of that debit + new debit) |
| n extends | **1 + 2n** (2→5, 3→7, 4→9) |

Same confirmation code is one stay; cancel wins over extend over normal. Extra Hosthub event ids on that code (lifetime, not only in-month) raise n. One Hosthub event updated in place still estimates one extend. Pull saves every VAT document on the stay.

**Vault vs Expect:** `/api/platform-invoices/airbnb-codes` returns `gaps` (complete stays, incomplete codes, missing doc count). Blank Chromium prints under 2 KB do not count as saved. **Pull Airbnb (Hosthub codes)** is the month pull: incomplete stays run first; already-saved invoices are skipped. Hosthub sync **keeps cancelled Airbnb reservations that still have an `HM…` confirmation code**, even when `guest_paid = 0` (Payments Check still ignores `cancelled: true`). Invoices with no reservation id cannot be queued from Hosthub — those stay on VAT Invoicer / Airbnb finance.

Ship emails every accountant group the PDFs **plus** an Excel (`Airbnb-VAT-YYYY-MM.xls`) in the import layout: Ημερομηνία = issue date, Αιτιολογία = invoice number (`AIUC-…`), Κατάστημα empty, Τοκισμός από = issue date, Αρ. συναλλαγής empty, Ποσό = total €, Πρόσημο ποσού = empty if positive / `-` if credit. After those columns: Reservation id, Listing name, Check-in, Check-out (from Hosthub / pull meta). Collect/Review can download the same file.

Default Elysian-tax recipients: `info@e-newgeneration.gr`, `info@elysianproperties.eu`.

## Airbnb = Hosthub reservation codes (VAT Invoicer workflow)

Same idea as [VAT Invoicer](https://vatinvoicer.com/privacy/): while logged into Airbnb hosting, take **reservation confirmation codes**, open each reservation, **find the VAT invoice ID on that page**, open Airbnb’s **VAT invoice HTML page**, and print it to PDF.

1. Hosthub sync stores each booking’s channel **`reservation_id`** as `reservationId` (Airbnb confirmation code).
2. Platform Invoices → **Expect** lists stays to open **and** estimates invoices to pull (normal ×1, cancelled ×2, extended ×3 for the first extend, then +2 per extra extend). It also shows **vault vs Expect** (which stays are short).
3. **Test pull (HM9DCDMEXT · HMWRNAWHBA)** re-opens those two stays. **Pull Airbnb (Hosthub codes)** is the full month (incomplete codes first; already-saved invoices skipped). **Stop pull** kills a running job (SIGTERM). Codes go to the worker as `PI_AIRBNB_RESERVATIONS_JSON` (`PI_AIRBNB_LIMIT` slices a latest-N test run). Blank PDFs under 2 KB are discarded and not treated as already saved.
4. Worker opens `https://www.airbnb.com/hosting/stay/{CODE}`. A hosting 200 that says the reservation is missing is **not** treated as opened — it then tries `/hosting/reservations/details/{CODE}` and reservations search (the path a human uses). It waits for GraphQL, clicks the **total price** then **every VAT invoice / credit note** on that stay, searches HTML/JSON for VAT invoice IDs, and prints each invoice HTML to PDF. Stay-page links are `/invoice/{token}`. Same-tab SPA navigation of that path on `airbnb.com` is a soft 404; the worker then **fetches** `/invoice/{token}` and `/vat_invoices/{token}` with the host session and opens them in a **new tab** on `www.airbnb.gr` and `www.airbnb.com` (VAT Invoicer). It waits up to 15s for `main#site-content` with invoice markers (`AIUC-`, invoice number). Soft-404 bodies are never saved as PDFs.
5. PDFs are **stored by platform / invoice-issue-month / apartment**: `Airbnb/2026-07/Birdhouse/invoice-HMXXXX-VATID.pdf`. A stay opened in July can still drop an August-dated extend debit into `Airbnb/2026-08/…`. Already-pulled rows are rechecked against the VAT issue date on Collect/Review/Ship.

Airbnb does not expose a labeled download link on the reservation details page — that is why looking only for `a[href]` with the word “invoice” saved 0 PDFs.

No manual pasting of codes. **Booking.com:** download the month’s invoice PDFs as a zip from
group Finance → Invoices, then **Upload Booking.com zip** on Collect. Each PDF is filed by
`bookingHotelId` and issue month (`Booking.com/{YYYY-MM}/{apartment}/`). Votsala 1–8 share
one id / one PDF. Unmapped ids land in `unmapped-{id}` until you paste the id on Configuration.
Pull Booking.com (`channel=booking`) remains under Emergency only.

## Railway variables

| Variable | Purpose |
|---|---|
| `PLATFORM_INVOICE_ACCOUNTANT_EMAIL` | Override default recipients |
| `AIRBNB_HOST_EMAIL` / `AIRBNB_HOST_PASSWORD` | Airbnb host login |
| `BOOKING_HOST_EMAIL` / `BOOKING_HOST_PASSWORD` | **admin.booking.com** Login name + password (not www.booking.com) |
| `BOOKING_STORAGE_STATE_B64` | Optional fallback. Prefer **Connect Booking** in the app (session vault) |
| `AIRBNB_STORAGE_STATE_B64` | Optional fallback. Prefer **Connect Airbnb** in the app |
| `PI_AIRBNB_LIMIT` | Optional max reservation codes (latest N by Hosthub created). Collect **Test pull** sends `HM9DCDMEXT` and `HMWRNAWHBA` by code. |
| `PLAYWRIGHT_PROXY_SERVER` | Optional residential proxy when Airbnb or Booking.com blocks the Railway IP (`Sign-in failed / Try again later`). Chromium needs `{ server, username, password }` — userinfo in the URL is ignored. |
| `BOOKING_CONNECT_COOLDOWN_MS` | After Booking.com blocks Connect **or** Pull (text or HTTP 403/429), refuse new password logins for this many ms (default 4 hours). Stored in Postgres `app_data` key `pi_booking_block` so it survives deploys and is shared across replicas. `0` disables. |

## Worker

`scripts/platform-invoice-pull.js` (Playwright + Chromium):

1. Reuses Airbnb / Booking session vault (or password login). **Booking Pull will not password-login while the server-IP cooldown is active** — Connect and Pull share the same Postgres row. A missing/expired Booking session fails closed instead of filling `BOOKING_HOST_PASSWORD` from the Railway IP.
2. **Airbnb:** for each Hosthub confirmation code → reservation page → **every** VAT invoice / credit note HTML → PDF stored as `Airbnb/{issue-month}/{apartment}/{kind}-{code}-{vatId}.pdf`.
3. **Booking.com:** **Upload Booking.com zip** (Finance → Invoices mass-download). One PDF per Booking property; **Votsala 1–8 share one PDF** filed under `Votsala`. Filing key is `bookingHotelId` (unmapped → `unmapped-{id}`). Month comes from the PDF issue date (filename as fallback; Collect month last). Pull Booking.com / Connect Booking are emergency-only. No Booking.com Excel from Pull.
4. Zip ingest is `POST /api/platform-invoices/booking-zip` (`source=upload`). Airbnb Pull is still `POST /api/platform-invoices/pull` (`source=portal`).

CLI with codes:

```bash
PI_AIRBNB_RESERVATIONS_JSON='[{"code":"HMXXXXXXX","kind":"invoice","aptName":"Birdhouse"}]' \
  npm run pull:platform-invoices -- --month=2026-07 --channel=airbnb --out=/tmp/pi-out
```

Booking.com (session vault or `BOOKING_HOST_EMAIL` / `BOOKING_HOST_PASSWORD`):

```bash
PI_APARTMENTS_JSON='[{"aptId":"b1","aptName":"Birdhouse","bookingHotelId":"10980606"}]' \
  npm run pull:platform-invoices -- --month=2026-07 --channel=booking --out=/tmp/pi-out
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

3. **Upload Booking.com zip** — on admin.booking.com go to Finance → Invoices, download
   the month’s PDFs as a zip, then **Upload Booking.com zip** on Collect. The server
   reads each PDF’s hotel id and issue month, maps via Configuration
   **Booking.com hotel / apartment id**, and files under
   `Booking.com/{YYYY-MM}/{apartment}/`. Votsala 1–8 share one id / one PDF.
   Unmapped ids land in `unmapped-{id}` until you paste the id and upload again
   (delete the unmapped row first if the same invoice number is already in the vault).

4. **Pull Airbnb** for the selected month (incomplete stays first; already-saved
   invoices skipped).

5. Review → Ship.

If Airbnb Pull returns 0 PDFs with “session expired”, Connect Airbnb again (sessions
expire). Do not paste Airbnb invoices by hand.

**Pull Booking.com** and **Connect Booking** stay under **Emergency manual tools**.
Connect Booking opens headed Chrome on the server (`admin.booking.com`). If the
page says **Sign-in failed / Try again later**, or Booking.com returns **403/429**,
that is Booking.com blocking the Railway IP — not a wrong password. Do not retry;
waiting a minute makes the block last longer. The cooldown is stored in Postgres
(`pi_booking_block`) so a redeploy does not forget it. **Pull Booking** uses the
same cooldown and will not run a password login while it is active. Leave Collect
closed for several hours, or set `PLAYWRIGHT_PROXY_SERVER` to a residential proxy.
