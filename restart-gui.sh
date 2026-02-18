#!/usr/bin/env zsh
# Restart rdloop GUI: kill process on port 17333 if any, then start server.
# Usage: ./restart-gui.sh   (from repo root)

set -e
SCRIPT_DIR="${0:A:h}"
REPO_ROOT="${SCRIPT_DIR:A}"
PORT=17333
GUI_DIR="${REPO_ROOT}/gui"
LOG_FILE="${GUI_DIR}/gui-server.log"

cd -q "$REPO_ROOT"

# Find PIDs listening on PORT
PIDS=$(lsof -ti :"$PORT" 2>/dev/null || true)
if [[ -n "$PIDS" ]]; then
  echo "Stopping existing process(es) on port $PORT: $PIDS"
  echo "$PIDS" | xargs kill 2>/dev/null || true
  sleep 1
  # Force kill if still in use
  REMAIN=$(lsof -ti :"$PORT" 2>/dev/null || true)
  if [[ -n "$REMAIN" ]]; then
    echo "Force killing: $REMAIN"
    echo "$REMAIN" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
fi

echo "Starting rdloop GUI on port $PORT ..."
cd -q "$GUI_DIR"
nohup npm start >> "$LOG_FILE" 2>&1 &
sleep 2
if lsof -i :"$PORT" >/dev/null 2>&1; then
  echo "rdloop GUI running at http://localhost:$PORT (logs: $LOG_FILE)"
else
  echo "Start may have failed; check $LOG_FILE"
  exit 1
fi
