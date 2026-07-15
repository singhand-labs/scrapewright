#!/usr/bin/env bash
set -eo pipefail

# Start host.js in background
node /app/native-host/host.js &
HOST_PID=$!

# Wait briefly for host to bind port
sleep 1

# Start Chrome
CHROME_ARGS=(
  --no-first-run
  --no-sandbox
  --disable-gpu
  --disable-default-apps
  --disable-background-networking
  --user-data-dir=/tmp/chrome-profile
  --load-extension=/app/extension
)

if [[ "${HEADLESS:-true}" == "true" ]]; then
  CHROME_ARGS+=(--headless=new)
fi

google-chrome-stable "${CHROME_ARGS[@]}" &
CHROME_PID=$!

# Wait for either process to exit
wait -n $HOST_PID $CHROME_PID 2>/dev/null || true

# If one exits, kill the other
kill $HOST_PID $CHROME_PID 2>/dev/null || true
wait 2>/dev/null || true
