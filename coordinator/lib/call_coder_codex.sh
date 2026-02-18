#!/usr/bin/env bash
# call_coder_codex.sh — Codex CLI coder adapter for rdloop
# Interface: $1=task_json_path $2=attempt_dir $3=worktree_dir $4=instruction_path
# Outputs: attempt_dir/coder/run.log, attempt_dir/coder/rc.txt
# Uses task.codex_cmd (default "codex") to invoke Codex CLI.

set -uo pipefail

task_json_path="$1"
attempt_dir="$2"
worktree_dir="$3"
instruction_path="$4"

mkdir -p "${attempt_dir}/coder"

# Read codex_cmd from task spec
codex_cmd=$(python3 -c "
import json, sys
try:
    with open('${task_json_path}') as f:
        d = json.load(f)
    print(d.get('codex_cmd', 'codex'))
except:
    print('codex')
" 2>/dev/null || echo "codex")

# Check codex availability
if ! command -v "$codex_cmd" >/dev/null 2>&1; then
  {
    echo "[CODER][codex] $(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: codex CLI not found"
    echo "[CODER][codex] codex_cmd=${codex_cmd}"
    echo "[CODER][codex] Please install Codex CLI or fix PATH"
  } > "${attempt_dir}/coder/run.log" 2>&1
  echo "127" > "${attempt_dir}/coder/rc.txt"
  exit 127
fi

# Read instruction
instruction=""
if [ -f "$instruction_path" ]; then
  instruction=$(cat "$instruction_path")
fi

# Call codex CLI in worktree (codex runs in cwd)
{
  echo "[CODER][codex] $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting codex coder"
  echo "[CODER][codex] worktree: ${worktree_dir}"
  echo "[CODER][codex] codex_cmd: ${codex_cmd}"
  cd "$worktree_dir"
  echo "$instruction" | "$codex_cmd" 2>&1
  echo "[CODER][codex] $(date -u +%Y-%m-%dT%H:%M:%SZ) Codex coder finished"
} > "${attempt_dir}/coder/run.log" 2>&1
coder_rc=${PIPESTATUS[0]:-$?}

echo "$coder_rc" > "${attempt_dir}/coder/rc.txt"
exit "$coder_rc"
