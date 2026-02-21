#!/usr/bin/env bash
# call_coder_cursor.sh — Cursor coder adapter via cliapi (cursorcliapi 8000)
# Interface: $1=task_json_path $2=attempt_dir $3=worktree_dir $4=instruction_path
# Outputs: attempt_dir/coder/run.log, attempt_dir/coder/rc.txt
# Uses OPENCLAW_API_KEY (openclawaousers), CODER_MODEL (default auto). No queue CLI.

set -uo pipefail

task_json_path="$1"
attempt_dir="$2"
worktree_dir="$3"
instruction_path="$4"

mkdir -p "${attempt_dir}/coder"

# cursorcliapi at 8000 (see .cursor/skills/cliapi)
BASE_URL="${RDLOOP_CURSOR_CLIAPI_BASE_URL:-http://127.0.0.1:8000/v1}"
API_KEY="${OPENCLAW_API_KEY:-openclawaousers}"
model="${CODER_MODEL:-}"
if [ -z "$model" ]; then
  model=$(python3 -c "
import json,sys
try:
    with open('${task_json_path}') as f: d=json.load(f)
    print(d.get('coder_model','auto'))
except: print('auto')
" 2>/dev/null || echo "auto")
fi

instruction=""
[ -f "$instruction_path" ] && instruction=$(cat "$instruction_path")

full_prompt="You are working in directory: ${worktree_dir}
Please make all file changes inside that directory.

${instruction}"

run_log="${attempt_dir}/coder/run.log"
{
  echo "[CODER][cursor] $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting via cliapi (model=$model)"
  echo "[CODER][cursor] worktree: ${worktree_dir}"
  payload=$(python3 -c "
import json,sys
inst=sys.stdin.read()
print(json.dumps({'model':'${model}','messages':[{'role':'user','content':inst}]}))
" <<< "$full_prompt" 2>/dev/null)
  # Capture HTTP status and body (body to file so we can capture http_code from stdout)
  resp_file=$(mktemp)
  http_code=$(curl -s -S -w "%{http_code}" -o "$resp_file" -X POST "${BASE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -d "$payload")
  curl_rc=$?
  resp=$(cat "$resp_file" 2>/dev/null); rm -f "$resp_file"
  if [ "$curl_rc" -ne 0 ]; then
    echo "[CODER][cursor] curl failed (rc=$curl_rc)"
    echo "$http_code"
    echo "$resp"
    echo "[CODER][cursor] $(date -u +%Y-%m-%dT%H:%M:%SZ) Finished (failed)"
    echo "195" > "${attempt_dir}/coder/rc.txt"
    exit 195
  fi
  # On non-2xx or missing choices, write enough context so run.log is actionable and meets size threshold
  echo "$resp" | python3 -c "
import json,sys
raw=sys.stdin.read()
try:
    d=json.loads(raw)
    c=d.get('choices',[{}])[0].get('message',{}).get('content','')
    if c:
        print(c)
    else:
        err=d.get('error',{})
        msg=err.get('message', str(d)[:500]) if isinstance(err, dict) else str(d)[:500]
        print('[CODER][cursor] API returned no content. HTTP_CODE=' + '''${http_code}''' + '. Error: ' + str(msg)[:800])
        print('[CODER][cursor] Raw response (first 1200 chars):')
        print(raw[:1200])
except Exception as e:
    print('Parse error:', str(e))
    print('[CODER][cursor] HTTP_CODE=' + '''${http_code}''')
    print('Raw response (first 1200 chars):')
    print(raw[:1200])
" 2>/dev/null || { echo "[CODER][cursor] HTTP_CODE=${http_code}"; echo "$resp"; }
  echo "[CODER][cursor] $(date -u +%Y-%m-%dT%H:%M:%SZ) Finished"
} > "$run_log" 2>&1
if grep -q "Parse error:\|curl failed\|API returned no content" "$run_log" 2>/dev/null; then
  echo "195" > "${attempt_dir}/coder/rc.txt"
  exit 195
fi
echo "0" > "${attempt_dir}/coder/rc.txt"
exit 0
