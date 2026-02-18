#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/work/projects/rdloop"
WORKDIR="$ROOT"
QUEUE_DIR="$ROOT/out/cursor_queue"
OUT_DIR="$ROOT/out/cursor_out"

mkdir -p "$QUEUE_DIR" "$OUT_DIR"

# Optional API key (if /Users/yzliu/.local/bin/cursor-agent honors it)
if [[ -f "$HOME/.config/cursor/api_key" ]]; then
  export CURSOR_API_KEY="$(tr -d "\r\n" < "$HOME/.config/cursor/api_key")"
fi

log() { printf "%s %s\n" "$(date "+%F %T")" "$*" >> "$OUT_DIR/worker.log"; }

if [[ ! -d "$WORKDIR" ]]; then
  log "FATAL: WORKDIR missing: $WORKDIR"
  exit 1
fi

log "worker started (pid=$$ workdir=$WORKDIR)"

while true; do
  shopt -s nullglob
  for job in "$QUEUE_DIR"/*.job; do
    id="$(basename "$job" .job)"
    req="$OUT_DIR/$id.request.txt"
    res="$OUT_DIR/$id.response.txt"
    rcfile="$OUT_DIR/$id.rc"

    mv "$job" "$req"
    log "processing id=$id"

    prompt="$(cat "$req")"

    set +e
    cd "$WORKDIR"
    /Users/yzliu/.local/bin/cursor-agent --trust --print "$prompt" > "$res" 2>&1
    rc=$?
    set -e

    printf "%s\n" "$rc" > "$rcfile"
    log "done id=$id rc=$rc"
  done
  sleep 1
done
