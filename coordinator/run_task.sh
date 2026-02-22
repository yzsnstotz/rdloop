#!/usr/bin/env bash
# coordinator/run_task.sh — rdloop Coordinator core
# Usage:
#   run_task.sh <task_spec.json>           — Create new task and run
#   run_task.sh --continue <task_id>       — Continue existing task
#   run_task.sh --reset <task_id>          — Reset task
#   run_task.sh --rerun-attempt <task_id> <n> — Rerun from attempt n
#   run_task.sh --self-improve <idea.md>   — Meta-task self-improve mode

set -euo pipefail

export GIT_DISCOVERY_ACROSS_FILESYSTEM=1

##############################################################################
# 0. Constants & globals
##############################################################################
RDLOOP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${RDLOOP_ROOT}/out"
WORKTREES_DIR="${RDLOOP_ROOT}/worktrees"
LIB_DIR="${RDLOOP_ROOT}/coordinator/lib"
PROMPTS_DIR="${RDLOOP_ROOT}/prompts"

LOCK_STALE_SECONDS=1800
JUDGE_MAX_RETRIES=2
TEST_LOG_TAIL_LINES=200

TASK_ID=""
TASK_DIR=""
TASK_JSON=""
LOCK_DIR=""
LOCK_ACQUIRED=0
CURRENT_ATTEMPT=0
NORMAL_EXIT=0

# P0: state_version tracking
STATE_VERSION=1
EFFECTIVE_MAX_ATTEMPTS=3
PREV_STATE=""
PREV_PAUSE_REASON=""
PREV_LAST_DECISION=""
PREV_ATTEMPT=0
PREV_EFFECTIVE_MAX=""

# P0: consecutive timeout tracking
CONSECUTIVE_TIMEOUT_COUNT=0
CONSECUTIVE_TIMEOUT_KEY=""

# E5-2/K1-1a: last_user_input_ts_consumed — set after consume_user_input in run_attempt; passed to write_status
LAST_USER_INPUT_TS_CONSUMED=""

get_pause_category() {
  local code="$1"
  case "$code" in
    PAUSED_CODEX_MISSING|PAUSED_CRASH|PAUSED_NOT_GIT_REPO|PAUSED_TASK_ID_CONFLICT|PAUSED_CODER_FAILED|PAUSED_CODER_NO_OUTPUT)
      echo "PAUSED_INFRA" ;;
    PAUSED_CODER_AUTH_195|PAUSED_JUDGE_AUTH_195)
      echo "PAUSED_INFRA" ;;
    PAUSED_JUDGE_INVALID|PAUSED_JUDGE_TIMEOUT|PAUSED_JUDGE_VERDICT_INVALID|PAUSED_JUDGE_VERDICT_INCONSISTENT|PAUSED_JUDGE_MODE_INVALID)
      echo "PAUSED_JUDGE" ;;
    PAUSED_CODER_TIMEOUT|PAUSED_TEST_TIMEOUT)
      echo "PAUSED_TIMEOUT" ;;
    PAUSED_ALLOWED_PATHS|PAUSED_FORBIDDEN_GLOBS)
      echo "PAUSED_POLICY" ;;
    PAUSED_USER|PAUSED_WAITING_USER_INPUT)
      echo "PAUSED_MANUAL" ;;
    PAUSED_SCORE_GATED|PAUSED_SCORE_BELOW_THRESHOLD)
      echo "PAUSED_SCORE" ;;
    *) echo "" ;;
  esac
}

##############################################################################
# 1. Utility functions
##############################################################################
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log_info() { echo "[COORDINATOR][INFO] $(now_iso) $*"; }
log_error() { echo "[COORDINATOR][ERROR] $(now_iso) $*" >&2; }

json_read() {
  local file="$1" field="$2" default="${3:-}"
  python3 -c "
import json,sys
try:
  with open(sys.argv[1]) as f: d=json.load(f)
  keys=sys.argv[2].split('.')
  v=d
  for k in keys: v=v[k]
  if isinstance(v,list): print(json.dumps(v))
  elif isinstance(v,bool): print('true' if v else 'false')
  elif v is None: print(sys.argv[3] if len(sys.argv)>3 else '')
  else: print(v)
except: print(sys.argv[3] if len(sys.argv)>3 else '')
" "$file" "$field" "$default" 2>/dev/null
}

epoch_from_iso() {
  python3 -c "
import sys,datetime,calendar
try:
  t=sys.argv[1][:19]
  dt=datetime.datetime.strptime(t,'%Y-%m-%dT%H:%M:%S')
  print(int(calendar.timegm(dt.timetuple())))
except: print(0)
" "$1" 2>/dev/null || echo "0"
}

##############################################################################
# 2. JSON writers (atomic via atomic_write.py)
##############################################################################
ATOMIC_WRITE="${LIB_DIR}/atomic_write.py"

maybe_bump_state_version() {
  local state="$1" prcode="$2" last_dec="$3" cur_att="$4" eff_max="$5"
  if [ "$state" != "$PREV_STATE" ] || [ "$prcode" != "$PREV_PAUSE_REASON" ] || \
     [ "$last_dec" != "$PREV_LAST_DECISION" ] || [ "$cur_att" != "$PREV_ATTEMPT" ] || \
     [ "$eff_max" != "$PREV_EFFECTIVE_MAX" ]; then
    STATE_VERSION=$(( STATE_VERSION + 1 ))
  fi
  PREV_STATE="$state"; PREV_PAUSE_REASON="$prcode"
  PREV_LAST_DECISION="$last_dec"; PREV_ATTEMPT="$cur_att"
  PREV_EFFECTIVE_MAX="$eff_max"
}

# K1-1a: last_user_input_ts_consumed (optional) — pass null or ISO8601 string
write_status() {
  local state="$1" cur_att="$2" max_att="$3" pflag="$4" last_dec="$5"
  local msg="$6" q_json="$7" pcat="$8" prcode="$9"
  shift 9
  local last_trans_json="${1:-null}"
  local last_ui_ts="${2:-null}"
  maybe_bump_state_version "$state" "$prcode" "$last_dec" "$cur_att" "$EFFECTIVE_MAX_ATTEMPTS"
  local rubric_ver="null"
  [ -f "${TASK_JSON:-}" ] && rubric_ver=$(json_read "$TASK_JSON" "rubric_version" "null")
  [ "$rubric_ver" = "null" ] || rubric_ver="\"${rubric_ver}\""
  python3 -c '
import json,sys
lt_raw=sys.argv[13]
lt=json.loads(lt_raw) if lt_raw!="null" else None
lui=None
if len(sys.argv)>16:
  lui_raw=sys.argv[16].strip()
  if lui_raw and lui_raw!="null": lui=lui_raw
d={"task_id":sys.argv[1],"state":sys.argv[2],"current_attempt":int(sys.argv[3]),
   "max_attempts":int(sys.argv[4]),"pause_flag":sys.argv[5]=="true",
   "last_decision":sys.argv[6],"message":sys.argv[7],
   "questions_for_user":json.loads(sys.argv[8]),
   "pause_category":sys.argv[9],"pause_reason_code":sys.argv[10],
   "updated_at":sys.argv[11],
   "state_version":int(sys.argv[12]),
   "effective_max_attempts":int(sys.argv[14]),
   "paths":{"status_json":"status.json"},
   "rubric_version_used":json.loads(sys.argv[15]),
   "last_user_input_ts_consumed":lui}
if lt is not None: d["last_transition"]=lt
print(json.dumps(d))
' "$TASK_ID" "$state" "$cur_att" "$max_att" "$pflag" \
  "$last_dec" "$msg" "$q_json" "$pcat" "$prcode" \
  "$(now_iso)" "$STATE_VERSION" "$last_trans_json" "$EFFECTIVE_MAX_ATTEMPTS" \
  "$rubric_ver" "$last_ui_ts" \
  | python3 "$ATOMIC_WRITE" "${TASK_DIR}/status.json" -
  # Write _index entry (A1-6)
  write_index_entry "$state"
}

# K1-1b: state (enum) + decision (PASS|FAIL|NEED_USER_INPUT), verdict_summary optional
write_final_summary() {
  local state="$1" last_dec="$2" cur_att="$3" max_att="$4"
  local msg="$5" q_json="$6" pcat="$7" prcode="$8" head_c="$9"
  shift 9
  local score="${1:-null}" verdict_summary="${2:-}"
  python3 -c '
import json,sys
score_raw=sys.argv[11]
score=int(score_raw) if score_raw!="null" and score_raw!="" else None
# argv[2]=state (READY_FOR_REVIEW|FAILED|PAUSED), argv[3]=last_decision (PASS|FAIL|NEED_USER_INPUT)
d={"task_id":sys.argv[1],"state":sys.argv[2],"decision":sys.argv[3],"last_decision":sys.argv[3],
   "current_attempt":int(sys.argv[4]),"max_attempts":int(sys.argv[5]),
   "message":sys.argv[6],"questions_for_user":json.loads(sys.argv[7]),
   "pause_category":sys.argv[8],"pause_reason_code":sys.argv[9],
   "final_head_commit":sys.argv[10],"updated_at":sys.argv[12],
   "state_version":int(sys.argv[13]),
   "final_score_0_100":score,
   "verdict_summary":sys.argv[14] if len(sys.argv)>14 and sys.argv[14] else None,
   "paths":{"status_json":"status.json","final_summary_json":"final_summary.json"}}
print(json.dumps(d))
' "$TASK_ID" "$state" "$last_dec" "$cur_att" "$max_att" \
  "$msg" "$q_json" "$pcat" "$prcode" "$head_c" \
  "$score" "$(now_iso)" "$STATE_VERSION" "$verdict_summary" \
  | python3 "$ATOMIC_WRITE" "${TASK_DIR}/final_summary.json" -
}

write_event() {
  local att="$1" etype="$2" summary="$3"
  local att_dir="${4:-}" wt_dir="${5:-}"
  python3 -c '
import json,sys
e={"ts":sys.argv[1],"task_id":sys.argv[2],"attempt":int(sys.argv[3]) if sys.argv[3] else 0,
   "type":sys.argv[4],"summary":sys.argv[5],
   "paths":{"out_dir":sys.argv[6],"attempt_dir":sys.argv[7],
            "worktree_dir":sys.argv[8],"status_path":sys.argv[9]}}
print(json.dumps(e))
' "$(now_iso)" "$TASK_ID" "$att" "$etype" "$summary" \
  "${TASK_DIR}" "$att_dir" "$wt_dir" "${TASK_DIR}/status.json" \
  | python3 "$ATOMIC_WRITE" --append "${TASK_DIR}/events.jsonl" -
}

