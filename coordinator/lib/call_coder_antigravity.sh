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
  resp_path=$(mktemp)
  printf '%s' "$resp" > "$resp_path"
  python3 - "$resp_path" <<'PYEOF'
import json,sys
raw=''
try:
    raw=open(sys.argv[1], encoding='utf-8').read()
except Exception:
    pass
try:
    d=json.loads(raw)
    c=d.get('choices',[{}])[0].get('message',{}).get('content','')
    if c:
        print(c)
    else:
        print('[CODER][antigravity] API_ERROR')
        print(d.get('error',{}).get('message',str(d))[:500])
except Exception as e:
    print('Parse error:', str(e))
PYEOF
  py_rc=$?
  rm -f "$resp_path"
  [ "$py_rc" = "0" ] || echo "$resp"
  echo "[CODER][antigravity] $(date -u +%Y-%m-%dT%H:%M:%SZ) Finished"
} > "$run_log" 2>&1
if [ -n "${CODER_STDOUT_PATH:-}" ] && [ "${CODER_STDOUT_PATH}" != "$run_log" ]; then
  cp "$run_log" "${CODER_STDOUT_PATH}" 2>/dev/null || true
fi
[ -n "${CODER_STDERR_PATH:-}" ] && [ ! -f "${CODER_STDERR_PATH}" ] && : > "${CODER_STDERR_PATH}"
# 0 on success; 195 = auth/API error or API returned error body
if grep -q "Parse error:\|curl failed\|API_ERROR" "$run_log" 2>/dev/null; then
  echo "195" > "${attempt_dir}/coder/rc.txt"
  exit 195
fi
echo "0" > "${attempt_dir}/coder/rc.txt"
exit 0
