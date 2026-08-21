#!/usr/bin/env bash
# Cloud Agent install script for Elysian Clearing.
# Idempotent: runs on every Build and may run against previously prepared disk state.
# Prepares durable, source-derived state only (deps + Playwright browser). Long-running
# services (PostgreSQL, the app server) are started from start.sh / the app terminal.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "[install] repo:  $REPO_DIR"
echo "[install] node:  $(node --version)   npm: $(npm --version)"

# ── 1. System packages ────────────────────────────────────────────────────────
#   postgresql        — isolated local dev database (see start.sh)
#   xvfb              — headed Chrome for the Booking.com Connect automation
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends postgresql postgresql-client xvfb

# ── 2. Node dependencies ──────────────────────────────────────────────────────
# Skip Playwright's postinstall browser download here; we install the pinned
# browser explicitly below so the step is visible and idempotent.
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install

# ── 3. Playwright Chromium (pinned via package.json) + its OS libraries ───────
# install-deps needs root; the browser binary is installed as the current (runtime)
# user so the app can find it under ~/.cache/ms-playwright. Non-fatal on failure so
# the core web app still boots even if the browser download is unavailable.
# `sudo env "PATH=$PATH"` preserves the user's PATH so the Node-based Playwright
# CLI is found (sudo's secure_path drops nvm/custom node locations otherwise).
sudo env "PATH=$PATH" ./node_modules/.bin/playwright install-deps chromium || \
  echo "[install] WARN: playwright install-deps failed (Booking.com automation may not work)"
./node_modules/.bin/playwright install chromium || \
  echo "[install] WARN: chromium download failed (Booking.com automation may not work)"

echo "[install] done"