# K3-1/K3-5: ATTEMPT_DECIDED with decision, next_state, pause_reason_code, effective_max_attempts, current_attempt
write_event_attempt_decided() {
  local att="$1" decision="$2" next_state="$3" prcode="${4:-}"
  python3 -c '
import json,sys
e={"ts":sys.argv[1],"task_id":sys.argv[2],"attempt":int(sys.argv[3]),
   "type":"ATTEMPT_DECIDED",
   "decision":sys.argv[4],"next_state":sys.argv[5],"pause_reason_code":sys.argv[6] if sys.argv[6] else None,
   "effective_max_attempts":int(sys.argv[7]),"current_attempt":int(sys.argv[3])}
print(json.dumps(e))
' "$(now_iso)" "$TASK_ID" "$att" "$decision" "$next_state" "$prcode" "$EFFECTIVE_MAX_ATTEMPTS" \
  | python3 "$ATOMIC_WRITE" --append "${TASK_DIR}/events.jsonl" -
}

write_commands_log() {
  local att="$1" cmd="$2" rc="$3" secs="$4" logf="$5"
  python3 -c '
import json,sys
e={"ts":sys.argv[1],"attempt":int(sys.argv[2]),"cmd":sys.argv[3],
   "rc":int(sys.argv[4]),"seconds":float(sys.argv[5])}
print(json.dumps(e))
' "$(now_iso)" "$att" "$cmd" "$rc" "$secs" \
  | python3 "$ATOMIC_WRITE" --append "$logf" -
}

write_metrics() {
  local att_dir="$1" att_num="$2" elapsed="$3" jretries="$4"
  local crc="$5" trc="$6" jrc="$7"
  local a_start="$8" c_start="${9:-}" c_fin="${10:-}"
  local t_start="${11:-}" t_fin="${12:-}" j_start="${13:-}" j_fin="${14:-}"
  local notes="${15:-[]}"
  python3 -c '
import json,sys
d={"schema_version":"v1","task_id":sys.argv[1],"attempt":int(sys.argv[2]),
   "elapsed_seconds":float(sys.argv[3]),"judge_retries":int(sys.argv[4]),
   "phase_ts":{"attempt_started_at":sys.argv[5],"coder_started_at":sys.argv[6],
     "coder_finished_at":sys.argv[7],"test_started_at":sys.argv[8],
     "test_finished_at":sys.argv[9],"judge_started_at":sys.argv[10],
     "judge_finished_at":sys.argv[11]},
   "coder_rc":int(sys.argv[12]),"test_rc":int(sys.argv[13]),
   "judge_rc":int(sys.argv[14]),"notes":json.loads(sys.argv[15])}
print(json.dumps(d))
' "$TASK_ID" "$att_num" "$elapsed" "$jretries" \
  "$a_start" "$c_start" "$c_fin" "$t_start" "$t_fin" "$j_start" "$j_fin" \
  "$crc" "$trc" "$jrc" "$notes" \
  | python3 "$ATOMIC_WRITE" "${att_dir}/metrics.json" -
}

write_evidence() {
  local att_dir="$1" att_num="$2" wt_path="$3" head_c="$4"
  local tcmd="$5" trc="$6" tlog_tail="$7" cmds_json="$8"
  local coder_output_path="${9:-}"
  local task_code="${10:-}"
  python3 -c '
import json,sys
d={"schema_version":"v1","task_id":sys.argv[1],"attempt":int(sys.argv[2]),
   "task_code":sys.argv[11],"worktree_path":sys.argv[3],"created_at":sys.argv[4],
   "git":{"diff_stat_path":"git/diff.stat","diff_patch_path":"git/diff.patch",
          "head_commit":sys.argv[5]},
   "commands":json.loads(sys.argv[6]),
   "test":{"cmd":sys.argv[7],"rc":int(sys.argv[8]),"log_tail":sys.argv[9]},
   "artifacts":[],"metrics_path":"metrics.json"}
if len(sys.argv) > 10 and sys.argv[10]:
  try:
    with open(sys.argv[10], encoding="utf-8") as f: d["coder_output"]=f.read()
  except Exception: pass
print(json.dumps(d, ensure_ascii=False))
' "$TASK_ID" "$att_num" "$wt_path" "$(now_iso)" "$head_c" \
  "$cmds_json" "$tcmd" "$trc" "$tlog_tail" \
  "$coder_output_path" "$task_code" \
  | python3 "$ATOMIC_WRITE" "${att_dir}/evidence.json" -
}

write_env_json() {
  local att_dir="$1" task_code="${2:-}" att_num="${3:-}"
  local os_info git_ver node_ver py_ver
  os_info=$(uname -srm 2>/dev/null || echo "unknown")
  git_ver=$(git --version 2>/dev/null || echo "unknown")
  node_ver=$(node -v 2>/dev/null || echo "N/A")
  py_ver=$(python3 -V 2>/dev/null || echo "N/A")
  local codex_avail="false" codex_path="" claude_avail="false" claude_path=""
  # Cursor uses cliapi (8000), no local binary; other CLIs for env diagnostics only
  command -v codex >/dev/null 2>&1 && { codex_avail="true"; codex_path=$(command -v codex); }
  command -v claude >/dev/null 2>&1 && { claude_avail="true"; claude_path=$(command -v claude); }
  python3 -c '
import json,sys
d={"os":sys.argv[1],"node_version":sys.argv[2],"python_version":sys.argv[3],
   "git_version":sys.argv[4],
   "codex_available":sys.argv[5]=="true","codex_path":sys.argv[6],
   "claude_available":sys.argv[7]=="true","claude_path":sys.argv[8],
   "task_code":sys.argv[9],"attempt":int(sys.argv[10]) if sys.argv[10] else 0}
print(json.dumps(d))
' "$os_info" "$node_ver" "$py_ver" "$git_ver" \
  "$codex_avail" "$codex_path" \
  "$claude_avail" "$claude_path" \
  "$task_code" "$att_num" \
  | python3 "$ATOMIC_WRITE" "${att_dir}/env.json" -
}

write_index_entry() {
  local state="$1"
  local idx_dir="${OUT_DIR}/_index/tasks"
  mkdir -p "$idx_dir"
  python3 -c '
import json,sys
d={"task_id":sys.argv[1],"state":sys.argv[2],"updated_at":sys.argv[3],
   "state_version":int(sys.argv[4]),
   "paths":{"status_json":sys.argv[1]+"/status.json"}}
print(json.dumps(d))
' "$TASK_ID" "$state" "$(now_iso)" "$STATE_VERSION" \
  | python3 "$ATOMIC_WRITE" "${idx_dir}/${TASK_ID}.json" -
}

##############################################################################
# 2b. Verdict traceability injection (B4-2/B4-6)
##############################################################################
# inject_verdict_traceability <verdict_json_path> <task_json_path>
# Post-processes verdict.json to add rubric_version_used, rubric_hash_used,
# scoring_mode_used, thresholds_used, deliverability_index_0_100,
# improvement_potential_0_100 — only fills missing fields, never overwrites.
RUBRIC_JSON="${RDLOOP_ROOT}/schemas/judge_rubric.json"

inject_verdict_traceability() {
  local vpath="$1" tjson="$2"
  [ ! -f "$vpath" ] && return 0
  python3 - "$vpath" "$tjson" "$RUBRIC_JSON" "$ATOMIC_WRITE" <<'PYEOF'
import json, sys, os, math

vpath, tjson, rpath, atomic = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

try:
    with open(vpath, encoding='utf-8') as f:
        v = json.load(f)
except Exception:
    sys.exit(0)

changed = False

# Load rubric for version/hash
rubric_version = None
rubric_hash = None
if os.path.isfile(rpath):
    try:
        with open(rpath, encoding='utf-8') as f:
            r = json.load(f)
        rubric_version = r.get('rubric_version')
        rubric_hash = r.get('rubric_hash')
    except Exception:
        pass

# Load task spec for scoring_mode and thresholds
scoring_mode = 'rubric_analytic'
thresholds_used = None
if os.path.isfile(tjson):
    try:
        with open(tjson, encoding='utf-8') as f:
            t = json.load(f)
        scoring_mode = t.get('scoring_mode', 'rubric_analytic') or 'rubric_analytic'
        rt = t.get('rubric_thresholds')
        if rt:
            thresholds_used = rt
    except Exception:
        pass

def set_if_missing(key, val):
    global changed
    if val is not None and key not in v:
        v[key] = val
        changed = True

set_if_missing('rubric_version_used', rubric_version)
set_if_missing('rubric_hash_used', rubric_hash)
set_if_missing('scoring_mode_used', scoring_mode)
set_if_missing('thresholds_used', thresholds_used)

# Compute deliverability_index_0_100 and improvement_potential_0_100 if absent
if 'deliverability_index_0_100' not in v and 'scores' in v and isinstance(v.get('scores'), dict):
    scores = v['scores']
    task_type = v.get('task_type', '')
    # DI: based on final_score_0_100 if available, else raw weighted hard-gate dims
    final100 = v.get('final_score_0_100')
    if final100 is not None:
        di = max(0, min(100, int(final100)))
    else:
        di = 50
    set_if_missing('deliverability_index_0_100', di)

    # IP: improvement potential based on top_issues count and score headroom
    top_issues = v.get('top_issues', [])
    n_issues = len(top_issues) if isinstance(top_issues, list) else 0
    score_vals = [s for s in scores.values() if isinstance(s, (int, float))]
    headroom = 0.0
    if score_vals:
        headroom = (5.0 - sum(score_vals) / len(score_vals)) / 5.0
    ip = max(0, min(100, int(headroom * 60 + min(n_issues, 5) * 8)))
    set_if_missing('improvement_potential_0_100', ip)

if changed:
    import subprocess
    payload = json.dumps(v)
    proc = subprocess.run(
        ['python3', atomic, vpath, '-'],
        input=payload.encode('utf-8'),
        capture_output=True
    )
    if proc.returncode != 0:
        sys.stderr.write('inject_verdict_traceability: atomic write failed\n')
        sys.exit(1)
PYEOF
}

##############################################################################
# 2c. Runtime overrides + decision_table helpers
##############################################################################
DECISION_TABLE_CLI="${LIB_DIR}/decision_table_cli.js"

load_runtime_overrides() {
  local ovr="${TASK_DIR}/runtime_overrides.json"
  if [ -f "$ovr" ]; then
    local ov_max; ov_max=$(json_read "$ovr" "overrides.max_attempts" "")
    [ -n "$ov_max" ] && EFFECTIVE_MAX_ATTEMPTS="$ov_max"
  fi
}

