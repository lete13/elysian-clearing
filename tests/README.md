# tests/ — regressions (no live Hosthub / Airbnb required)
#
# npm test runs:
#   monthly-close-patches.test.js   — consolidated FE/SRV fingerprints + calcBase golden lock
#   airbnb-auth-flow.test.js        — OTP/captcha helpers on effective server
#   daily-ops-checkin-schedule.test.js — Daily Ops check-in / checkout scheduling
#   daily-ops-clean-persist.test.js — cleaning-schedule persist / stuck-clean keys
#
# Also: npm run test:platform-invoices (worker + vault wiring)
#
# Helpers:
#   apply-chain.js                  — apply fe/srv patches when present (empty = no-op)
#   consolidated-assertions.json    — has/hasNot checks from the pre-bake patch files
#   golden-financial-core.snap.json — locked calcBase / golden June 2026 block
#
# After consolidation (2026-08-14), index.html and server.js ARE the effective
# sources. New patch files are optional again; apply-chain skips empty placeholders.
