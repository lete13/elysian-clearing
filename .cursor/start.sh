#!/usr/bin/env bash
# Cloud Agent start script for Elysian Clearing.
# Per-boot reconciliation: bring up the isolated local PostgreSQL and ensure the
# dev role/database exist. Idempotent, tolerates restarts, and returns (the app
# server itself runs in the "app" terminal, not here).
set -euo pipefail

PG_MAJOR="$(ls /usr/lib/postgresql 2>/dev/null | sort -n | tail -1 || true)"
PG_MAJOR="${PG_MAJOR:-16}"

echo "[start] starting PostgreSQL cluster ${PG_MAJOR}/main"
sudo pg_ctlcluster "${PG_MAJOR}" main start 2>/dev/null || true

# Wait for the server to accept connections.
for _ in $(seq 1 30); do
  if sudo -u postgres pg_isready -q 2>/dev/null; then break; fi
  sleep 1
done
if ! sudo -u postgres pg_isready -q 2>/dev/null; then
  echo "[start] ERROR: PostgreSQL did not become ready" >&2
  exit 1
fi

# Create the dev role + database if they do not exist yet (idempotent).
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='elysian'" | grep -q 1 || \
  sudo -u postgres psql -q -c "CREATE ROLE elysian LOGIN PASSWORD 'elysian';"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='elysian'" | grep -q 1 || \
  sudo -u postgres createdb -O elysian elysian

echo "[start] local PostgreSQL ready → postgresql://elysian:elysian@localhost:5432/elysian"