# call_decision_table role rc error_class verdict_decision verdict_gated thresholds_pass
# Outputs JSON to stdout. Caller must parse.
call_decision_table() {
  local role="$1" rc="$2" err_class="$3"
  local v_dec="${4:-}" v_gated="${5:-false}" thresh="${6:-true}"
  local ctx_json
  ctx_json=$(python3 -c '
import json,sys
d={"role":sys.argv[1],"rc":int(sys.argv[2]),"error_class":sys.argv[3],
   "verdict_decision":sys.argv[4],"verdict_gated":sys.argv[5]=="true",
   "thresholds_pass":sys.argv[6]=="true",
   "current_attempt":int(sys.argv[7]),"effective_max_attempts":int(sys.argv[8]),
   "consecutive_timeout_count":int(sys.argv[9]),"consecutive_timeout_key":sys.argv[10]}
print(json.dumps(d))
' "$role" "$rc" "$err_class" "$v_dec" "$v_gated" "$thresh" \
  "$CURRENT_ATTEMPT" "$EFFECTIVE_MAX_ATTEMPTS" \
  "$CONSECUTIVE_TIMEOUT_COUNT" "$CONSECUTIVE_TIMEOUT_KEY")
  node "$DECISION_TABLE_CLI" "$ctx_json"
}

# act_on_decision <decision_json> <head_commit> <att_num> <max_att>
# Returns: "exit" if caller should exit, "continue" if loop continues
act_on_decision() {
  local dj="$1" hc="$2" att_num="$3" max_att="$4"
  local ns pr ca ld msg qj
  ns=$(echo "$dj" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["next_state"])')
  pr=$(echo "$dj" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["pause_reason_code"])')
  ca=$(echo "$dj" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("true" if d["consume_attempt"] else "false")')
  ld=$(echo "$dj" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["last_decision"])')
  msg=$(echo "$dj" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["message"])')
  qj=$(echo "$dj" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(json.dumps(d["questions_for_user"]))')

  log_info "decision_table: state=${ns} reason=${pr} consume=${ca} decision=${ld}"

  case "$ns" in
    READY_FOR_REVIEW)
      # B4-0: non rubric_analytic must not pass K8 Gate (cannot go to READY_FOR_REVIEW)
      local scoring_mode; scoring_mode=$(json_read "$TASK_JSON" "scoring_mode" "rubric_analytic")
      if [ "$scoring_mode" != "rubric_analytic" ]; then
        log_info "B4-0: scoring_mode=${scoring_mode} is not rubric_analytic; cannot pass K8 Gate"
        write_event_attempt_decided "$att_num" "FAIL" "PAUSED" "PAUSED_JUDGE_MODE_INVALID"
        enter_paused "PAUSED_JUDGE_MODE_INVALID" "scoring_mode must be rubric_analytic to pass Gate (current: ${scoring_mode})" "[\"Set TaskSpec.scoring_mode to rubric_analytic for Gate.\"]"
        NORMAL_EXIT=1; exit 0
      fi
      write_event_attempt_decided "$att_num" "$ld" "READY_FOR_REVIEW" ""
      write_status "READY_FOR_REVIEW" "$att_num" "$max_att" "false" "$ld" "$msg" "$qj" "" "" "null" "${LAST_USER_INPUT_TS_CONSUMED:-}"
      write_final_summary "READY_FOR_REVIEW" "$ld" "$att_num" "$max_att" "$msg" "$qj" "" "" "$hc" "${final_score_for_summary:-}"
      write_event "$att_num" "STATE_CHANGED" "READY_FOR_REVIEW"
      NORMAL_EXIT=1; exit 0
      ;;
    FAILED)
      write_event_attempt_decided "$att_num" "$ld" "FAILED" ""
      write_status "FAILED" "$att_num" "$max_att" "false" "$ld" "$msg" "$qj" "" "" "null" "${LAST_USER_INPUT_TS_CONSUMED:-}"
      write_final_summary "FAILED" "$ld" "$att_num" "$max_att" "$msg" "$qj" "" "" "$hc" "${final_score_for_summary:-}"
      write_event "$att_num" "STATE_CHANGED" "FAILED"
      NORMAL_EXIT=1; exit 0
      ;;
    PAUSED)
      enter_paused "$pr" "$msg" "$qj" "$ld" "$hc" "$ca"
      NORMAL_EXIT=1; exit 0
      ;;
    RUNNING)
      write_event_attempt_decided "$att_num" "$ld" "RUNNING" ""
      write_status "RUNNING" "$att_num" "$max_att" "false" "$ld" "$msg" "$qj" "" "" "null" "${LAST_USER_INPUT_TS_CONSUMED:-}"
      log_info "Auto-advancing to attempt $(( att_num + 1 ))"
      return 0
      ;;
  esac
}

# update_consecutive_timeout role rc
# Call before decision_table to update consecutive tracking
update_consecutive_timeout() {
  local role="$1" rc="$2"
  if [ "$rc" = "124" ]; then
    local key="${role}_timeout"
    if [ "$CONSECUTIVE_TIMEOUT_KEY" = "$key" ]; then
      CONSECUTIVE_TIMEOUT_COUNT=$(( CONSECUTIVE_TIMEOUT_COUNT + 1 ))
    else
      CONSECUTIVE_TIMEOUT_COUNT=1
      CONSECUTIVE_TIMEOUT_KEY="$key"
    fi
  else
    # Non-timeout: reset
    CONSECUTIVE_TIMEOUT_COUNT=0
    CONSECUTIVE_TIMEOUT_KEY=""
  fi
}

##############################################################################
# 3. Locking (mkdir atomic, macOS compatible)
##############################################################################
acquire_lock() {
  LOCK_DIR="${TASK_DIR}/.lockdir"
  if [ -d "$LOCK_DIR" ]; then
    local lock_pid="" lock_started="" is_stale=0
    [ -f "${LOCK_DIR}/pid" ] && lock_pid=$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")
    [ -f "${LOCK_DIR}/started_at" ] && lock_started=$(cat "${LOCK_DIR}/started_at" 2>/dev/null || echo "")
    if [ -n "$lock_pid" ]; then
      kill -0 "$lock_pid" 2>/dev/null || is_stale=1
    else
      is_stale=1
    fi
    if [ "$is_stale" = "0" ] && [ -n "$lock_started" ]; then
      local now_e; now_e=$(date +%s)
      local lock_e; lock_e=$(epoch_from_iso "$lock_started")
      if [ "$lock_e" != "0" ]; then
        local diff_s=$(( now_e - lock_e ))
        [ "$diff_s" -gt "$LOCK_STALE_SECONDS" ] && is_stale=1
      fi
    fi
    if [ "$is_stale" = "1" ]; then
      log_info "Clearing stale lock (pid=${lock_pid:-unknown})"
      rm -rf "$LOCK_DIR"
      write_event "$CURRENT_ATTEMPT" "LOCK_STALE_CLEARED" "stale lock cleared pid=${lock_pid:-unknown}"
    fi
  fi
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" > "${LOCK_DIR}/pid"
    hostname > "${LOCK_DIR}/host" 2>/dev/null || true
    now_iso > "${LOCK_DIR}/started_at"
    LOCK_ACQUIRED=1
    return 0
  else
    return 1
  fi
}

release_lock() {
  if [ "$LOCK_ACQUIRED" = "1" ] && [ -d "${LOCK_DIR:-}" ]; then
    local lp=""; [ -f "${LOCK_DIR}/pid" ] && lp=$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")
    if [ "$lp" = "$$" ]; then rm -rf "$LOCK_DIR"; LOCK_ACQUIRED=0; fi
  fi
}

##############################################################################
# 4. Trap / cleanup — §5.13, §19 check 4
##############################################################################
handle_signal() {
  # Capture signal, prevent re-entry, let cleanup handle it
  NORMAL_EXIT=0
  CAUGHT_SIGNAL="$1"
  exit $(( 128 + $1 ))
}
trap 'handle_signal 15' TERM
trap 'handle_signal 2' INT

cleanup() {
  local exit_code=$?
  set +e
  # Block signals during cleanup to prevent re-entry
  trap '' TERM INT
  if [ "$NORMAL_EXIT" = "1" ]; then
    release_lock; return
  fi
  # Determine signal name from exit code
  local sig_name="unknown"
  case "$exit_code" in
    130) sig_name="SIGINT" ;;
    143) sig_name="SIGTERM" ;;
    137) sig_name="SIGKILL" ;;
    1)   sig_name="ERR" ;;
    0)   sig_name="EXIT" ;;
    *)   sig_name="rc=${exit_code}" ;;
  esac
  # Abnormal: write PAUSED_CRASH if still RUNNING
  if [ -n "${TASK_DIR:-}" ] && [ -d "${TASK_DIR:-}" ]; then
    local cs=""
    [ -f "${TASK_DIR}/status.json" ] && cs=$(json_read "${TASK_DIR}/status.json" "state" "")
    if [ "$cs" = "RUNNING" ] || [ -z "$cs" ]; then
      local ma="${EFFECTIVE_MAX_ATTEMPTS:-3}"
      [ ! -f "${TASK_DIR}/status.json" ] && {
        write_status "RUNNING" "$CURRENT_ATTEMPT" "$ma" "false" "" "" '[]' "" "" "null" ""
      }
      local crash_lt
      crash_lt=$(python3 -c '
import json,sys
d={"reason_code":"PAUSED_CRASH","previous_state":"RUNNING",
   "message":"coordinator crashed ("+sys.argv[2]+", rc="+sys.argv[1]+")",
   "signal_or_rc":int(sys.argv[1]),"signal_name":sys.argv[2]}
print(json.dumps(d))
' "$exit_code" "$sig_name" 2>/dev/null || echo '{"reason_code":"PAUSED_CRASH","previous_state":"RUNNING"}')
      write_status "PAUSED" "$CURRENT_ATTEMPT" "$ma" "false" \
        "NEED_USER_INPUT" "coordinator crashed or was killed (${sig_name}, rc=${exit_code})" \
        '["Please check logs and re-run with --continue"]' \
        "PAUSED_INFRA" "PAUSED_CRASH" "$crash_lt" "${LAST_USER_INPUT_TS_CONSUMED:-}"
      write_final_summary "PAUSED" "NEED_USER_INPUT" "$CURRENT_ATTEMPT" "$ma" \
        "coordinator crashed or was killed (${sig_name}, rc=${exit_code})" \
        '["Please check logs and re-run with --continue"]' \
        "PAUSED_INFRA" "PAUSED_CRASH" ""
      write_event "$CURRENT_ATTEMPT" "COORDINATOR_CRASHED" \
        "PAUSED_CRASH ${sig_name} rc=${exit_code}" 2>/dev/null || true
    fi
  fi
  release_lock
}
trap cleanup EXIT ERR

