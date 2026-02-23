#!/usr/bin/env bash
# call_coder_codex.sh — Codex CLI coder adapter for rdloop
# Interface: $1=task_json_path $2=attempt_dir $3=worktree_dir $4=instruction_path
# Outputs: attempt_dir/coder/run.log, attempt_dir/coder/rc.txt
# Uses task.codex_cmd (default "codex"). Runs non-interactively via "codex exec -" (stdin).
# See: https://developers.openai.com/codex/noninteractive/

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

# Ensure worktree is set; empty worktree would break cd and codex (requires git repo)
if [ -z "${worktree_dir}" ] && [ -n "${RDLOOP_ROOT:-}" ]; then
  worktree_dir="${RDLOOP_ROOT}"
  echo "[CODER][codex] WARNING: worktree_dir was empty, using RDLOOP_ROOT" >> "${attempt_dir}/coder/run.log" 2>/dev/null || true
fi

# B1-4: Use "codex exec -" for non-interactive (avoids "stdin is not a terminal" when piping).
# --ephemeral: do not persist session; --full-auto: allow file edits in workspace.
run_log="${attempt_dir}/coder/run.log"
{
  echo "[CODER][codex] $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting codex exec (non-interactive)"
  echo "[CODER][codex] worktree: ${worktree_dir}"
  echo "[CODER][codex] codex_cmd: ${codex_cmd}"
  if [ -n "$worktree_dir" ] && [ -d "$worktree_dir" ]; then
    cd "$worktree_dir" || exit 1
  else
    echo "[CODER][codex] ERROR: worktree_dir missing or not a directory: ${worktree_dir}"
    exit 1
  fi
  printf '%s' "$instruction" > "${attempt_dir}/coder/.instruction_tmp"
  "$codex_cmd" exec --ephemeral --full-auto - < "${attempt_dir}/coder/.instruction_tmp" 2>&1
  echo $? > "${attempt_dir}/coder/rc.txt"
  echo "[CODER][codex] $(date -u +%Y-%m-%dT%H:%M:%SZ) Codex coder finished"
  rm -f "${attempt_dir}/coder/.instruction_tmp"
} > "$run_log" 2>&1
if [ ! -f "${attempt_dir}/coder/rc.txt" ]; then
  echo "1" > "${attempt_dir}/coder/rc.txt"
fi
coder_rc=$(cat "${attempt_dir}/coder/rc.txt" 2>/dev/null)
coder_rc=${coder_rc:-1}
exit "$coder_rc"
