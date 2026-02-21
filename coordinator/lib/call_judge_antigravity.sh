#!/usr/bin/env bash
# call_judge_antigravity.sh — Antigravity (CLIProxyAPI 8317) judge adapter for rdloop
# Interface: $1=task_json_path $2=evidence_json_path $3=out_attempt_dir $4=judge_prompt_path
# Outputs: out_attempt_dir/judge/verdict.json

set -uo pipefail

task_json_path="$1"
evidence_json_path="$2"
out_attempt_dir="$3"
judge_prompt_path="$4"

mkdir -p "${out_attempt_dir}/judge"

BASE_URL="${RDLOOP_CLIAPI_BASE_URL:-http://127.0.0.1:8317/v1}"
API_KEY="${OPENCLAW_API_KEY:-openclawaousers}"
model="${JUDGE_MODEL:-}"
if [ -z "$model" ]; then
  model=$(python3 -c "
import json,sys
try:
    with open('${task_json_path}') as f: d=json.load(f)
    print(d.get('judge_model','gemini-2.5-flash'))
except: print('gemini-2.5-flash')
" 2>/dev/null || echo "gemini-2.5-flash")
fi

system_content=""
[ -f "$judge_prompt_path" ] && system_content=$(cat "$judge_prompt_path")
user_content="---"
[ -f "$evidence_json_path" ] && user_content="$user_content"$'\n'"$(cat "$evidence_json_path")"

payload=$(python3 -c "
import json,sys
# args: system_content, user_content, model (from stdin or env)
s=sys.argv[1]
u=sys.argv[2]
m=sys.argv[3]
print(json.dumps({'model':m,'messages':[{'role':'system','content':s},{'role':'user','content':u}]}))
" "$system_content" "$user_content" "$model" 2>/dev/null)
resp=$(curl -s -S -X POST "${BASE_URL}/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d "$payload" 2>&1)
curl_rc=$?

if [ "$curl_rc" -ne 0 ]; then
  cat > "${out_attempt_dir}/judge/verdict.json" <<'ENDJSON'
{"schema_version":"v1","decision":"NEED_USER_INPUT","reasons":["Judge API request failed"],"next_instructions":"","questions_for_user":["Check CLIProxyAPI 8317 and OPENCLAW_API_KEY"]}
ENDJSON
  echo "195" > "${out_attempt_dir}/judge/rc.txt"
  exit 195
fi

echo "$resp" | python3 -c "
import json,sys,re
raw=sys.stdin.read()
try: d=json.loads(raw)
except: d={}
content=d.get('choices',[{}])[0].get('message',{}).get('content','') or d.get('error',{}).get('message','')
m=re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', content, re.DOTALL) if content else None
obj=json.loads(m.group()) if m else None
if obj and 'decision' in obj and 'reasons' in obj:
    print(json.dumps(obj, indent=2))
    sys.exit(0)
# fallback
print(json.dumps({'schema_version':'v1','decision':'NEED_USER_INPUT','reasons':['Could not extract verdict JSON'],'next_instructions':'','questions_for_user':['Judge response invalid']}, indent=2))
sys.exit(0)
" > "${out_attempt_dir}/judge/verdict.json" 2>/dev/null || true
echo "0" > "${out_attempt_dir}/judge/rc.txt"
exit 0