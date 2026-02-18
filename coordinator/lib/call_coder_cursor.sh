#!/usr/bin/env bash
# call_coder_cursor.sh — Cursor coder adapter via queue (README: Cursor execution)
# Interface: $1=task_json_path $2=attempt_dir $3=worktree_dir $4=instruction_path
# Outputs: attempt_dir/coder/run.log, attempt_dir/coder/rc.txt
# Does NOT call cursor-agent directly; uses coordinator/adapters/cursor_queue_cli.sh only.

set -uo pipefail

task_json_path="$1"
attempt_dir="$2"
worktree_dir="$3"
instruction_path="$4"

mkdir -p "${attempt_dir}/coder"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUEUE_CLI="${SCRIPT_DIR}/../adapters/cursor_queue_cli.sh"

if [ ! -f "$QUEUE_CLI" ] || [ ! -x "$QUEUE_CLI" ]; then
  {
    echo "[CODER][cursor] $(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: Cursor queue CLI required (README ## Cursor execution)"
    echo "[CODER][cursor] Do not call cursor-agent directly. Missing or not executable: $QUEUE_CLI"
  } > "${attempt_dir}/coder/run.log" 2>&1
  echo "127" > "${attempt_dir}/coder/rc.txt"
  exit 127
fi

# Timeout from task spec (default 600)
coder_timeout="600"
if [ -f "$task_json_path" ]; then
  coder_timeout=$(python3 -c "
import json
try:
    with open('${task_json_path}') as f:
        d = json.load(f)
    print(d.get('coder_timeout_seconds', 600))
except:
    print(600)
" 2>/dev/null || echo "600")
fi

# Job id for queue (e.g. attempt_001)
ATTEMPT_ID=$(basename "$attempt_dir")

instruction=""
if [ -f "$instruction_path" ]; then
  instruction=$(cat "$instruction_path")
fi

full_prompt="You are working in directory: ${worktree_dir}
Please make all file changes inside that directory.

${instruction}"

{
  echo "[CODER][cursor] $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting cursor coder via queue"
  echo "[CODER][cursor] worktree: ${worktree_dir}"
  echo "[CODER][cursor] queue CLI: ${QUEUE_CLI} --id ${ATTEMPT_ID} --timeout ${coder_timeout}"
  bash "$QUEUE_CLI" --id "$ATTEMPT_ID" --timeout "$coder_timeout" "$full_prompt" 2>&1
  echo "[CODER][cursor] $(date -u +%Y-%m-%dT%H:%M:%SZ) Cursor coder finished"
} > "${attempt_dir}/coder/run.log" 2>&1
coder_rc=$?

echo "$coder_rc" > "${attempt_dir}/coder/rc.txt"
exit "$coder_rc"