##############################################################################
# 5. Checkpoint: control.json PAUSE check — §5.11
##############################################################################
check_control_pause() {
  local cpname="$1"
  local cf="${TASK_DIR}/control.json"
  [ ! -f "$cf" ] && return 0
  local action; action=$(json_read "$cf" "action" "")
  if [ "$action" = "PAUSE" ]; then
    local ma; ma=$(json_read "$TASK_JSON" "max_attempts" "3")
    log_info "Checkpoint ${cpname}: PAUSE requested"
    local lt_user='{"reason_code":"PAUSED_USER","previous_state":"RUNNING","message":"user PAUSE at '"${cpname}"'"}'
    write_status "PAUSED" "$CURRENT_ATTEMPT" "$ma" "true" \
      "" "paused at checkpoint: ${cpname}" \
      '["User requested PAUSE. Use --continue to resume."]' \
      "PAUSED_MANUAL" "PAUSED_USER" "$lt_user" "${LAST_USER_INPUT_TS_CONSUMED:-}"
    write_final_summary "PAUSED" "NEED_USER_INPUT" "$CURRENT_ATTEMPT" "$ma" \
      "paused at checkpoint: ${cpname}" \
      '["User requested PAUSE. Use --continue to resume."]' \
      "PAUSED_MANUAL" "PAUSED_USER" ""
    write_event "$CURRENT_ATTEMPT" "STATE_CHANGED" "PAUSED_USER at ${cpname}"
    rm -f "$cf"
    NORMAL_EXIT=1; exit 0
  fi
  return 0
}

# Set by process_control when RESUME was applied (so cmd_continue skips terminal-state exit)
CONTROL_RESUME_APPLIED=0
process_control() {
  local cf="${TASK_DIR}/control.json"
  CONTROL_RESUME_APPLIED=0
  [ ! -f "$cf" ] && return 0
  local action nonce pf
  action=$(json_read "$cf" "action" "")
  nonce=$(json_read "$cf" "nonce" "")
  pf="${TASK_DIR}/.processed_nonces"
  if [ -n "$nonce" ] && [ -f "$pf" ]; then
    grep -qF "$nonce" "$pf" 2>/dev/null && { rm -f "$cf"; return 0; }
  fi
  case "$action" in
    PAUSE) return 0 ;;
    RESUME)
      local ma; ma=$(json_read "$TASK_JSON" "max_attempts" "3")
      write_status "RUNNING" "$CURRENT_ATTEMPT" "$ma" "false" "" "" '[]' "" "" "null" "${LAST_USER_INPUT_TS_CONSUMED:-}"
      rm -f "$cf"; [ -n "$nonce" ] && echo "$nonce" >> "$pf"
      write_event "$CURRENT_ATTEMPT" "STATE_CHANGED" "RESUMED via control"
      CONTROL_RESUME_APPLIED=1
      ;;
    EDIT_INSTRUCTION)
      local ea et; ea=$(json_read "$cf" "payload.attempt" "0")
      et=$(json_read "$cf" "payload.instruction_text" "")
      if [ -n "$ea" ] && [ "$ea" != "0" ]; then
        local pad; pad=$(printf "%03d" "$ea")
        mkdir -p "${TASK_DIR}/attempt_${pad}/coder"
        echo "$et" > "${TASK_DIR}/attempt_${pad}/coder/instruction.txt"
      fi
      rm -f "$cf"; [ -n "$nonce" ] && echo "$nonce" >> "$pf"
      ;;
    RUN_NEXT)
      local cs=""; [ -f "${TASK_DIR}/status.json" ] && cs=$(json_read "${TASK_DIR}/status.json" "state" "")
      if [ "$cs" = "PAUSED" ]; then
        local ma; ma=$(json_read "$TASK_JSON" "max_attempts" "3")
        write_status "RUNNING" "$CURRENT_ATTEMPT" "$ma" "false" "" "" '[]' "" ""
        write_event "$CURRENT_ATTEMPT" "STATE_CHANGED" "RUN_NEXT from PAUSED"
      fi
      rm -f "$cf"; [ -n "$nonce" ] && echo "$nonce" >> "$pf"
      ;;
  esac
}

