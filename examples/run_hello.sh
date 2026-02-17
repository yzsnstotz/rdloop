#!/usr/bin/env bash
# examples/run_hello.sh — Run the hello_world basic loop example
# Expects: RC=0, final_summary.decision=READY_FOR_REVIEW
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Clean previous run if exists
if [ -d "${RDLOOP_ROOT}/out/hello_world" ]; then
  rm -rf "${RDLOOP_ROOT}/out/hello_world"
fi
if [ -d "${RDLOOP_ROOT}/worktrees/hello_world" ]; then
  rm -rf "${RDLOOP_ROOT}/worktrees/hello_world"
fi

# Ensure dummy_repo is a proper git repo
DUMMY="${SCRIPT_DIR}/dummy_repo"
if [ ! -d "${DUMMY}/.git" ]; then
  (cd "$DUMMY" && git init && echo "# Dummy" > README.md && git add -A && git commit -m "Initial commit")
fi

echo "=== Running hello_world task ==="
bash "${RDLOOP_ROOT}/coordinator/run_task.sh" "${SCRIPT_DIR}/task_hello.json"
rc=$?

echo ""
echo "=== Result ==="
echo "Exit code: ${rc}"

if [ -f "${RDLOOP_ROOT}/out/hello_world/final_summary.json" ]; then
  echo "final_summary.json:"
  cat "${RDLOOP_ROOT}/out/hello_world/final_summary.json"
  echo ""
  decision=$(python3 -c "import json; print(json.load(open('${RDLOOP_ROOT}/out/hello_world/final_summary.json'))['decision'])" 2>/dev/null || echo "UNKNOWN")
  if [ "$decision" = "READY_FOR_REVIEW" ]; then
    echo "SUCCESS: decision = READY_FOR_REVIEW"
  else
    echo "FAILURE: decision = ${decision} (expected READY_FOR_REVIEW)"
    exit 1
  fi
else
  echo "FAILURE: final_summary.json not found"
  exit 1
fi

exit $rc
