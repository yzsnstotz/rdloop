#!/usr/bin/env bash
# call_coder_claude_bridge.sh — Claude CLI coder adapter with Telegram bridge
# Interface: $1=task_json_path $2=attempt_dir $3=worktree_dir $4=instruction_path
# Outputs: attempt_dir/coder/run.log, attempt_dir/coder/rc.txt
#
# Spawns Claude CLI via claude_bridge/monitor.js for interactive
# permission approval and usage-limit notifications through OpenClaw/Telegram.

set -uo pipefail

task_json_path="$1"
attempt_dir="$2"
worktree_dir="$3"
instruction_path="$4"

mkdir -p "${attempt_dir}/coder"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RDLOOP_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BRIDGE_INDEX="${RDLOOP_ROOT}/claude_bridge/index.js"

if [ ! -f "$BRIDGE_INDEX" ]; then
  {
    echo "[CODER][claude-bridge] $(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: claude_bridge/index.js not found"
    echo "[CODER][claude-bridge] Expected at: ${BRIDGE_INDEX}"
  } > "${attempt_dir}/coder/run.log" 2>&1
  echo "127" > "${attempt_dir}/coder/rc.txt"
  exit 127
fi

claude_cmd="claude"
if [ -f "$task_json_path" ]; then
  claude_cmd=$(python3 -c "
import json
try:
    with open('${task_json_path}') as f:
        d = json.load(f)
    print(d.get('claude_cmd', 'claude'))
except:
    print('claude')
" 2>/dev/null || echo "claude")
fi

if ! command -v "$claude_cmd" >/dev/null 2>&1; then
  {
    echo "[CODER][claude-bridge] $(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: claude CLI not found"
    echo "[CODER][claude-bridge] claude_cmd=${claude_cmd}"
  } > "${attempt_dir}/coder/run.log" 2>&1
  echo "127" > "${attempt_dir}/coder/rc.txt"
  exit 127
fi

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

ATTEMPT_ID=$(basename "$attempt_dir")
BRIDGE_DIR="${RDLOOP_ROOT}/out/claude_bridge"

instruction=""
if [ -f "$instruction_path" ]; then
  instruction=$(cat "$instruction_path")
fi

{
  echo "[CODER][claude-bridge] $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting Claude CLI via bridge"
  echo "[CODER][claude-bridge] worktree: ${worktree_dir}"
  echo "[CODER][claude-bridge] session: ${ATTEMPT_ID}"
  echo "[CODER][claude-bridge] bridge_dir: ${BRIDGE_DIR}"

  BRIDGE_DIR="$BRIDGE_DIR" \
  BRIDGE_SESSION_ID="$ATTEMPT_ID" \
  CLAUDE_CMD="$claude_cmd" \
    node "$BRIDGE_INDEX" \
      --bridge-dir "$BRIDGE_DIR" \
      --session-id "$ATTEMPT_ID" \
      --claude-cmd "$claude_cmd" \
      -- -p "$instruction" --cwd "$worktree_dir" 2>&1

  echo "[CODER][claude-bridge] $(date -u +%Y-%m-%dT%H:%M:%SZ) Claude CLI bridge finished"
} > "${attempt_dir}/coder/run.log" 2>&1
coder_rc=$?

echo "$coder_rc" > "${attempt_dir}/coder/rc.txt"
exit "$coder_rc"
