#!/usr/bin/env bash
# call_judge_mock_timeout.sh — Mock judge that sleeps forever (for timeout tests)
# Interface: $1=task_json_path $2=evidence_json_path $3=out_attempt_dir $4=judge_prompt_path
# Will be killed by timeout (rc=124) when judge_timeout_seconds is small.

set -uo pipefail

task_json_path="$1"
evidence_json_path="$2"
out_attempt_dir="$3"
judge_prompt_path="$4"

mkdir -p "${out_attempt_dir}/judge"

# Sleep long enough to be killed by timeout
sleep 300

cat > "${out_attempt_dir}/judge/verdict.json" <<'ENDJSON'
{
  "schema_version": "v1",
  "decision": "PASS",
  "reasons": ["This should never be written"],
  "next_instructions": "",
  "questions_for_user": []
}
ENDJSON

exit 0
