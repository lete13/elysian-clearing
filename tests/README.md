# tests/ — patch-chain regressions (no live Hosthub / Airbnb required)
#
# npm test runs:
#   monthly-close-patches.test.js   — FE+SRV chain integrity + calcBase golden lock
#   airbnb-auth-flow.test.js        — OTP/captcha helpers on effective server
#   daily-ops-checkin-schedule.test.js — Daily Ops check-in / checkout scheduling
#   daily-ops-clean-persist.test.js — cleaning-schedule persist / stuck-clean keys
#
# Also: npm run test:platform-invoices (worker + vault wiring, string-level)
#
# Pattern: apply fe/ and/or srv/ chains exactly like boot, then assert on the
# effective source (vm or string). If a new patches-N.json breaks a hash gate,
# these fail before Railway does.
