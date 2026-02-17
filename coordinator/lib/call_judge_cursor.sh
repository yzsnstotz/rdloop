#!/usr/bin/env bash
# call_judge_cursor.sh — Cursor Agent judge adapter for rdloop
# Interface: $1=task_json_path $2=evidence_json_path $3=out_attempt_dir $4=judge_prompt_path
# Outputs: out_attempt_dir/judge/verdict.json
# Uses task.cursor_cmd (same as coder, default coder) to invoke Cursor CLI. Passes --trust for non-interactive.

set -uo pipefail

task_json_path="$1"
evidence_json_path="$2"
out_attempt_dir="$3"
judge_prompt_path="$4"

mkdir -p "${out_attempt_dir}/judge"

# Read cursor_cmd from task spec (same as coder)
cursor_cmd=$(python3 -c "
import json, sys
try:
    with open('${task_json_path}') as f:
        d = json.load(f)
    print(d.get('cursor_cmd', 'cursor-agent'))
except:
    print('cursor-agent')
" 2>/dev/null || echo "cursor-agent")

# Check availability (support absolute path)
if ! command -v "$cursor_cmd" >/dev/null 2>&1 && [ ! -x "$cursor_cmd" ]; then
  cat > "${out_attempt_dir}/judge/verdict.json" <<'ENDJSON'
{
  "schema_version": "v1",
  "decision": "NEED_USER_INPUT",
  "reasons": ["cursor CLI not found for judge"],
  "next_instructions": "",
  "questions_for_user": ["cursor-agent missing for judge, check cursor_cmd in task"]
}
ENDJSON
  echo "127" > "${out_attempt_dir}/judge/rc.txt"
  exit 127
fi

# Build instruction: wrap prompt + evidence with strict JSON output requirement
judge_stdin=""
if [ -f "$judge_prompt_path" ]; then
  judge_stdin=$(cat "$judge_prompt_path")
fi
judge_stdin="Output ONLY one valid JSON object (JudgeVerdict): schema_version, decision (PASS|FAIL|NEED_USER_INPUT), reasons, next_instructions, questions_for_user. No markdown, no other text.

---
${judge_stdin}
---
EVIDENCE (JSON):
$(cat "$evidence_json_path")"

# Run in attempt judge dir; use PTY when script is available (avoids Security 195 in real terminals)
tmp_verdict="${out_attempt_dir}/judge/verdict.tmp.json"
cursor_stderr="${out_attempt_dir}/judge/cursor_stderr.log"
use_pty=0
command -v script >/dev/null 2>&1 && use_pty=1

if [ "$use_pty" = "1" ]; then
  ( cd "${out_attempt_dir}/judge"; export judge_stdin cursor_cmd; script -q /dev/null /bin/bash -c 'echo "$judge_stdin" | "$cursor_cmd" --trust' > "$tmp_verdict" 2>>"$cursor_stderr" )
  judge_rc=$?
else
  ( cd "${out_attempt_dir}/judge"; echo "$judge_stdin" | "$cursor_cmd" --trust > "$tmp_verdict" 2>>"$cursor_stderr" )
  judge_rc=$?
fi

if [ $judge_rc -ne 0 ]; then
  echo "$judge_rc" > "${out_attempt_dir}/judge/rc.txt"
  exit $judge_rc
fi

# Extract JSON from output (cursor may wrap in markdown or extra text)
python3 -c "
import json, sys, re
with open('${tmp_verdict}') as f:
    raw = f.read()
try:
    d = json.loads(raw)
    print(json.dumps(d, indent=2))
    sys.exit(0)
except:
    pass
m = re.search(r'\{.*\}', raw, re.DOTALL)
if m:
    try:
        d = json.loads(m.group())
        print(json.dumps(d, indent=2))
        sys.exit(0)
    except:
        pass
sys.stderr.write('Could not extract valid JSON from cursor judge output\n')
sys.exit(1)
" > "${out_attempt_dir}/judge/verdict.json" 2>"${out_attempt_dir}/judge/extract_err.log"
extract_rc=$?

if [ $extract_rc -ne 0 ]; then
  echo "$extract_rc" > "${out_attempt_dir}/judge/rc.txt"
  exit 1
fi

rm -f "$tmp_verdict"
echo "0" > "${out_attempt_dir}/judge/rc.txt"
exit 0
