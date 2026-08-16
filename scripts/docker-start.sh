#!/bin/sh
# Headed Chrome for Booking.com Connect. HeadlessChrome is blocked on Next.
# Never skip Xvfb just because DISPLAY is already set (Railway images set DISPLAY=:99).
set -eu
export DISPLAY="${DISPLAY:-:99}"
n=$(echo "$DISPLAY" | tr -d ':' | cut -d. -f1)
sock="/tmp/.X11-unix/X$n"
if command -v Xvfb >/dev/null 2>&1 && [ ! -S "$sock" ] && [ ! -e "$sock" ]; then
  Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
fi
i=0
while [ "$i" -lt 20 ] && [ ! -e "$sock" ]; do
  i=$((i + 1))
  sleep 0.2
done
if [ ! -e "$sock" ]; then
  echo "[docker-start] Xvfb socket missing at $sock — Booking.com Connect will refuse HeadlessChrome" >&2
fi
exec node srv-boot.js
