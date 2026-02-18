#!/usr/bin/env bash
# call_judge_mock_need_input.sh — Mock judge that returns NEED_USER_INPUT verdict
# Interface: $1=task_json_path $2=evidence_json_path $3=out_attempt_dir $4=judge_prompt_path

set -uo pipefail

task_json_path="$1"
evidence_json_path="$2"
out_attempt_dir="$3"
judge_prompt_path="$4"

mkdir -p "${out_attempt_dir}/judge"

cat > "${out_attempt_dir}/judge/verdict.json" <<'ENDJSON'
{
  "schema_version": "v1",
  "decision": "NEED_USER_INPUT",
  "reasons": ["Cannot determine pass/fail without user clarification"],
  "next_instructions": "Please clarify the acceptance criteria.",
  "questions_for_user": ["What is the expected output format?", "Should edge cases be handled?"]
}
ENDJSON

exit 0
