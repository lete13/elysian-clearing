# Platform invoice pull (Airbnb / Booking.com portals)

## Cadence
As soon as portal documents exist after month-end (**ASAP**).

## Dating
- **Booking.com** — one invoice the **month after** the bookings month (June bookings → July invoice).
- **Airbnb VAT invoice** — issue month = Hosthub **created** date (confirmation).
- **Airbnb credit note** — issued on cancel; issue month = Hosthub **cancelledAt**. A booking confirmed in month A and cancelled in month B needs **both** documents (invoice in A, credit note in B).

## App today
Upload / pack / email + **Hosthub health check**. Portal auto-download next.

## Railway
`PLATFORM_INVOICE_ACCOUNTANT_EMAIL` (default `info@e-newgeneration.gr, info@elysianproperties.eu`) · `AIRBNB_HOST_*` · `BOOKING_HOST_*`