##############################################################################
# 6. PAUSED helper — always writes status + final_summary + event
# K2-6: last_transition must include consume_attempt, reason_key, consecutive_count, triggered_at
##############################################################################
enter_paused() {
  local rcode="$1" msg="$2" qjson="$3"
  local ldec="${4:-NEED_USER_INPUT}" hc="${5:-}" consume="${6:-false}"
  local ma; ma=$(json_read "$TASK_JSON" "max_attempts" "3")
  local cat; cat=$(get_pause_category "$rcode")
  local lt_json
  lt_json=$(python3 -c '
import json,sys
# K2-6: consume_attempt, reason_key, consecutive_count, triggered_at
d={"consume_attempt":sys.argv[5]=="true","reason_key":sys.argv[1],"triggered_at":sys.argv[6]}
if sys.argv[3]!="0": d["consecutive_count"]=int(sys.argv[3])
print(json.dumps(d))
' "$rcode" "$msg" "$CONSECUTIVE_TIMEOUT_COUNT" "$CONSECUTIVE_TIMEOUT_KEY" "$consume" "$(now_iso)")
  # ATTEMPT_DECIDED for PAUSED_JUDGE_MODE_INVALID is written by caller before enter_paused
  if [ "$rcode" != "PAUSED_JUDGE_MODE_INVALID" ]; then
    write_event_attempt_decided "$CURRENT_ATTEMPT" "$ldec" "PAUSED" "$rcode"
  fi
  write_status "PAUSED" "$CURRENT_ATTEMPT" "$ma" "false" \
    "$ldec" "$msg" "$qjson" "$cat" "$rcode" "$lt_json" "${LAST_USER_INPUT_TS_CONSUMED:-}"
  write_final_summary "PAUSED" "$ldec" "$CURRENT_ATTEMPT" "$ma" \
    "$msg" "$qjson" "$cat" "$rcode" "$hc"
  write_event "$CURRENT_ATTEMPT" "STATE_CHANGED" "$rcode"
}

##############################################################################
# 7. Security guardrails — §9
##############################################################################
check_guardrails() {
  local wt="$1" bref="$2"
  local changed; changed=$(git -C "$wt" diff --name-only "${bref}...HEAD" 2>/dev/null || echo "")
  [ -z "$changed" ] && return 0
  # allowed_paths
  local ap; ap=$(json_read "$TASK_JSON" "allowed_paths" "[]")
  local has_ap; has_ap=$(python3 -c "import json,sys;print('y' if len(json.loads(sys.argv[1]))>0 else 'n')" "$ap" 2>/dev/null || echo "n")
  if [ "$has_ap" = "y" ]; then
    local viol; viol=$(python3 -c "
import json,sys
ap=json.loads(sys.argv[1]); fs=sys.argv[2].strip().split('\n') if sys.argv[2].strip() else []
for f in fs:
  ok=any(f.startswith(a) or f==a for a in ap)
  if not ok: print(f); sys.exit(0)
print('')
" "$ap" "$changed" 2>/dev/null || echo "")
    if [ -n "$viol" ]; then
      enter_paused "PAUSED_ALLOWED_PATHS" "File '${viol}' outside allowed_paths" \
        "[\"File ${viol} is outside allowed_paths. Please review.\"]"
      NORMAL_EXIT=1; exit 0
    fi
  fi
  # forbidden_globs
  local fg; fg=$(json_read "$TASK_JSON" "forbidden_globs" "[]")
  local has_fg; has_fg=$(python3 -c "import json,sys;print('y' if len(json.loads(sys.argv[1]))>0 else 'n')" "$fg" 2>/dev/null || echo "n")
  if [ "$has_fg" = "y" ]; then
    local viol; viol=$(python3 -c "
import json,fnmatch,sys
fg=json.loads(sys.argv[1]); fs=sys.argv[2].strip().split('\n') if sys.argv[2].strip() else []
for f in fs:
  for p in fg:
    if fnmatch.fnmatch(f,p): print(f); sys.exit(0)
print('')
" "$fg" "$changed" 2>/dev/null || echo "")
    if [ -n "$viol" ]; then
      enter_paused "PAUSED_FORBIDDEN_GLOBS" "File '${viol}' matches forbidden_globs" \
        "[\"File ${viol} matches forbidden_globs. Please review.\"]"
      NORMAL_EXIT=1; exit 0
    fi
  fi
  return 0
}

##############################################################################
# 8. Worktree management — §5.3
##############################################################################
setup_worktree() {
  local att_num="$1" repo="$2" bref="$3"
  local pad; pad=$(printf "%03d" "$att_num")
  local wt="${WORKTREES_DIR}/${TASK_ID}/attempt_${pad}"
  # Check repo is git
  if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    enter_paused "PAUSED_NOT_GIT_REPO" "repo_path '${repo}' is not a git repository" \
      "[\"${repo} is not a git repo. Please init git or fix repo_path.\"]"
    NORMAL_EXIT=1; exit 0
  fi
  mkdir -p "$(dirname "$wt")"
  [ -d "$wt" ] && rm -rf "$wt"

  # Try git worktree add first
  local wt_ok=0
  git -C "$repo" worktree add "$wt" "$bref" 2>/dev/null && wt_ok=1

  if [ "$wt_ok" = "0" ]; then
    # Fallback: copy repo (preserving .git as standalone)
    mkdir -p "$wt"
    # Copy non-git content first, then .git
    cp -R "$repo"/. "$wt"/ 2>/dev/null || true
    # If .git is a worktree link file (not a dir), fix it
    if [ -f "${wt}/.git" ]; then
      rm -f "${wt}/.git"
      git -C "$wt" init >/dev/null 2>&1 || true
      git -C "$wt" add -A >/dev/null 2>&1 || true
      git -C "$wt" commit -m "worktree init" --allow-empty >/dev/null 2>&1 || true
    fi
    # If .git dir exists (copied), it's already a valid standalone git repo
  fi
  echo "$wt"
}

##############################################################################
# 8b. Artifacts copy (K8-4) — worktree artifacts/ → out/<task_id>/artifacts/
##############################################################################
copy_artifacts() {
  local wt="$1" att_num="$2"
  local src="${wt}/artifacts"
  local dst="${TASK_DIR}/artifacts"
  [ ! -d "$src" ] && return 0
  local pad; pad=$(printf "%03d" "$att_num")
  mkdir -p "${dst}/attempt_${pad}"
  cp -R "${src}/." "${dst}/attempt_${pad}/" 2>/dev/null || true
  for f in requirements.md spec.json; do
    [ -f "${dst}/attempt_${pad}/${f}" ] && cp "${dst}/attempt_${pad}/${f}" "${dst}/${f}" 2>/dev/null || true
  done
  log_info "Artifacts copied from worktree to ${dst}/ (attempt ${att_num})"
}

##############################################################################
# 9. Build coder instruction with context — §5.4
##############################################################################
build_instruction() {
  local att_dir="$1" att_num="$2" wt="$3" bref="$4" goal="$5" acceptance="$6"
  local ifile="${att_dir}/coder/instruction.txt"
  local task_type; task_type=$(json_read "$TASK_JSON" "task_type" "")
  local is_eng_impl=""
  [ "$task_type" = "engineering_impl" ] || [ "$task_type" = "engineering_implementation" ] && is_eng_impl="1"
  mkdir -p "${att_dir}/coder"
  {
    echo "=== CONTEXT ==="
    echo ""
    if [ "$att_num" -gt 1 ]; then
      local pp; pp=$(printf "%03d" $(( att_num - 1 )))
      local pv="${TASK_DIR}/attempt_${pp}/judge/verdict.json"
      if [ -f "$pv" ]; then
        local ni; ni=$(json_read "$pv" "next_instructions" "")
        if [ -n "$ni" ]; then
          echo "Previous judge instructions:"
          echo "$ni"
          echo ""
        fi
      fi
      if [ -n "$is_eng_impl" ]; then
        local prc_f="${TASK_DIR}/attempt_${pp}/test/rc.txt"
        local plog="${TASK_DIR}/attempt_${pp}/test/stdout.log"
        if [ -f "$prc_f" ]; then
          local prc; prc=$(cat "$prc_f" 2>/dev/null || echo "")
          echo "Previous test result: rc=${prc}"
          [ -f "$plog" ] && { echo "Previous test log (tail ${TEST_LOG_TAIL_LINES} lines):"; tail -n "$TEST_LOG_TAIL_LINES" "$plog" 2>/dev/null || true; }
          echo ""
        fi
      fi
    fi
    if [ -n "$is_eng_impl" ]; then
      echo "Current diff --stat from ${bref}:"
      git -C "$wt" diff --stat "${bref}...HEAD" 2>/dev/null || echo "(no diff)"
      echo ""
      echo "Current HEAD:"
      git -C "$wt" log -1 --oneline 2>/dev/null || echo "(no commits)"
      echo ""
    fi
    echo "=== END CONTEXT ==="
    echo ""
    echo "=== GOAL ==="
    echo "$goal"
    echo ""
    echo "=== ACCEPTANCE CRITERIA ==="
    echo "$acceptance"
  } > "$ifile"
  # E5-2: Consume user_input.jsonl (incremental), append USER_INPUT block, set LAST_USER_INPUT_TS_CONSUMED
  consume_user_input "$ifile"
  echo "$ifile"
}

# E5-2: Read user_input.jsonl (lines after last_user_input_ts_consumed), append to instruction file; set LAST_USER_INPUT_TS_CONSUMED
consume_user_input() {
  local ifile="$1"
  [ -z "$ifile" ] || [ ! -f "$ifile" ] && return 0
  local ui_file="${TASK_DIR}/user_input.jsonl"
  [ ! -f "$ui_file" ] && return 0
  local prev_ts=""
  [ -f "${TASK_DIR}/status.json" ] && prev_ts=$(json_read "${TASK_DIR}/status.json" "last_user_input_ts_consumed" "" 2>/dev/null || echo "")
  LAST_USER_INPUT_TS_CONSUMED=$(python3 -c "
import json,sys,os
ifile=sys.argv[1]
ui_file=sys.argv[2]
prev_ts=sys.argv[3].strip() if len(sys.argv)>3 else ''
new_ts=prev_ts
lines_added=[]
try:
  with open(ui_file, encoding='utf-8') as f:
    for line in f:
      line=line.strip()
      if not line: continue
      try:
        ob=json.loads(line)
        ts=ob.get('ts') or ob.get('timestamp') or ''
        text=ob.get('text') or ob.get('content') or ''
        if not ts: continue
        if prev_ts and ts <= prev_ts: continue
        lines_added.append((ts,text))
        if not new_ts or ts > new_ts: new_ts=ts
      except: pass
  if lines_added:
    with open(ifile, 'a', encoding='utf-8') as out:
      out.write('\n\n=== USER_INPUT ===\n\n')
      for ts, text in lines_added:
        out.write(text)
        if not text.endswith('\n'): out.write('\n')
    print(new_ts)
  else:
    print(prev_ts if prev_ts else '')
except Exception as e:
  print(prev_ts if prev_ts else '')
" "$ifile" "$ui_file" "$prev_ts" 2>/dev/null || echo "")
  [ -z "$LAST_USER_INPUT_TS_CONSUMED" ] || export LAST_USER_INPUT_TS_CONSUMED
}

##############################################################################
# 10. Run a single attempt
##############################################################################
run_attempt() {
  local att_num="$1"
  local pad; pad=$(printf "%03d" "$att_num")
  local att_dir="${TASK_DIR}/attempt_${pad}"
  local cmd_log="${att_dir}/commands.log"
  CURRENT_ATTEMPT=$att_num
  # E5-2/K1-1a: Load previous last_user_input_ts_consumed so write_status can pass it; consume_user_input may update it
  [ -f "${TASK_DIR}/status.json" ] && LAST_USER_INPUT_TS_CONSUMED=$(json_read "${TASK_DIR}/status.json" "last_user_input_ts_consumed" "" 2>/dev/null || echo "")

  local repo base_ref goal acceptance test_cmd coder_type judge_type
  local coder_timeout test_timeout judge_timeout max_att
  repo=$(json_read "$TASK_JSON" "repo_path" "")
  base_ref=$(json_read "$TASK_JSON" "base_ref" "main")
  goal=$(json_read "$TASK_JSON" "goal" "")
  acceptance=$(json_read "$TASK_JSON" "acceptance" "")
  test_cmd=$(json_read "$TASK_JSON" "test_cmd" "true")
  coder_type=$(json_read "$TASK_JSON" "coder" "")
  judge_type=$(json_read "$TASK_JSON" "judge" "")
  coder_model=$(json_read "$TASK_JSON" "coder_model" "")
  judge_model=$(json_read "$TASK_JSON" "judge_model" "")
  # A6-2: Fallback to rdloop.config.json when TaskSpec does not specify coder/judge/model
  local config_json="${RDLOOP_ROOT}/rdloop.config.json"
  if [ -f "$config_json" ]; then
    [ -z "$coder_type" ] && coder_type=$(json_read "$config_json" "default_coder" "mock")
    [ -z "$judge_type" ] && judge_type=$(json_read "$config_json" "default_judge" "mock")
    [ -z "$coder_model" ] && coder_model=$(json_read "$config_json" "default_coder_model" "")
    [ -z "$judge_model" ] && judge_model=$(json_read "$config_json" "default_judge_model" "")
  fi
  [ -z "$coder_type" ] && coder_type="mock"
  [ -z "$judge_type" ] && judge_type="mock"
  # Unique task code + attempt for handoff tracing (coder/judge 1:1)
  local task_code; task_code=$(json_read "$TASK_JSON" "task_code" "")
  if [ -z "$task_code" ]; then
    task_code="rdloop-$(date +%s)-$$-${RANDOM}"
    python3 -c "import json; d=json.load(open('$TASK_JSON')); d['task_code']='$task_code'; json.dump(d, open('$TASK_JSON','w'), indent=2)"
  fi
  export RDLOOP_TASK_CODE="$task_code"
  export RDLOOP_ATTEMPT="$att_num"
  export CODER_MODEL="$coder_model"
  export JUDGE_MODEL="$judge_model"
  # Map display names to script suffix (call_coder_${suffix}.sh / call_judge_${suffix}.sh)
  case "$coder_type" in cursor-agent|cursor_cli) coder_script_suffix="cursor";; codex-cli|codex_cli) coder_script_suffix="codex";; claude-bridge|claude_bridge) coder_script_suffix="claude_bridge";; antigravity-cli) coder_script_suffix="antigravity";; *) coder_script_suffix="$coder_type";; esac
  case "$judge_type" in cursor-agent|cursor_cli) judge_script_suffix="cursor";; codex-cli|codex_cli) judge_script_suffix="codex";; antigravity-cli) judge_script_suffix="antigravity";; *) judge_script_suffix="$judge_type";; esac
  coder_timeout=$(json_read "$TASK_JSON" "coder_timeout_seconds" "600")
  test_timeout=$(json_read "$TASK_JSON" "test_timeout_seconds" "300")
  judge_timeout=$(json_read "$TASK_JSON" "judge_timeout_seconds" "300")
  max_att=$(json_read "$TASK_JSON" "max_attempts" "3")
  local task_type; task_type=$(json_read "$TASK_JSON" "task_type" "")
  local is_eng_impl=""
  [ "$task_type" = "engineering_impl" ] || [ "$task_type" = "engineering_implementation" ] && is_eng_impl="1"

  mkdir -p "${att_dir}/coder" "${att_dir}/test" "${att_dir}/git" "${att_dir}/judge"

  local att_start; att_start=$(now_iso)
  write_status "RUNNING" "$att_num" "$max_att" "false" "" "" '[]' "" "" "null" "${LAST_USER_INPUT_TS_CONSUMED:-}"
  write_event "$att_num" "ATTEMPT_STARTED" "attempt ${att_num} started" "$att_dir"

  # Worktree
  local wt; wt=$(setup_worktree "$att_num" "$repo" "$base_ref")
  write_env_json "$att_dir" "$task_code" "$att_num"

  # ---- BEFORE_CODER ----
  check_control_pause "BEFORE_CODER"

  # ---- CODER ----
  local c_start c_fin coder_rc=0
  c_start=$(now_iso)
  write_event "$att_num" "CODER_STARTED" "coder=${coder_type}" "$att_dir" "$wt"

  # Cursor uses cliapi (cursorcliapi 8000), same as other adapters; no queue CLI required
  local ifile; ifile=$(build_instruction "$att_dir" "$att_num" "$wt" "$base_ref" "$goal" "$acceptance")
  local coder_script="${LIB_DIR}/call_coder_${coder_script_suffix}.sh"
  if [ ! -f "$coder_script" ]; then
    log_error "Coder script not found: ${coder_script}"
    coder_rc=1
  else
    local c_s_epoch; c_s_epoch=$(date +%s)
    # timeout
    local tout=""
    command -v timeout >/dev/null 2>&1 && tout="timeout"
    [ -z "$tout" ] && command -v gtimeout >/dev/null 2>&1 && tout="gtimeout"
    if [ -n "$tout" ]; then
      set +e; $tout "$coder_timeout" bash "$coder_script" "$TASK_JSON" "$att_dir" "$wt" "$ifile"; coder_rc=$?; set -e
    else
      set +e; bash "$coder_script" "$TASK_JSON" "$att_dir" "$wt" "$ifile"; coder_rc=$?; set -e
    fi
    local c_e_epoch; c_e_epoch=$(date +%s)
    local c_secs=$(( c_e_epoch - c_s_epoch ))
    # rc=124 (timeout) and rc=195 (auth) take precedence over rc.txt
    if [ "$coder_rc" != "124" ] && [ "$coder_rc" != "195" ]; then
      [ -f "${att_dir}/coder/rc.txt" ] && coder_rc=$(cat "${att_dir}/coder/rc.txt" 2>/dev/null || echo "$coder_rc")
    fi
    [ ! -f "${att_dir}/coder/rc.txt" ] && echo "$coder_rc" > "${att_dir}/coder/rc.txt"
    write_commands_log "$att_num" "coder:${coder_type}" "$coder_rc" "$c_secs" "$cmd_log"
  fi
  c_fin=$(now_iso)
  write_event "$att_num" "CODER_FINISHED" "rc=${coder_rc}" "$att_dir" "$wt"

  # rc=195: coder auth failure → decision_table
  if [ "$coder_rc" = "195" ]; then
    update_consecutive_timeout "coder" "$coder_rc"
    local dj; dj=$(call_decision_table "coder" 195 "AUTH")
    act_on_decision "$dj" "" "$att_num" "$max_att"
    # act_on_decision exits for PAUSED; won't reach here
  fi

  # rc=124: coder timeout → decision_table
  if [ "$coder_rc" = "124" ]; then
    update_consecutive_timeout "coder" "$coder_rc"
    local dj; dj=$(call_decision_table "coder" 124 "TIMEOUT")
    act_on_decision "$dj" "" "$att_num" "$max_att"
  fi

  # Coder did not complete successfully (any other non-zero): do not run test or judge — no valid coder output to evaluate
  if [ "$coder_rc" != "0" ]; then
    log_info "Coder did not complete (rc=${coder_rc}); skipping test and judge"
    write_event "$att_num" "CODER_FAILED_SKIP_JUDGE" "rc=${coder_rc} — no test/judge run"
    enter_paused "PAUSED_CODER_FAILED" \
      "Coder did not complete (rc=${coder_rc}). Test and judge were not run." \
      "[\"Coder step failed (rc=${coder_rc}). Check coder/run.log and adapter (cliapi gateway); then use Run Next to retry.\"]" \
      "NEED_USER_INPUT" "" "true"
    NORMAL_EXIT=1; exit 0
  fi

  # Skip test and judge when run.log has no substantial coder output (do this before test so we never run test then pause without judge)
  local coder_log="${att_dir}/coder/run.log"
  local coder_log_size=0
  [ -f "$coder_log" ] && coder_log_size=$(wc -c < "$coder_log" 2>/dev/null || echo "0")
  if [ "$coder_log_size" -lt 600 ] 2>/dev/null; then
    log_info "Coder run.log too small (${coder_log_size} bytes); skipping test and judge"
    write_event "$att_num" "SKIP_TEST_JUDGE_NO_CODER_OUTPUT" "run.log size=${coder_log_size}"
    enter_paused "PAUSED_CODER_NO_OUTPUT" \
      "No substantial coder output (run.log too small). Test and judge were not run." \
      "[\"Coder run.log has only ${coder_log_size} bytes (need ≥600). Check out/<task_id>/attempt_*/coder/run.log and ensure the coder adapter (cliapi gateway) is running and returning output; then use Run Next to retry.\"]" \
      "NEED_USER_INPUT" "" "true"
    NORMAL_EXIT=1; exit 0
  fi

  check_control_pause "AFTER_CODER"
  check_control_pause "BEFORE_TEST"

  # ---- TEST (only for engineering_impl; other task types skip test) ----
  local t_start t_fin test_rc
  t_start=$(now_iso)
  if [ -n "$is_eng_impl" ]; then
    write_event "$att_num" "TEST_STARTED" "cmd=${test_cmd}" "$att_dir" "$wt"
    local t_s_epoch; t_s_epoch=$(date +%s)

    local tout=""
    command -v timeout >/dev/null 2>&1 && tout="timeout"
    [ -z "$tout" ] && command -v gtimeout >/dev/null 2>&1 && tout="gtimeout"

    set +e
    if [ -n "$tout" ]; then
      $tout "$test_timeout" bash -lc "cd '${wt}' && ${test_cmd}" > "${att_dir}/test/stdout.log" 2>&1
      test_rc=$?
    else
      bash -lc "cd '${wt}' && ${test_cmd}" > "${att_dir}/test/stdout.log" 2>&1
      test_rc=$?
    fi
    set -e
    [ "$test_rc" = "124" ] && echo "TIMEOUT after ${test_timeout}s" >> "${att_dir}/test/stdout.log"

    local t_e_epoch; t_e_epoch=$(date +%s)
    local t_secs=$(( t_e_epoch - t_s_epoch ))
    echo "$test_rc" > "${att_dir}/test/rc.txt"
    t_fin=$(now_iso)
    write_event "$att_num" "TEST_FINISHED" "rc=${test_rc}" "$att_dir" "$wt"
    write_commands_log "$att_num" "test:${test_cmd}" "$test_rc" "$t_secs" "$cmd_log"

    # rc=124: test timeout → decision_table (consume=true for test)
    if [ "$test_rc" = "124" ]; then
      update_consecutive_timeout "test" "$test_rc"
      local dj; dj=$(call_decision_table "test" 124 "TIMEOUT")
      act_on_decision "$dj" "" "$att_num" "$max_att"
    fi
  else
    echo "0" > "${att_dir}/test/rc.txt"
    echo "(test skipped for non-engineering_impl task_type)" > "${att_dir}/test/stdout.log"
    test_rc=0
    t_fin=$(now_iso)
    write_event "$att_num" "TEST_FINISHED" "rc=0 skipped (task_type=${task_type})" "$att_dir" "$wt"
    write_commands_log "$att_num" "test:skipped" "0" "0" "$cmd_log"
  fi

  check_control_pause "AFTER_TEST"

  # ---- GIT EVIDENCE ----
  git -C "$wt" diff "${base_ref}...HEAD" > "${att_dir}/git/diff.patch" 2>/dev/null || echo "" > "${att_dir}/git/diff.patch"
  git -C "$wt" diff --stat "${base_ref}...HEAD" > "${att_dir}/git/diff.stat" 2>/dev/null || echo "" > "${att_dir}/git/diff.stat"
  git -C "$wt" rev-parse HEAD > "${att_dir}/git/head_commit.txt" 2>/dev/null || echo "" > "${att_dir}/git/head_commit.txt"
  local hc; hc=$(cat "${att_dir}/git/head_commit.txt" 2>/dev/null || echo "")

  # Guardrails
  check_guardrails "$wt" "$base_ref"

  # ---- EVIDENCE BUNDLE ----
  local tlog_tail=""
  [ -f "${att_dir}/test/stdout.log" ] && tlog_tail=$(tail -n "$TEST_LOG_TAIL_LINES" "${att_dir}/test/stdout.log" 2>/dev/null || echo "")

  local cmds_json="[]"
  if [ -f "$cmd_log" ]; then
    cmds_json=$(python3 -c "
import json,sys
cs=[]
with open(sys.argv[1]) as f:
  for l in f:
    l=l.strip()
    if l:
      try: c=json.loads(l); cs.append({'cmd':c.get('cmd',''),'rc':c.get('rc',0),'seconds':c.get('seconds',0)})
      except: pass
print(json.dumps(cs))
" "$cmd_log" 2>/dev/null || echo "[]")
  fi

  write_evidence "$att_dir" "$att_num" "$wt" "$hc" "$test_cmd" "$test_rc" "$tlog_tail" "$cmds_json" "${att_dir}/coder/run.log" "$task_code"
  write_event "$att_num" "EVIDENCE_PACKED" "evidence.json written" "$att_dir" "$wt"

  check_control_pause "BEFORE_JUDGE"

  # ---- JUDGE ----
  local j_start j_fin judge_rc=0 j_retries=0
  j_start=$(now_iso)
  write_event "$att_num" "JUDGE_STARTED" "judge=${judge_type}" "$att_dir" "$wt"

  # Check codex CLI for codex-cli / codex_cli
  if [ "$judge_type" = "codex_cli" ] || [ "$judge_type" = "codex-cli" ]; then
    local cxcmd; cxcmd=$(json_read "$TASK_JSON" "codex_cmd" "codex")
    if ! command -v "$cxcmd" >/dev/null 2>&1; then
      write_event "$att_num" "JUDGE_FINISHED" "rc=127 codex missing" "$att_dir" "$wt"
      enter_paused "PAUSED_CODEX_MISSING" "codex CLI not found (${cxcmd})" \
        "[\"codex CLI missing, please install/login\"]"
      NORMAL_EXIT=1; exit 0
    fi
  fi

  local judge_script="${LIB_DIR}/call_judge_${judge_script_suffix}.sh"
  if [ ! -f "$judge_script" ]; then
    log_error "Judge script not found: ${judge_script}"
    enter_paused "PAUSED_JUDGE_INVALID" "judge script not found: ${judge_script}" \
      "[\"Judge adapter ${judge_type} not found.\"]"
    NORMAL_EXIT=1; exit 0
  fi

  # Judge prompt: prefer task_type-specific file (e.g. judge.prompt.requirements_doc.md), fallback to judge.prompt.md
  local task_type_tt; task_type_tt=$(json_read "$TASK_JSON" "task_type" "")
  local jprompt="${PROMPTS_DIR}/judge.prompt.md"
  if [ -n "$task_type_tt" ] && [ -f "${PROMPTS_DIR}/judge.prompt.${task_type_tt}.md" ]; then
    jprompt="${PROMPTS_DIR}/judge.prompt.${task_type_tt}.md"
  fi
  local jvalid=0

  # B4-7: run.log records Judge temperature=0 (deterministic output)
  log_info "Judge run with temperature=0 (B4-7)"

  while [ "$j_retries" -le "$JUDGE_MAX_RETRIES" ]; do
    local j_s_e; j_s_e=$(date +%s)
    local tout=""
    command -v timeout >/dev/null 2>&1 && tout="timeout"
    [ -z "$tout" ] && command -v gtimeout >/dev/null 2>&1 && tout="gtimeout"
    set +e
    if [ -n "$tout" ]; then
      $tout "$judge_timeout" bash "$judge_script" "$TASK_JSON" "${att_dir}/evidence.json" "$att_dir" "$jprompt"
      judge_rc=$?
    else
      bash "$judge_script" "$TASK_JSON" "${att_dir}/evidence.json" "$att_dir" "$jprompt"
      judge_rc=$?
    fi
    set -e
    local j_e_e; j_e_e=$(date +%s)
    local j_secs=$(( j_e_e - j_s_e ))
    write_commands_log "$att_num" "judge:${judge_type}" "$judge_rc" "$j_secs" "$cmd_log"

    if [ "$judge_rc" = "0" ] && [ -f "${att_dir}/judge/verdict.json" ]; then
      set +e
      python3 "${LIB_DIR}/validate_verdict.py" "${att_dir}/judge/verdict.json" 2>/dev/null
      local vrc=$?
      set -e
      # exit 0=valid, exit 2=K5-3 inconsistent (structurally valid, flagged in DECISION)
      if [ "$vrc" = "0" ] || [ "$vrc" = "2" ]; then jvalid=1; break; fi
      log_info "Verdict invalid (retry $((j_retries+1)))"
    else
      log_info "Judge failed rc=${judge_rc} (retry $((j_retries+1)))"
    fi
    j_retries=$(( j_retries + 1 ))
  done

  j_fin=$(now_iso)
  write_event "$att_num" "JUDGE_FINISHED" "rc=${judge_rc} valid=${jvalid} retries=${j_retries}" "$att_dir" "$wt"

  if [ "$jvalid" != "1" ]; then
    local att_e; att_e=$(date +%s)
    local att_s_e; att_s_e=$(epoch_from_iso "$att_start")
    local el=$(( att_e - att_s_e ))
    write_metrics "$att_dir" "$att_num" "$el" "$j_retries" "$coder_rc" "$test_rc" "$judge_rc" \
      "$att_start" "$c_start" "$c_fin" "$t_start" "$t_fin" "$j_start" "$j_fin" "[]"
    # Classify via decision_table
    local err_cls="VERDICT_INVALID"
    [ "$judge_rc" = "124" ] && err_cls="TIMEOUT"
    # Log verdict validation details when invalid for debugging
    if [ "$err_cls" = "VERDICT_INVALID" ] && [ -f "${att_dir}/judge/verdict.json" ]; then
      local val_err; val_err=$(python3 "${LIB_DIR}/validate_verdict.py" "${att_dir}/judge/verdict.json" 2>&1) || true
      [ -n "$val_err" ] && echo "$val_err" | while read -r line; do log_info "[validate_verdict] $line"; done
    fi
    log_info "Check judge output: ${att_dir}/judge/verdict.json and ${att_dir}/judge/extract_err.log (or codex_stderr.log / cursor_stderr.log)"
    update_consecutive_timeout "judge" "$judge_rc"
    local dj; dj=$(call_decision_table "judge" "$judge_rc" "$err_cls")
    act_on_decision "$dj" "" "$att_num" "$max_att"
    # act_on_decision exits for PAUSED/FAILED; should not reach here
    NORMAL_EXIT=1; exit 0
  fi

  check_control_pause "AFTER_JUDGE"

  # ---- B4-2/B4-6: Inject traceability fields into verdict.json ----
  inject_verdict_traceability "${att_dir}/judge/verdict.json" "$TASK_JSON" || true

  # ---- DECISION (via decision_table) ----
  # 1. Run validate_verdict.py to check structural + K5-3 consistency
  local validate_rc=0
  set +e
  python3 "${LIB_DIR}/validate_verdict.py" "${att_dir}/judge/verdict.json" 2>/dev/null
  validate_rc=$?
  set -e

  local error_class=""
  if [ "$validate_rc" = "1" ]; then
    error_class="VERDICT_INVALID"
    log_info "Verdict structurally invalid (validate_verdict exit 1)"
    local val_err; val_err=$(python3 "${LIB_DIR}/validate_verdict.py" "${att_dir}/judge/verdict.json" 2>&1) || true
    [ -n "$val_err" ] && echo "$val_err" | while read -r line; do log_info "[validate_verdict] $line"; done
    log_info "Check judge output: ${att_dir}/judge/verdict.json and ${att_dir}/judge/extract_err.log (or codex_stderr.log / cursor_stderr.log)"
  elif [ "$validate_rc" = "2" ]; then
    error_class="VERDICT_INCONSISTENT"
    log_info "Verdict K5-3 inconsistent (validate_verdict exit 2)"
  fi

  # 2. Read decision and detect B4 mode
  local decision; decision=$(json_read "${att_dir}/judge/verdict.json" "decision" "FAIL")
  local verdict_gated="false"
  local thresholds_pass="true"
  local final_score_for_summary=""

  local has_task_type; has_task_type=$(json_read "${att_dir}/judge/verdict.json" "task_type" "")
  local has_scores; has_scores=$(json_read "${att_dir}/judge/verdict.json" "scores" "")
  if [ -n "$has_task_type" ] && [ -n "$has_scores" ] && [ "$has_scores" != "{}" ]; then
    # B4 mode: read gated and final_score directly from verdict
    verdict_gated=$(json_read "${att_dir}/judge/verdict.json" "gated" "false")
    local final_score; final_score=$(json_read "${att_dir}/judge/verdict.json" "final_score_0_5" "0")
    final_score_for_summary=$(json_read "${att_dir}/judge/verdict.json" "final_score_0_100" "")
    thresholds_pass="true"
    # Check thresholds from task.json or rubric defaults
    local min_threshold; min_threshold=$(json_read "$TASK_JSON" "rubric_thresholds.min_score" "")
    if [ -n "$min_threshold" ]; then
      python3 -c "exit(0 if float('$final_score') >= float('$min_threshold') else 1)" 2>/dev/null || thresholds_pass="false"
    fi
    log_info "B4 verdict: task_type=${has_task_type} gated=${verdict_gated} final_0_5=${final_score} thresholds_pass=${thresholds_pass}"
  else
    # Legacy v1 mode: keep existing score/score_gate/score_threshold logic
    local score; score=$(json_read "${att_dir}/judge/verdict.json" "score" "")
    local gated_threshold; gated_threshold=$(json_read "$TASK_JSON" "score_gate" "")
    local min_threshold; min_threshold=$(json_read "$TASK_JSON" "score_threshold" "")
    if [ -n "$gated_threshold" ] && [ -n "$score" ]; then
      [ "$score" -lt "$gated_threshold" ] 2>/dev/null && verdict_gated="true"
    fi
    if [ -n "$min_threshold" ] && [ -n "$score" ]; then
      [ "$score" -lt "$min_threshold" ] 2>/dev/null && thresholds_pass="false"
    fi
  fi

  # If validate_verdict returned an error, route through decision_table with error_class
  if [ -n "$error_class" ]; then
    local att_e; att_e=$(date +%s)
    local att_s_e; att_s_e=$(epoch_from_iso "$att_start")
    local el=$(( att_e - att_s_e ))
    write_metrics "$att_dir" "$att_num" "$el" "$j_retries" "$coder_rc" "$test_rc" "$judge_rc" \
      "$att_start" "$c_start" "$c_fin" "$t_start" "$t_fin" "$j_start" "$j_fin" "[]"
    update_consecutive_timeout "judge" "$judge_rc"
    local dj; dj=$(call_decision_table "judge" "$judge_rc" "$error_class" "$decision" "$verdict_gated" "$thresholds_pass")
    act_on_decision "$dj" "$hc" "$att_num" "$max_att"
    NORMAL_EXIT=1; exit 0
  fi

  local att_e; att_e=$(date +%s)
  local att_s_e; att_s_e=$(epoch_from_iso "$att_start")
  local el=$(( att_e - att_s_e ))
  write_metrics "$att_dir" "$att_num" "$el" "$j_retries" "$coder_rc" "$test_rc" "$judge_rc" \
    "$att_start" "$c_start" "$c_fin" "$t_start" "$t_fin" "$j_start" "$j_fin" "[]"

  log_info "Attempt ${att_num} verdict: ${decision}"

  # Reset consecutive timeout on successful judge completion
  update_consecutive_timeout "judge" "$judge_rc"

  # K8-4: Copy artifacts from worktree to out/<task_id>/artifacts/ when judge will PASS
  if [ "$decision" = "PASS" ] && [ "$verdict_gated" = "false" ] && [ "$thresholds_pass" = "true" ]; then
    copy_artifacts "$wt" "$att_num"
  fi

  local dj; dj=$(call_decision_table "judge" "$judge_rc" "" "$decision" "$verdict_gated" "$thresholds_pass")
  act_on_decision "$dj" "$hc" "$att_num" "$max_att"
}

