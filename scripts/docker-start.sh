#!/bin/sh
# Headed Chrome for Booking.com Connect. HeadlessChrome is blocked on Next.
set -eu
export DISPLAY="${DISPLAY:-:99}"
sock="/tmp/.X11-unix/X$(echo "$DISPLAY" | tr -d ':' | cut -d. -f1)"
if command -v Xvfb >/dev/null 2>&1 && [ ! -S "$sock" ] && [ ! -e "$sock" ]; then
  Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
  sleep 0.5
fi
exec node srv-boot.js
