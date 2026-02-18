#!/usr/bin/env bash
# call_judge_cursor.sh — Cursor judge adapter via queue (README: Cursor execution)
# Interface: $1=task_json_path $2=evidence_json_path $3=out_attempt_dir $4=judge_prompt_path
# Outputs: out_attempt_dir/judge/verdict.json
# Does NOT call cursor-agent directly; uses coordinator/adapters/cursor_queue_cli.sh only.

set -uo pipefail

task_json_path="$1"
evidence_json_path="$2"
out_attempt_dir="$3"
judge_prompt_path="$4"

mkdir -p "${out_attempt_dir}/judge"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUEUE_CLI="${SCRIPT_DIR}/../adapters/cursor_queue_cli.sh"

if [ ! -f "$QUEUE_CLI" ] || [ ! -x "$QUEUE_CLI" ]; then
  cat > "${out_attempt_dir}/judge/verdict.json" <<'ENDJSON'
{
  "schema_version": "v1",
  "decision": "NEED_USER_INPUT",
  "reasons": ["Cursor execution must go through queue (README ## Cursor execution). cursor_queue_cli.sh not found or not executable."],
  "next_instructions": "",
  "questions_for_user": ["Ensure coordinator/adapters/cursor_queue_cli.sh exists and the queue worker is running. Do not call cursor-agent directly."]
}
ENDJSON
  echo "127" > "${out_attempt_dir}/judge/rc.txt"
  exit 127
fi

# Timeout from task spec (default 300)
judge_timeout="300"
if [ -f "$task_json_path" ]; then
  judge_timeout=$(python3 -c "
import json
try:
    with open('${task_json_path}') as f:
        d = json.load(f)
    print(d.get('judge_timeout_seconds', 300))
except:
    print(300)
" 2>/dev/null || echo "300")
fi

# Job id for queue (e.g. judge_attempt_001)
ATTEMPT_ID=$(basename "$out_attempt_dir")
JOB_ID="judge_${ATTEMPT_ID}"

# Prepare prompt file: judge prompt + evidence
tmp_stdin="${out_attempt_dir}/judge/stdin.txt"
if [ -f "$judge_prompt_path" ]; then
  cat "$judge_prompt_path" > "$tmp_stdin"
else
  printf '' > "$tmp_stdin"
fi
echo "---" >> "$tmp_stdin"
cat "$evidence_json_path" >> "$tmp_stdin"

tmp_verdict="${out_attempt_dir}/judge/verdict.tmp.json"
bash "$QUEUE_CLI" --id "$JOB_ID" --timeout "$judge_timeout" --prompt-file "$tmp_stdin" > "$tmp_verdict" 2>"${out_attempt_dir}/judge/cursor_stderr.log"
cursor_rc=$?
rm -f "$tmp_stdin"

if [ $cursor_rc -ne 0 ]; then
  echo "$cursor_rc" > "${out_attempt_dir}/judge/rc.txt"
  exit $cursor_rc
fi

# Extract and validate JSON from output (cursor may wrap in markdown or extra text)
python3 -c "
import json, sys, re
with open('${tmp_verdict}') as f:
    raw = f.read()
d = None
try:
    d = json.loads(raw)
except:
    pass
if d is None:
    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if m:
        try:
            d = json.loads(m.group())
        except:
            pass
if d is None:
    sys.stderr.write('Could not extract JSON from cursor output\n')
    sys.exit(1)
required_v1 = ['decision', 'reasons', 'next_instructions', 'questions_for_user']
missing = [f for f in required_v1 if f not in d]
if missing:
    sys.stderr.write(f'Extracted JSON missing required fields: {missing}\\n')
    sys.exit(1)
if not isinstance(d.get('decision'), str):
    sys.stderr.write('decision must be a string\\n')
    sys.exit(1)
if not isinstance(d.get('reasons'), list) or len(d['reasons']) == 0:
    sys.stderr.write('reasons must be a non-empty array\\n')
    sys.exit(1)
if not isinstance(d.get('next_instructions'), str):
    sys.stderr.write('next_instructions must be a string\\n')
    sys.exit(1)
if not isinstance(d.get('questions_for_user'), list):
    sys.stderr.write('questions_for_user must be an array\\n')
    sys.exit(1)
if 'schema_version' not in d:
    d['schema_version'] = 'v1'
print(json.dumps(d, indent=2))
sys.exit(0)
" > "${out_attempt_dir}/judge/verdict.json" 2>"${out_attempt_dir}/judge/extract_err.log"
extract_rc=$?

if [ $extract_rc -ne 0 ]; then
  cat > "${out_attempt_dir}/judge/verdict.json" <<'ENDJSON'
{
  "schema_version": "v1",
  "decision": "NEED_USER_INPUT",
  "reasons": ["Judge CLI output was not valid JSON or missing required fields. Check judge/verdict.tmp.json, extract_err.log, or cursor_stderr.log."],
  "next_instructions": "",
  "questions_for_user": ["Fix judge prompt or CLI so it returns valid verdict JSON with: decision (string), reasons (non-empty array), next_instructions (string), questions_for_user (array)."]
}
ENDJSON
  echo "0" > "${out_attempt_dir}/judge/rc.txt"
  exit 0
fi

rm -f "$tmp_verdict"
echo "0" > "${out_attempt_dir}/judge/rc.txt"
exit 0
