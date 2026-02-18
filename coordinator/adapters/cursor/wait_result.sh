#!/usr/bin/env bash
set -euo pipefail
ID="$1"
OUT="$HOME/work/projects/rdloop/out/cursor_out"
for i in {1..200}; do
  [[ -f "$OUT/$ID.rc" ]] && exit 0
  sleep 0.2
done
echo "timeout waiting rc for $ID" >&2
exit 124
