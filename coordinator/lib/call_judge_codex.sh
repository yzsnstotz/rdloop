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

# Prepare stdin: judge prompt + evidence
judge_stdin=""
if [ -f "$judge_prompt_path" ]; then
  judge_stdin=$(cat "$judge_prompt_path")
fi
judge_stdin="${judge_stdin}
---
$(cat "$evidence_json_path")"

# Call codex
tmp_verdict="${out_attempt_dir}/judge/verdict.tmp.json"
echo "$judge_stdin" | "$codex_cmd" > "$tmp_verdict" 2>"${out_attempt_dir}/judge/codex_stderr.log"
codex_rc=$?

if [ $codex_rc -ne 0 ]; then
  echo "$codex_rc" > "${out_attempt_dir}/judge/rc.txt"
  exit $codex_rc
fi

# Try to extract JSON from output (codex may include extra text)
python3 -c "
import json, sys, re
with open('${tmp_verdict}') as f:
    raw = f.read()
# Try direct parse first
try:
    d = json.loads(raw)
    print(json.dumps(d, indent=2))
    sys.exit(0)
except:
    pass
# Try to find JSON object in output
m = re.search(r'\{.*\}', raw, re.DOTALL)
if m:
    try:
        d = json.loads(m.group())
        print(json.dumps(d, indent=2))
        sys.exit(0)
    except:
        pass
sys.stderr.write('Could not extract valid JSON from codex output\n')
sys.exit(1)
" > "${out_attempt_dir}/judge/verdict.json" 2>"${out_attempt_dir}/judge/extract_err.log"
extract_rc=$?

if [ $extract_rc -ne 0 ]; then
  # Keep tmp for debugging
  echo "$extract_rc" > "${out_attempt_dir}/judge/rc.txt"
  exit 1
fi

# Clean up tmp
rm -f "$tmp_verdict"
echo "0" > "${out_attempt_dir}/judge/rc.txt"
exit 0
