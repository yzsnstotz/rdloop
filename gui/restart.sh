#!/usr/bin/env bash
# Stop the GUI service on port 17333 (if running) and start it again.
# Run from repo root or from gui/:  bash gui/restart.sh

set -e
GUI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=17333

# Stop existing process on PORT
pid=""
if command -v lsof >/dev/null 2>&1; then
  pid=$(lsof -i :"$PORT" -t 2>/dev/null || true)
fi
if [ -n "$pid" ]; then
  echo "Stopping existing process (PID $pid) on port $PORT..."
  kill "$pid" 2>/dev/null || true
  sleep 1
  # Force kill if still alive
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi
fi

echo "Starting GUI server on http://localhost:$PORT"
cd "$GUI_DIR"
exec node server.js
