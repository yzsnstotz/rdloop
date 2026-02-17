#!/usr/bin/env bash
# call_judge_mock.sh — Mock judge adapter for rdloop
# Interface: $1=task_json_path $2=evidence_json_path $3=out_attempt_dir $4=judge_prompt_path
# Outputs: out_attempt_dir/judge/verdict.json
# Mock judge: test rc==0 → PASS; otherwise FAIL with actionable next_instructions.

set -uo pipefail

task_json_path="$1"
evidence_json_path="$2"
out_attempt_dir="$3"
judge_prompt_path="$4"

mkdir -p "${out_attempt_dir}/judge"

# Read test rc from evidence
test_rc=""
if [ -f "$evidence_json_path" ]; then
  # Extract test.rc using python (Bash 3.2 compatible)
  test_rc=$(python3 -c "
import json, sys
try:
    with open('${evidence_json_path}') as f:
        d = json.load(f)
    print(d.get('test', {}).get('rc', 1))
except:
    print(1)
" 2>/dev/null || echo "1")
fi

if [ "$test_rc" = "0" ]; then
  cat > "${out_attempt_dir}/judge/verdict.json" <<'ENDJSON'
{
  "schema_version": "v1",
  "decision": "PASS",
  "reasons": ["All tests passed (rc=0)", "Mock judge auto-approves on test success"],
  "next_instructions": "",
  "questions_for_user": []
}
ENDJSON
else
  cat > "${out_attempt_dir}/judge/verdict.json" <<ENDJSON
{
  "schema_version": "v1",
  "decision": "FAIL",
  "reasons": ["Test failed with rc=${test_rc}"],
  "next_instructions": "Fix the test failures. Check test/stdout.log in the attempt directory for error details. Run the test command again after fixing.",
  "questions_for_user": []
}
ENDJSON
fi

exit 0
