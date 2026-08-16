#!/bin/sh
# Headed Chrome for Booking.com Connect. HeadlessChrome is blocked on Next.
set -eu
if [ -z "${DISPLAY:-}" ]; then
  if command -v Xvfb >/dev/null 2>&1; then
    export DISPLAY=:99
    Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
    sleep 0.5
  fi
fi
exec node srv-boot.js
