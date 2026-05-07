#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /Users/akiratsunoda/nanoclaw-sandbox-9450/nanoclaw.pid)

set -euo pipefail

cd "/Users/akiratsunoda/nanoclaw-sandbox-9450"

# Stop existing instance if running
if [ -f "/Users/akiratsunoda/nanoclaw-sandbox-9450/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/Users/akiratsunoda/nanoclaw-sandbox-9450/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/Users/akiratsunoda/.nix-profile/bin/node" "/Users/akiratsunoda/nanoclaw-sandbox-9450/dist/index.js" \
  >> "/Users/akiratsunoda/nanoclaw-sandbox-9450/logs/nanoclaw.log" \
  2>> "/Users/akiratsunoda/nanoclaw-sandbox-9450/logs/nanoclaw.error.log" &

echo $! > "/Users/akiratsunoda/nanoclaw-sandbox-9450/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /Users/akiratsunoda/nanoclaw-sandbox-9450/logs/nanoclaw.log"
