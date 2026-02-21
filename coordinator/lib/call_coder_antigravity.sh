#!/usr/bin/env bash
# call_coder_antigravity.sh — Antigravity (CLIProxyAPI 8317) coder adapter for rdloop
# Interface: $1=task_json_path $2=attempt_dir $3=worktree_dir $4=instruction_path
# Outputs: attempt_dir/coder/run.log, attempt_dir/coder/rc.txt
# Uses OPENCLAW_API_KEY or openclawaousers, CODER_MODEL from env/task.

set -uo pipefail

task_json_path="$1"
attempt_dir="$2"
worktree_dir="$3"
instruction_path="$4"

mkdir -p "${attempt_dir}/coder"

BASE_URL="${RDLOOP_CLIAPI_BASE_URL:-http://127.0.0.1:8317/v1}"
API_KEY="${OPENCLAW_API_KEY:-openclawaousers}"
model="${CODER_MODEL:-}"
if [ -z "$model" ]; then
  model=$(python3 -c "
import json,sys
try:
    with open('${task_json_path}') as f: d=json.load(f)
    print(d.get('coder_model','gemini-2.5-flash'))
except: print('gemini-2.5-flash')
" 2>/dev/null || echo "gemini-2.5-flash")
fi

instruction=""
[ -f "$instruction_path" ] && instruction=$(cat "$instruction_path")

run_log="${attempt_dir}/coder/run.log"
{
  echo "[CODER][antigravity] $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting (model=$model)"
  echo "[CODER][antigravity] worktree: ${worktree_dir}"
  payload=$(python3 -c "
import json,sys
inst=sys.stdin.read()
print(json.dumps({'model':'${model}','messages':[{'role':'user','content':inst}]}))
" <<< "$instruction" 2>/dev/null)
  resp=$(curl -s -S -X POST "${BASE_URL}/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -d "$payload" 2>&1)
  curl_rc=$?
  if [ "$curl_rc" -ne 0 ]; then
    echo "[CODER][antigravity] curl failed (rc=$curl_rc)"
    echo "$resp"
    echo "[CODER][antigravity] $(date -u +%Y-%m-%dT%H:%M:%SZ) Finished (failed)"
    echo "195" > "${attempt_dir}/coder/rc.txt"
    exit 195
  fi
  echo "$resp" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    c=d.get('choices',[{}])[0].get('message',{}).get('content','')
    if c:
        print(c)
    else:
        print('[CODER][antigravity] API_ERROR')
        print(d.get('error',{}).get('message',str(d))[:500])
except Exception as e:
    print('Parse error:', str(e))
" 2>/dev/null || echo "$resp"
  echo "[CODER][antigravity] $(date -u +%Y-%m-%dT%H:%M:%SZ) Finished"
} > "$run_log" 2>&1
# 0 on success; 195 = auth/API error or API returned error body
if grep -q "Parse error:\|curl failed\|API_ERROR" "$run_log" 2>/dev/null; then
  echo "195" > "${attempt_dir}/coder/rc.txt"
  exit 195
fi
echo "0" > "${attempt_dir}/coder/rc.txt"
exit 0