##############################################################################
# 11. --reset
##############################################################################
cmd_reset() {
  local tid="$1"; TASK_ID="$tid"; TASK_DIR="${OUT_DIR}/${tid}"; TASK_JSON="${TASK_DIR}/task.json"
  [ ! -d "$TASK_DIR" ] && { log_error "Task dir not found: ${TASK_DIR}"; NORMAL_EXIT=1; exit 1; }
  LOCK_DIR="${TASK_DIR}/.lockdir"
  if [ -d "$LOCK_DIR" ]; then
    local lp=""; [ -f "${LOCK_DIR}/pid" ] && lp=$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")
    local stale=0
    if [ -n "$lp" ]; then kill -0 "$lp" 2>/dev/null || stale=1; else stale=1; fi
    if [ "$stale" = "0" ] && [ -f "${LOCK_DIR}/started_at" ]; then
      local ls_t; ls_t=$(cat "${LOCK_DIR}/started_at" 2>/dev/null || echo "")
      local ne; ne=$(date +%s); local le; le=$(epoch_from_iso "$ls_t")
      [ "$le" != "0" ] && [ $(( ne - le )) -gt "$LOCK_STALE_SECONDS" ] && stale=1
    fi
    if [ "$stale" = "1" ]; then rm -rf "$LOCK_DIR"
    else log_error "Task still running (pid=${lp}). Stop it first."; NORMAL_EXIT=1; exit 1; fi
  fi
  # Clean worktrees
  local wtb="${WORKTREES_DIR}/${tid}"
  if [ -d "$wtb" ]; then
    local rp=""; [ -f "$TASK_JSON" ] && rp=$(json_read "$TASK_JSON" "repo_path" "")
    if [ -n "$rp" ] && [ -d "$rp" ]; then
      for w in "${wtb}"/attempt_*; do [ -d "$w" ] && { git -C "$rp" worktree remove --force "$w" 2>/dev/null || true; }; done
    fi
    rm -rf "$wtb"
  fi
  local ma=3; [ -f "$TASK_JSON" ] && ma=$(json_read "$TASK_JSON" "max_attempts" "3")
  local lt_reset='{"reason_code":"PAUSED_USER","previous_state":"RUNNING","message":"task reset"}'
  write_status "PAUSED" "0" "$ma" "false" "NEED_USER_INPUT" "reset performed" \
    '["Task has been reset. Use --continue or create new task."]' "PAUSED_MANUAL" "PAUSED_USER" "$lt_reset" ""
  write_final_summary "PAUSED" "NEED_USER_INPUT" "0" "$ma" "reset performed" \
    '["Task has been reset. Use --continue or create new task."]' "PAUSED_MANUAL" "PAUSED_USER" ""
  write_event "0" "TASK_RESET" "task reset performed"
  log_info "Task ${tid} has been reset"
  NORMAL_EXIT=1; exit 0
}

