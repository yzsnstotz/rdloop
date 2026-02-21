#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Running claude_bridge tests ==="
echo "Node: $(node --version)"
echo ""

node --test \
  tests/unit/claude_bridge_ipc.test.js \
  tests/unit/claude_bridge_patterns.test.js \
  tests/unit/claude_bridge_e2e.test.js

echo ""
echo "=== All tests passed ==="
