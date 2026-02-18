#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-yzliu@100.114.240.117}"
ROOT="${ROOT:-/Users/yzliu/work/projects/rdloop}"
QUEUE_DIR="$ROOT/out/cursor_queue"

PROMPT="${*:-Say hello in one sentence.}"
ID="$(date +%s)-$RANDOM"

tmp="$(mktemp)"
printf "%s" "$PROMPT" > "$tmp"
scp "$tmp" "$HOST:$QUEUE_DIR/$ID.job" >/dev/null
rm -f "$tmp"

echo "enqueued id=$ID"
echo "check: ssh $HOST \"cat $ROOT/out/cursor_out/$ID.response.txt; echo; cat $ROOT/out/cursor_out/$ID.rc\""