##############################################################################
# 12. --rerun-attempt
##############################################################################
cmd_rerun_attempt() {
  local tid="$1" from_att="$2"
  TASK_ID="$tid"; TASK_DIR="${OUT_DIR}/${tid}"; TASK_JSON="${TASK_DIR}/task.json"
  [ ! -f "$TASK_JSON" ] && { log_error "Task not found"; NORMAL_EXIT=1; exit 1; }
  local mx=0
  for d in "${TASK_DIR}"/attempt_*; do
    if [ -d "$d" ]; then
      local n; n=$(basename "$d" | sed 's/attempt_//' | sed 's/^0*//')
      [ -n "$n" ] && [ "$n" -gt "$mx" ] && mx=$n
    fi
  done
  local nxt=$(( mx + 1 )); CURRENT_ATTEMPT=$nxt
  local fp; fp=$(printf "%03d" "$from_att")
  local np; np=$(printf "%03d" "$nxt")
  local nad="${TASK_DIR}/attempt_${np}"
  mkdir -p "${nad}/coder"
  [ -f "${TASK_DIR}/attempt_${fp}/coder/instruction.txt" ] && \
    cp "${TASK_DIR}/attempt_${fp}/coder/instruction.txt" "${nad}/coder/instruction.txt"
  write_event "$nxt" "ATTEMPT_STARTED" "RERUN_FROM=attempt_${fp}" "$nad"
  if ! acquire_lock; then ensure_status_on_lock_fail; NORMAL_EXIT=1; exit 0; fi
  run_attempt "$nxt"
  release_lock; NORMAL_EXIT=1
}

