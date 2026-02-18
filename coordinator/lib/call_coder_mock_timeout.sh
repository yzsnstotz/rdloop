#!/usr/bin/env bash
# call_coder_mock_timeout.sh — Mock coder that sleeps forever (for timeout tests)
# Interface: $1=task_json_path $2=attempt_dir $3=worktree_dir $4=instruction_path
# Will be killed by timeout (rc=124) when coder_timeout_seconds is small.

set -uo pipefail

task_json_path="$1"
attempt_dir="$2"
worktree_dir="$3"
instruction_path="$4"

mkdir -p "${attempt_dir}/coder"

{
  echo "[CODER][mock_timeout] $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting mock_timeout coder"
  echo "[CODER][mock_timeout] Sleeping to trigger timeout..."
} > "${attempt_dir}/coder/run.log" 2>&1

# Sleep long enough to be killed by timeout
sleep 300

echo "0" > "${attempt_dir}/coder/rc.txt"
exit 0
