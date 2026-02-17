#!/usr/bin/env bash
# call_coder_cursor.sh — Cursor CLI coder adapter for rdloop
# Interface: $1=task_json_path $2=attempt_dir $3=worktree_dir $4=instruction_path
# Outputs: attempt_dir/coder/run.log, attempt_dir/coder/rc.txt
# Uses task.cursor_cmd (default "cursor") to invoke Cursor CLI.

set -uo pipefail

task_json_path="$1"
attempt_dir="$2"
worktree_dir="$3"
instruction_path="$4"

mkdir -p "${attempt_dir}/coder"

# Read cursor_cmd from task spec
cursor_cmd=$(python3 -c "
import json, sys
try:
    with open('${task_json_path}') as f:
        d = json.load(f)
    print(d.get('cursor_cmd', 'cursor'))
except:
    print('cursor')
" 2>/dev/null || echo "cursor")

# Check cursor availability
if ! command -v "$cursor_cmd" >/dev/null 2>&1; then
  {
    echo "[CODER][cursor] $(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: cursor CLI not found"
    echo "[CODER][cursor] cursor_cmd=${cursor_cmd}"
    echo "[CODER][cursor] Please install Cursor CLI or fix PATH"
  } > "${attempt_dir}/coder/run.log" 2>&1
  echo "127" > "${attempt_dir}/coder/rc.txt"
  exit 127
fi

# Read instruction
instruction=""
if [ -f "$instruction_path" ]; then
  instruction=$(cat "$instruction_path")
fi

# Call cursor CLI
{
  echo "[CODER][cursor] $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting cursor coder"
  echo "[CODER][cursor] worktree: ${worktree_dir}"
  echo "[CODER][cursor] cursor_cmd: ${cursor_cmd}"
  cd "$worktree_dir"
  echo "$instruction" | "$cursor_cmd" 2>&1
  echo "[CODER][cursor] $(date -u +%Y-%m-%dT%H:%M:%SZ) Cursor coder finished"
} > "${attempt_dir}/coder/run.log" 2>&1
coder_rc=${PIPESTATUS[0]:-$?}

echo "$coder_rc" > "${attempt_dir}/coder/rc.txt"
exit "$coder_rc"
