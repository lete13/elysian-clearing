#!/usr/bin/env bash
# Launches the Elysian Clearing app server for the Cloud Agent "app" terminal.
# Runs through the repo's own scripts/docker-start.sh entrypoint (starts Xvfb for
# headed Chrome, then `node srv-boot.js`).
#
# DEV ISOLATION: this always points the app at the isolated *local* PostgreSQL,
# never the production DATABASE_URL secret, so a cloud agent can never read or
# write the shared production database.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

export DATABASE_URL="postgresql://elysian:elysian@localhost:5432/elysian"
export APP_PASSWORD="${APP_PASSWORD_DEV:-elysian-dev}"
export PORT="${PORT:-3000}"

echo "[run] Elysian Clearing → http://localhost:${PORT}  (login: any username + password '${APP_PASSWORD}')"
exec bash scripts/docker-start.sh
