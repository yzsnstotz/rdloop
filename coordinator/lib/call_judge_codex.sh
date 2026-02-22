#!/usr/bin/env bash
# call_judge_codex.sh — Codex CLI judge adapter for rdloop
# Interface: $1=task_json_path $2=evidence_json_path $3=out_attempt_dir $4=judge_prompt_path
# Outputs: out_attempt_dir/judge/verdict.json
# Uses task.codex_cmd (default "codex") to invoke Codex CLI.

set -uo pipefail

task_json_path="$1"
evidence_json_path="$2"
out_attempt_dir="$3"
judge_prompt_path="$4"

mkdir -p "${out_attempt_dir}/judge"

# B4-6/B4-7: Judge adapter run.log must record temperature=0 or N/A
echo "[JUDGE][codex] $(date -u +%Y-%m-%dT%H:%M:%SZ) temperature=0 (Judge adapter fixed; no temperature config)" >> "${out_attempt_dir}/judge/run.log" 2>/dev/null || true

# Read codex_cmd from task spec
codex_cmd=$(python3 -c "
import json, sys
try:
    with open('${task_json_path}') as f:
        d = json.load(f)
    print(d.get('codex_cmd', 'codex'))
except:
    print('codex')
" 2>/dev/null || echo "codex")

# Check codex availability
if ! command -v "$codex_cmd" >/dev/null 2>&1; then
  # Write NEED_USER_INPUT verdict placeholder
  cat > "${out_attempt_dir}/judge/verdict.json" <<'ENDJSON'
{
  "schema_version": "v1",
  "decision": "NEED_USER_INPUT",
  "reasons": ["codex CLI not found in PATH"],
  "next_instructions": "",
  "questions_for_user": ["codex CLI missing, please install/login"]
}
ENDJSON
  # Signal to coordinator: rc=127 means CLI missing
  echo "127" > "${out_attempt_dir}/judge/rc.txt"
  exit 127
fi

# Prepare stdin: judge prompt + evidence (use temp file so CLI sees non-TTY input without "stdin is not a terminal" errors)
tmp_stdin="${out_attempt_dir}/judge/stdin.txt"
if [ -f "$judge_prompt_path" ]; then
  cat "$judge_prompt_path" > "$tmp_stdin"
else
  printf '' > "$tmp_stdin"
fi
echo "---" >> "$tmp_stdin"
cat "$evidence_json_path" >> "$tmp_stdin"

# Call codex exec (non-interactive) with stdin from file
tmp_verdict="${out_attempt_dir}/judge/verdict.tmp.json"
"$codex_cmd" exec < "$tmp_stdin" > "$tmp_verdict" 2>"${out_attempt_dir}/judge/codex_stderr.log"
codex_rc=$?
rm -f "$tmp_stdin"

if [ $codex_rc -ne 0 ]; then
  echo "$codex_rc" > "${out_attempt_dir}/judge/rc.txt"
  exit $codex_rc
fi

# Try to extract and validate JSON from output (codex may include extra text or return invalid structure)
python3 -c "
import json, sys, re
with open('${tmp_verdict}') as f:
    raw = f.read()
d = None
# Try direct parse first
try:
    d = json.loads(raw)
except:
    pass
# Try to find JSON object in output
if d is None:
    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if m:
        try:
            d = json.loads(m.group())
        except:
            pass
if d is None:
    sys.stderr.write('Could not extract JSON from codex output\n')
    sys.exit(1)
# Validate basic structure (v1 minimum: decision, reasons, next_instructions, questions_for_user)
required_v1 = ['decision', 'reasons', 'next_instructions', 'questions_for_user']
missing = [f for f in required_v1 if f not in d]
if missing:
    sys.stderr.write(f'Extracted JSON missing required fields: {missing}\\n')
    sys.exit(1)
# Ensure types are correct
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
# Ensure schema_version if present
if 'schema_version' not in d:
    d['schema_version'] = 'v1'
print(json.dumps(d, indent=2))
sys.exit(0)
" > "${out_attempt_dir}/judge/verdict.json" 2>"${out_attempt_dir}/judge/extract_err.log"
extract_rc=$?

if [ $extract_rc -ne 0 ]; then
  # Write minimal valid verdict so coordinator can pause with NEED_USER_INPUT instead of VERDICT_INVALID
  cat > "${out_attempt_dir}/judge/verdict.json" <<'ENDJSON'
{
  "schema_version": "v1",
  "decision": "NEED_USER_INPUT",
  "reasons": ["Judge CLI output was not valid JSON or missing required fields. Check judge/verdict.tmp.json, extract_err.log, or codex_stderr.log."],
  "next_instructions": "",
  "questions_for_user": ["Fix judge prompt or CLI so it returns valid verdict JSON with: decision (string), reasons (non-empty array), next_instructions (string), questions_for_user (array)."]
}
ENDJSON
  echo "0" > "${out_attempt_dir}/judge/rc.txt"
  exit 0
fi

# Clean up tmp
rm -f "$tmp_verdict"
echo "0" > "${out_attempt_dir}/judge/rc.txt"
exit 0