##############################################################################
# 13. --self-improve
##############################################################################
cmd_self_improve() {
  local idea="$1"
  [ ! -f "$idea" ] && { log_error "idea file not found: ${idea}"; exit 1; }
  local ic; ic=$(cat "$idea")
  local ts; ts=$(date +%Y%m%d_%H%M%S)
  local tid="self_improve_${ts}"
  local sf="/tmp/rdloop_self_improve_${ts}.json"
  python3 -c "
import json,sys
d={'schema_version':'v1','task_id':sys.argv[1],'repo_path':sys.argv[2],
   'base_ref':'main','goal':sys.argv[3],'acceptance':sys.argv[3],
   'test_cmd':'bash regression/run_regression.sh','max_attempts':3,
   'coder':'cursor_cli','judge':'codex_cli','constraints':[],
   'created_at':'','target_type':'rdloop_self',
   'allowed_paths':[],'forbidden_globs':['**/.env','**/secrets*','**/*.pem'],
   'cursor_cmd':'cursor','codex_cmd':'codex',
   'coder_timeout_seconds':600,'judge_timeout_seconds':300,'test_timeout_seconds':300}
with open(sys.argv[4],'w') as f: json.dump(d,f,indent=2)
" "$tid" "$RDLOOP_ROOT" "$ic" "$sf"
  log_info "Generated self-improve task: ${tid}"
  exec bash "$0" "$sf"
}

##############################################################################
# 14. ensure_status_on_lock_fail — §19 check 2
##############################################################################
ensure_status_on_lock_fail() {
  if [ ! -f "${TASK_DIR}/status.json" ]; then
    local ma=3; [ -f "${TASK_JSON:-}" ] && ma=$(json_read "$TASK_JSON" "max_attempts" "3")
    write_status "RUNNING" "0" "$ma" "false" "" "" '[]' "" "" "null" ""
  fi
  local ma; ma=$(json_read "${TASK_DIR}/status.json" "max_attempts" "3")
  local ca; ca=$(json_read "${TASK_DIR}/status.json" "current_attempt" "0")
  local st; st=$(json_read "${TASK_DIR}/status.json" "state" "RUNNING")
  write_status "$st" "$ca" "$ma" "false" "" "already running" '[]' "" "" "null" ""
}

##############################################################################
# 15. New task
##############################################################################
cmd_new_task() {
  local sf="$1"
  [ ! -f "$sf" ] && { log_error "Spec not found: ${sf}"; exit 1; }
  TASK_ID=$(json_read "$sf" "task_id" "")
  [ -z "$TASK_ID" ] && { log_error "task_id missing in spec"; exit 1; }
  TASK_DIR="${OUT_DIR}/${TASK_ID}"
  # §5.2 uniqueness
  if [ -f "${TASK_DIR}/task.json" ]; then
    TASK_JSON="${TASK_DIR}/task.json"
    enter_paused "PAUSED_TASK_ID_CONFLICT" "task_id '${TASK_ID}' already exists" \
      "[\"task_id ${TASK_ID} already exists. Use --continue or choose a different task_id.\"]"
    NORMAL_EXIT=1; exit 0
  fi
  mkdir -p "$TASK_DIR"
  # Copy spec + fill created_at + generate unique task_code for handoff tracing
  python3 -c "
import json,sys,datetime,uuid
with open(sys.argv[1]) as f: d=json.load(f)
if not d.get('created_at'): d['created_at']=datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
if not d.get('task_code'): d['task_code']=str(uuid.uuid4())
with open(sys.argv[2],'w') as f: json.dump(d,f,indent=2)
" "$sf" "${TASK_DIR}/task.json"
  TASK_JSON="${TASK_DIR}/task.json"

  # Resolve relative repo_path
  local rp; rp=$(json_read "$TASK_JSON" "repo_path" "")
  if [ -n "$rp" ]; then
    case "$rp" in
      /*) ;;
      *)
        local sd; sd=$(cd "$(dirname "$sf")" && pwd)
        local ar="${sd}/${rp}"
        if [ -d "$ar" ]; then
          rp=$(cd "$ar" && pwd)
          python3 -c "
import json,sys
with open(sys.argv[1]) as f: d=json.load(f)
d['repo_path']=sys.argv[2]
with open(sys.argv[1],'w') as f: json.dump(d,f,indent=2)
" "$TASK_JSON" "$rp"
        fi ;;
    esac
  fi

  local ma; ma=$(json_read "$TASK_JSON" "max_attempts" "3")
  EFFECTIVE_MAX_ATTEMPTS="$ma"
  load_runtime_overrides
  write_status "RUNNING" "0" "$EFFECTIVE_MAX_ATTEMPTS" "false" "" "" '[]' "" "" "null" ""
  write_event "0" "TASK_CREATED" "task created from ${sf}"

  if ! acquire_lock; then
    ensure_status_on_lock_fail
    log_info "Task ${TASK_ID} already running"
    NORMAL_EXIT=1; exit 0
  fi

  local att=1
  while [ "$att" -le "$EFFECTIVE_MAX_ATTEMPTS" ]; do
    process_control
    load_runtime_overrides
    run_attempt "$att"
    att=$(( att + 1 ))
  done
  release_lock; NORMAL_EXIT=1
}

##############################################################################
# 16. --continue
##############################################################################
cmd_continue() {
  local tid="$1"; TASK_ID="$tid"; TASK_DIR="${OUT_DIR}/${tid}"; TASK_JSON="${TASK_DIR}/task.json"
  [ ! -f "$TASK_JSON" ] && { log_error "Task not found: ${TASK_JSON}"; NORMAL_EXIT=1; exit 1; }
  local ma; ma=$(json_read "$TASK_JSON" "max_attempts" "3")
  EFFECTIVE_MAX_ATTEMPTS="$ma"
  load_runtime_overrides
  # Load consecutive timeout state from previous status
  if [ -f "${TASK_DIR}/status.json" ]; then
    local prev_lt_count; prev_lt_count=$(json_read "${TASK_DIR}/status.json" "last_transition.consecutive_count" "0")
    local prev_lt_key; prev_lt_key=$(json_read "${TASK_DIR}/status.json" "last_transition.reason_key" "")
    [ -n "$prev_lt_count" ] && [ "$prev_lt_count" != "0" ] && {
      CONSECUTIVE_TIMEOUT_COUNT="$prev_lt_count"
      CONSECUTIVE_TIMEOUT_KEY="$prev_lt_key"
    }
    # Restore state_version
    local prev_sv; prev_sv=$(json_read "${TASK_DIR}/status.json" "state_version" "1")
    [ -n "$prev_sv" ] && STATE_VERSION="$prev_sv"
  fi
  local mx=0
  for d in "${TASK_DIR}"/attempt_*; do
    if [ -d "$d" ]; then
      local n; n=$(basename "$d" | sed 's/attempt_//' | sed 's/^0*//')
      [ -n "$n" ] && [ "$n" -gt "$mx" ] && mx=$n
    fi
  done
  CURRENT_ATTEMPT=$mx
  process_control
  # If user sent RESUME from READY_FOR_REVIEW/FAILED, we just set RUNNING; do not exit as terminal state
  local cs=""; [ -f "${TASK_DIR}/status.json" ] && cs=$(json_read "${TASK_DIR}/status.json" "state" "")
  if [ "$CONTROL_RESUME_APPLIED" = "1" ]; then
    cs="RUNNING"
  fi
  if [ "$cs" = "READY_FOR_REVIEW" ] || [ "$cs" = "FAILED" ]; then
    log_info "Task ${tid} in terminal state: ${cs}"; NORMAL_EXIT=1; exit 0
  fi
  if ! acquire_lock; then
    ensure_status_on_lock_fail; log_info "Task ${TASK_ID} already running"; NORMAL_EXIT=1; exit 0
  fi
  local nxt=$(( mx + 1 ))
  if [ "$nxt" -le "$EFFECTIVE_MAX_ATTEMPTS" ]; then
    write_status "RUNNING" "$CURRENT_ATTEMPT" "$EFFECTIVE_MAX_ATTEMPTS" "false" "" "" '[]' "" "" "null" "${LAST_USER_INPUT_TS_CONSUMED:-}"
    local att=$nxt
    while [ "$att" -le "$EFFECTIVE_MAX_ATTEMPTS" ]; do
      process_control; load_runtime_overrides; run_attempt "$att"; att=$(( att + 1 ))
    done
  else
    log_info "No more attempts (${mx}/${EFFECTIVE_MAX_ATTEMPTS})"
  fi
  release_lock; NORMAL_EXIT=1
}

##############################################################################
# 17. Entry point
##############################################################################
main() {
  mkdir -p "$OUT_DIR" "$WORKTREES_DIR"
  if [ $# -lt 1 ]; then
    echo "Usage:"
    echo "  run_task.sh <task_spec.json>"
    echo "  run_task.sh --continue <task_id>"
    echo "  run_task.sh --reset <task_id>"
    echo "  run_task.sh --rerun-attempt <task_id> <n>"
    echo "  run_task.sh --self-improve <idea.md>"
    exit 1
  fi
  case "$1" in
    --continue) [ $# -lt 2 ] && { log_error "--continue needs task_id"; exit 1; }; cmd_continue "$2" ;;
    --reset) [ $# -lt 2 ] && { log_error "--reset needs task_id"; exit 1; }; cmd_reset "$2" ;;
    --rerun-attempt) [ $# -lt 3 ] && { log_error "needs task_id + attempt"; exit 1; }; cmd_rerun_attempt "$2" "$3" ;;
    --self-improve) [ $# -lt 2 ] && { log_error "needs idea.md"; exit 1; }; cmd_self_improve "$2" ;;
    *) cmd_new_task "$1" ;;
  esac
}

main "$@"
