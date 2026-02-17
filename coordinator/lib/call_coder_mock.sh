#!/usr/bin/env bash
# call_coder_mock.sh — Mock coder adapter for rdloop
# Interface: $1=task_json_path $2=attempt_dir $3=worktree_dir $4=instruction_path
# Outputs: attempt_dir/coder/run.log, attempt_dir/coder/rc.txt
# Mock coder: logs instruction, does not modify code. Always succeeds (rc=0).

set -uo pipefail

task_json_path="$1"
attempt_dir="$2"
worktree_dir="$3"
instruction_path="$4"

mkdir -p "${attempt_dir}/coder"

{
  echo "[CODER][mock] $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting mock coder"
  echo "[CODER][mock] task_json: ${task_json_path}"
  echo "[CODER][mock] worktree: ${worktree_dir}"
  echo "[CODER][mock] instruction: ${instruction_path}"
  if [ -f "$instruction_path" ]; then
    echo "[CODER][mock] === INSTRUCTION CONTENT ==="
    cat "$instruction_path"
    echo ""
    echo "[CODER][mock] === END INSTRUCTION ==="
  fi
  echo "[CODER][mock] Mock coder does not modify any files."
  echo "[CODER][mock] $(date -u +%Y-%m-%dT%H:%M:%SZ) Mock coder finished successfully."
} > "${attempt_dir}/coder/run.log" 2>&1

echo "0" > "${attempt_dir}/coder/rc.txt"
exit 0
