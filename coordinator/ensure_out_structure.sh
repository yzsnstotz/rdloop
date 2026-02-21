#!/usr/bin/env bash
# coordinator/ensure_out_structure.sh — Ensure out/ has task-type directories for run results
# Usage: bash coordinator/ensure_out_structure.sh [out_dir]
# Creates: out/<task_type>/ and out/requirements_doc/test/ for classified runs.

set -euo pipefail
RDLOOP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-${RDLOOP_ROOT}/out}"

mkdir -p "${OUT_DIR}/_default"
mkdir -p "${OUT_DIR}/requirements_doc"
mkdir -p "${OUT_DIR}/requirements_doc/test"
mkdir -p "${OUT_DIR}/engineering_impl"
echo "Ensured output structure under ${OUT_DIR}: _default, requirements_doc/test, engineering_impl"
