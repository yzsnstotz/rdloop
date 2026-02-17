#!/usr/bin/env bash
# examples/run_optimize_openclaw_telegram_req.sh — Run task: optimize OpenClaw Telegram requirements doc
# Repo: rdloop itself (repo_path ".." from examples/). Coder may edit docs/REQUIREMENTS_OPENCLAW_TELEGRAM.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TASK_ID="optimize_openclaw_telegram_req"

echo "=== Running task: ${TASK_ID} ==="
bash "${RDLOOP_ROOT}/coordinator/run_task.sh" "${SCRIPT_DIR}/task_optimize_openclaw_telegram_req.json"
rc=$?

echo ""
echo "=== Result ==="
echo "Exit code: ${rc}"
if [ -f "${RDLOOP_ROOT}/out/${TASK_ID}/final_summary.json" ]; then
  cat "${RDLOOP_ROOT}/out/${TASK_ID}/final_summary.json"
fi
exit $rc
