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

get_pause_category() {
  local code="$1"
  case "$code" in
    PAUSED_CURSOR_MISSING|PAUSED_CODEX_MISSING|PAUSED_CRASH|PAUSED_NOT_GIT_REPO|PAUSED_TASK_ID_CONFLICT)
      echo "PAUSED_INFRA" ;;
    PAUSED_JUDGE_INVALID|PAUSED_JUDGE_TIMEOUT)
      echo "PAUSED_JUDGE" ;;
    PAUSED_ALLOWED_PATHS|PAUSED_FORBIDDEN_GLOBS)
      echo "PAUSED_POLICY" ;;
    PAUSED_USER)
      echo "PAUSED_MANUAL" ;;
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
# 2. JSON writers
##############################################################################
write_status() {
  local state="$1" cur_att="$2" max_att="$3" pflag="$4" last_dec="$5"
  local msg="$6" q_json="$7" pcat="$8" prcode="$9"
  python3 -c "
import json,sys
d={'task_id':sys.argv[1],'state':sys.argv[2],'current_attempt':int(sys.argv[3]),
   'max_attempts':int(sys.argv[4]),'pause_flag':sys.argv[5]=='true',
   'last_decision':sys.argv[6],'message':sys.argv[7],
   'questions_for_user':json.loads(sys.argv[8]),
   'pause_category':sys.argv[9],'pause_reason_code':sys.argv[10],
   'updated_at':sys.argv[11]}
with open(sys.argv[12],'w') as f: json.dump(d,f,indent=2)
" "$TASK_ID" "$state" "$cur_att" "$max_att" "$pflag" \
  "$last_dec" "$msg" "$q_json" "$pcat" "$prcode" \
  "$(now_iso)" "${TASK_DIR}/status.json"
}

write_final_summary() {
  local decision="$1" last_dec="$2" cur_att="$3" max_att="$4"
  local msg="$5" q_json="$6" pcat="$7" prcode="$8" head_c="$9"
  python3 -c "
import json,sys
d={'task_id':sys.argv[1],'decision':sys.argv[2],'last_decision':sys.argv[3],
   'current_attempt':int(sys.argv[4]),'max_attempts':int(sys.argv[5]),
   'message':sys.argv[6],'questions_for_user':json.loads(sys.argv[7]),
   'pause_category':sys.argv[8],'pause_reason_code':sys.argv[9],
   'final_head_commit':sys.argv[10],'updated_at':sys.argv[11]}
with open(sys.argv[12],'w') as f: json.dump(d,f,indent=2)
" "$TASK_ID" "$decision" "$last_dec" "$cur_att" "$max_att" \
  "$msg" "$q_json" "$pcat" "$prcode" "$head_c" \
  "$(now_iso)" "${TASK_DIR}/final_summary.json"
}

write_event() {
  local att="$1" etype="$2" summary="$3"
  local att_dir="${4:-}" wt_dir="${5:-}"
  python3 -c "
import json,sys
e={'ts':sys.argv[1],'task_id':sys.argv[2],'attempt':int(sys.argv[3]) if sys.argv[3] else 0,
   'type':sys.argv[4],'summary':sys.argv[5],
   'paths':{'out_dir':sys.argv[6],'attempt_dir':sys.argv[7],
            'worktree_dir':sys.argv[8],'status_path':sys.argv[9]}}
with open(sys.argv[10],'a') as f: f.write(json.dumps(e)+'\n')
" "$(now_iso)" "$TASK_ID" "$att" "$etype" "$summary" \
  "${TASK_DIR}" "$att_dir" "$wt_dir" "${TASK_DIR}/status.json" \
  "${TASK_DIR}/events.jsonl"
}

write_commands_log() {
  local att="$1" cmd="$2" rc="$3" secs="$4" logf="$5"
  python3 -c "
import json,sys
e={'ts':sys.argv[1],'attempt':int(sys.argv[2]),'cmd':sys.argv[3],
   'rc':int(sys.argv[4]),'seconds':float(sys.argv[5])}
with open(sys.argv[6],'a') as f: f.write(json.dumps(e)+'\n')
" "$(now_iso)" "$att" "$cmd" "$rc" "$secs" "$logf"
}

write_metrics() {
  local att_dir="$1" att_num="$2" elapsed="$3" jretries="$4"
  local crc="$5" trc="$6" jrc="$7"
  local a_start="$8" c_start="${9:-}" c_fin="${10:-}"
  local t_start="${11:-}" t_fin="${12:-}" j_start="${13:-}" j_fin="${14:-}"
  local notes="${15:-[]}"
  python3 -c "
import json,sys
d={'schema_version':'v1','task_id':sys.argv[1],'attempt':int(sys.argv[2]),
   'elapsed_seconds':float(sys.argv[3]),'judge_retries':int(sys.argv[4]),
   'phase_ts':{'attempt_started_at':sys.argv[5],'coder_started_at':sys.argv[6],
     'coder_finished_at':sys.argv[7],'test_started_at':sys.argv[8],
     'test_finished_at':sys.argv[9],'judge_started_at':sys.argv[10],
     'judge_finished_at':sys.argv[11]},
   'coder_rc':int(sys.argv[12]),'test_rc':int(sys.argv[13]),
   'judge_rc':int(sys.argv[14]),'notes':json.loads(sys.argv[15])}
with open(sys.argv[16],'w') as f: json.dump(d,f,indent=2)
" "$TASK_ID" "$att_num" "$elapsed" "$jretries" \
  "$a_start" "$c_start" "$c_fin" "$t_start" "$t_fin" "$j_start" "$j_fin" \
  "$crc" "$trc" "$jrc" "$notes" "${att_dir}/metrics.json"
}

write_evidence() {
  local att_dir="$1" att_num="$2" wt_path="$3" head_c="$4"
  local tcmd="$5" trc="$6" tlog_tail="$7" cmds_json="$8"
  python3 -c "
import json,sys
d={'schema_version':'v1','task_id':sys.argv[1],'attempt':int(sys.argv[2]),
   'worktree_path':sys.argv[3],'created_at':sys.argv[4],
   'git':{'diff_stat_path':'git/diff.stat','diff_patch_path':'git/diff.patch',
          'head_commit':sys.argv[5]},
   'commands':json.loads(sys.argv[6]),
   'test':{'cmd':sys.argv[7],'rc':int(sys.argv[8]),'log_tail':sys.argv[9]},
   'artifacts':[],'metrics_path':'metrics.json'}
with open(sys.argv[10],'w') as f: json.dump(d,f,indent=2)
" "$TASK_ID" "$att_num" "$wt_path" "$(now_iso)" "$head_c" \
  "$cmds_json" "$tcmd" "$trc" "$tlog_tail" "${att_dir}/evidence.json"
}

write_env_json() {
  local att_dir="$1"
  local os_info git_ver node_ver py_ver
  os_info=$(uname -srm 2>/dev/null || echo "unknown")
  git_ver=$(git --version 2>/dev/null || echo "unknown")
  node_ver=$(node -v 2>/dev/null || echo "N/A")
  py_ver=$(python3 -V 2>/dev/null || echo "N/A")
  local cur_avail="false" cur_path="" codex_avail="false" codex_path="" claude_avail="false" claude_path=""
  command -v cursor >/dev/null 2>&1 && { cur_avail="true"; cur_path=$(command -v cursor); }
  command -v codex >/dev/null 2>&1 && { codex_avail="true"; codex_path=$(command -v codex); }
  command -v claude >/dev/null 2>&1 && { claude_avail="true"; claude_path=$(command -v claude); }
  python3 -c "
import json,sys
d={'os':sys.argv[1],'node_version':sys.argv[2],'python_version':sys.argv[3],
   'git_version':sys.argv[4],
   'cursor_available':sys.argv[5]=='true','cursor_path':sys.argv[6],
   'codex_available':sys.argv[7]=='true','codex_path':sys.argv[8],
   'claude_available':sys.argv[9]=='true','claude_path':sys.argv[10]}
with open(sys.argv[11],'w') as f: json.dump(d,f,indent=2)
" "$os_info" "$node_ver" "$py_ver" "$git_ver" \
  "$cur_avail" "$cur_path" "$codex_avail" "$codex_path" \
  "$claude_avail" "$claude_path" "${att_dir}/env.json"
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
cleanup() {
  set +e
  if [ "$NORMAL_EXIT" = "1" ]; then
    release_lock; return
  fi
  # Abnormal: write PAUSED_CRASH if still RUNNING
  if [ -n "${TASK_DIR:-}" ] && [ -d "${TASK_DIR:-}" ]; then
    local cs=""
    [ -f "${TASK_DIR}/status.json" ] && cs=$(json_read "${TASK_DIR}/status.json" "state" "")
    if [ "$cs" = "RUNNING" ] || [ -z "$cs" ]; then
      local ma=3
      [ -f "${TASK_JSON:-}" ] && ma=$(json_read "$TASK_JSON" "max_attempts" "3")
      [ ! -f "${TASK_DIR}/status.json" ] && {
        # ensure status exists before writing
        write_status "RUNNING" "$CURRENT_ATTEMPT" "$ma" "false" "" "" '[]' "" ""
      }
      write_status "PAUSED" "$CURRENT_ATTEMPT" "$ma" "false" \
        "NEED_USER_INPUT" "coordinator crashed or was killed" \
        '["Please check logs and re-run with --continue"]' \
        "PAUSED_INFRA" "PAUSED_CRASH"
      write_final_summary "PAUSED" "NEED_USER_INPUT" "$CURRENT_ATTEMPT" "$ma" \
        "coordinator crashed or was killed" \
        '["Please check logs and re-run with --continue"]' \
        "PAUSED_INFRA" "PAUSED_CRASH" ""
      write_event "$CURRENT_ATTEMPT" "STATE_CHANGED" "PAUSED_CRASH" 2>/dev/null || true
    fi
  fi
  release_lock
}
trap cleanup EXIT ERR INT TERM

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
    write_status "PAUSED" "$CURRENT_ATTEMPT" "$ma" "true" \
      "" "paused at checkpoint: ${cpname}" \
      '["User requested PAUSE. Use --continue to resume."]' \
      "PAUSED_MANUAL" "PAUSED_USER"
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

process_control() {
  local cf="${TASK_DIR}/control.json"
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
      write_status "RUNNING" "$CURRENT_ATTEMPT" "$ma" "false" "" "" '[]' "" ""
      rm -f "$cf"; [ -n "$nonce" ] && echo "$nonce" >> "$pf"
      write_event "$CURRENT_ATTEMPT" "STATE_CHANGED" "RESUMED via control"
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
##############################################################################
enter_paused() {
  local rcode="$1" msg="$2" qjson="$3"
  local ldec="${4:-NEED_USER_INPUT}" hc="${5:-}"
  local ma; ma=$(json_read "$TASK_JSON" "max_attempts" "3")
  local cat; cat=$(get_pause_category "$rcode")
  write_status "PAUSED" "$CURRENT_ATTEMPT" "$ma" "false" \
    "$ldec" "$msg" "$qjson" "$cat" "$rcode"
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
# 9. Build coder instruction with context — §5.4
##############################################################################
build_instruction() {
  local att_dir="$1" att_num="$2" wt="$3" bref="$4" goal="$5" acceptance="$6"
  local ifile="${att_dir}/coder/instruction.txt"
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
      local prc_f="${TASK_DIR}/attempt_${pp}/test/rc.txt"
      local plog="${TASK_DIR}/attempt_${pp}/test/stdout.log"
      if [ -f "$prc_f" ]; then
        local prc; prc=$(cat "$prc_f" 2>/dev/null || echo "")
        echo "Previous test result: rc=${prc}"
        [ -f "$plog" ] && { echo "Previous test log (tail ${TEST_LOG_TAIL_LINES} lines):"; tail -n "$TEST_LOG_TAIL_LINES" "$plog" 2>/dev/null || true; }
        echo ""
      fi
    fi
    echo "Current diff --stat from ${bref}:"
    git -C "$wt" diff --stat "${bref}...HEAD" 2>/dev/null || echo "(no diff)"
    echo ""
    echo "Current HEAD:"
    git -C "$wt" log -1 --oneline 2>/dev/null || echo "(no commits)"
    echo ""
    echo "=== END CONTEXT ==="
    echo ""
    echo "=== GOAL ==="
    echo "$goal"
    echo ""
    echo "=== ACCEPTANCE CRITERIA ==="
    echo "$acceptance"
  } > "$ifile"
  echo "$ifile"
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

  local repo base_ref goal acceptance test_cmd coder_type judge_type
  local coder_timeout test_timeout judge_timeout max_att
  repo=$(json_read "$TASK_JSON" "repo_path" "")
  base_ref=$(json_read "$TASK_JSON" "base_ref" "main")
  goal=$(json_read "$TASK_JSON" "goal" "")
  acceptance=$(json_read "$TASK_JSON" "acceptance" "")
  test_cmd=$(json_read "$TASK_JSON" "test_cmd" "true")
  coder_type=$(json_read "$TASK_JSON" "coder" "mock")
  judge_type=$(json_read "$TASK_JSON" "judge" "mock")
  coder_timeout=$(json_read "$TASK_JSON" "coder_timeout_seconds" "600")
  test_timeout=$(json_read "$TASK_JSON" "test_timeout_seconds" "300")
  judge_timeout=$(json_read "$TASK_JSON" "judge_timeout_seconds" "300")
  max_att=$(json_read "$TASK_JSON" "max_attempts" "3")

  mkdir -p "${att_dir}/coder" "${att_dir}/test" "${att_dir}/git" "${att_dir}/judge"

  local att_start; att_start=$(now_iso)
  write_status "RUNNING" "$att_num" "$max_att" "false" "" "" '[]' "" ""
  write_event "$att_num" "ATTEMPT_STARTED" "attempt ${att_num} started" "$att_dir"

  # Worktree
  local wt; wt=$(setup_worktree "$att_num" "$repo" "$base_ref")
  write_env_json "$att_dir"

  # ---- BEFORE_CODER ----
  check_control_pause "BEFORE_CODER"

  # ---- CODER ----
  local c_start c_fin coder_rc=0
  c_start=$(now_iso)
  write_event "$att_num" "CODER_STARTED" "coder=${coder_type}" "$att_dir" "$wt"

  # Check cursor CLI for cursor_cli
  if [ "$coder_type" = "cursor_cli" ]; then
    local ccmd; ccmd=$(json_read "$TASK_JSON" "cursor_cmd" "cursor")
    if ! command -v "$ccmd" >/dev/null 2>&1; then
      echo "127" > "${att_dir}/coder/rc.txt"
      echo "[CODER] cursor CLI not found" > "${att_dir}/coder/run.log"
      write_event "$att_num" "CODER_FINISHED" "rc=127 cursor missing" "$att_dir" "$wt"
      enter_paused "PAUSED_CURSOR_MISSING" "cursor CLI not found (${ccmd})" \
        "[\"cursor CLI missing, please fix PATH/install\"]"
      NORMAL_EXIT=1; exit 0
    fi
  fi

  local ifile; ifile=$(build_instruction "$att_dir" "$att_num" "$wt" "$base_ref" "$goal" "$acceptance")
  local coder_script="${LIB_DIR}/call_coder_${coder_type}.sh"
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
    [ -f "${att_dir}/coder/rc.txt" ] && coder_rc=$(cat "${att_dir}/coder/rc.txt" 2>/dev/null || echo "$coder_rc")
    [ ! -f "${att_dir}/coder/rc.txt" ] && echo "$coder_rc" > "${att_dir}/coder/rc.txt"
    write_commands_log "$att_num" "coder:${coder_type}" "$coder_rc" "$c_secs" "$cmd_log"
  fi
  c_fin=$(now_iso)
  write_event "$att_num" "CODER_FINISHED" "rc=${coder_rc}" "$att_dir" "$wt"

  check_control_pause "AFTER_CODER"
  check_control_pause "BEFORE_TEST"

  # ---- TEST ----
  local t_start t_fin test_rc
  t_start=$(now_iso)
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

  write_evidence "$att_dir" "$att_num" "$wt" "$hc" "$test_cmd" "$test_rc" "$tlog_tail" "$cmds_json"
  write_event "$att_num" "EVIDENCE_PACKED" "evidence.json written" "$att_dir" "$wt"

  check_control_pause "BEFORE_JUDGE"

  # ---- JUDGE ----
  local j_start j_fin judge_rc=0 j_retries=0
  j_start=$(now_iso)
  write_event "$att_num" "JUDGE_STARTED" "judge=${judge_type}" "$att_dir" "$wt"

  # Check codex CLI
  if [ "$judge_type" = "codex_cli" ]; then
    local cxcmd; cxcmd=$(json_read "$TASK_JSON" "codex_cmd" "codex")
    if ! command -v "$cxcmd" >/dev/null 2>&1; then
      write_event "$att_num" "JUDGE_FINISHED" "rc=127 codex missing" "$att_dir" "$wt"
      enter_paused "PAUSED_CODEX_MISSING" "codex CLI not found (${cxcmd})" \
        "[\"codex CLI missing, please install/login\"]"
      NORMAL_EXIT=1; exit 0
    fi
  fi

  local judge_script="${LIB_DIR}/call_judge_${judge_type}.sh"
  if [ ! -f "$judge_script" ]; then
    log_error "Judge script not found: ${judge_script}"
    enter_paused "PAUSED_JUDGE_INVALID" "judge script not found: ${judge_script}" \
      "[\"Judge adapter ${judge_type} not found.\"]"
    NORMAL_EXIT=1; exit 0
  fi

  local jprompt="${PROMPTS_DIR}/judge.prompt.md"
  local jvalid=0

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
      if [ "$vrc" = "0" ]; then jvalid=1; break; fi
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
    if [ "$judge_rc" = "124" ]; then
      enter_paused "PAUSED_JUDGE_TIMEOUT" "judge timed out after retries" \
        "[\"Judge timed out. Check out/${TASK_ID}/attempt_${pad}/judge/* and rerun --continue.\"]"
    else
      enter_paused "PAUSED_JUDGE_INVALID" "judge output invalid after retries" \
        "[\"Judge output invalid or timed out. Please intervene.\"]"
    fi
    NORMAL_EXIT=1; exit 0
  fi

  check_control_pause "AFTER_JUDGE"

  # ---- DECISION ----
  local decision; decision=$(json_read "${att_dir}/judge/verdict.json" "decision" "FAIL")

  local att_e; att_e=$(date +%s)
  local att_s_e; att_s_e=$(epoch_from_iso "$att_start")
  local el=$(( att_e - att_s_e ))
  write_metrics "$att_dir" "$att_num" "$el" "$j_retries" "$coder_rc" "$test_rc" "$judge_rc" \
    "$att_start" "$c_start" "$c_fin" "$t_start" "$t_fin" "$j_start" "$j_fin" "[]"

  log_info "Attempt ${att_num} decision: ${decision}"

  case "$decision" in
    PASS)
      write_status "READY_FOR_REVIEW" "$att_num" "$max_att" "false" "PASS" "All checks passed" '[]' "" ""
      write_final_summary "READY_FOR_REVIEW" "PASS" "$att_num" "$max_att" "All checks passed" '[]' "" "" "$hc"
      write_event "$att_num" "STATE_CHANGED" "READY_FOR_REVIEW"
      NORMAL_EXIT=1; exit 0
      ;;
    NEED_USER_INPUT)
      local qj; qj=$(json_read "${att_dir}/judge/verdict.json" "questions_for_user" "[]")
      enter_paused "PAUSED_JUDGE_INVALID" "judge requests user input" "$qj" "NEED_USER_INPUT" "$hc"
      NORMAL_EXIT=1; exit 0
      ;;
    FAIL)
      if [ "$att_num" -ge "$max_att" ]; then
        write_status "FAILED" "$att_num" "$max_att" "false" "FAIL" "max attempts reached" '[]' "" ""
        write_final_summary "FAILED" "FAIL" "$att_num" "$max_att" "max attempts reached" '[]' "" "" "$hc"
        write_event "$att_num" "STATE_CHANGED" "FAILED"
        NORMAL_EXIT=1; exit 0
      fi
      write_status "RUNNING" "$att_num" "$max_att" "false" "FAIL" "advancing to next attempt" '[]' "" ""
      log_info "Auto-advancing to attempt $(( att_num + 1 ))"
      ;;
    *)
      enter_paused "PAUSED_JUDGE_INVALID" "unknown decision: ${decision}" \
        "[\"Unknown judge decision. Check verdict.json.\"]"
      NORMAL_EXIT=1; exit 0
      ;;
  esac
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
  write_status "PAUSED" "0" "$ma" "false" "NEED_USER_INPUT" "reset performed" \
    '["Task has been reset. Use --continue or create new task."]' "PAUSED_MANUAL" "PAUSED_USER"
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
    write_status "RUNNING" "0" "$ma" "false" "" "" '[]' "" ""
  fi
  local ma; ma=$(json_read "${TASK_DIR}/status.json" "max_attempts" "3")
  local ca; ca=$(json_read "${TASK_DIR}/status.json" "current_attempt" "0")
  local st; st=$(json_read "${TASK_DIR}/status.json" "state" "RUNNING")
  write_status "$st" "$ca" "$ma" "false" "" "already running" '[]' "" ""
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
  # Copy spec + fill created_at
  python3 -c "
import json,sys,datetime
with open(sys.argv[1]) as f: d=json.load(f)
if not d.get('created_at'): d['created_at']=datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
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
  write_status "RUNNING" "0" "$ma" "false" "" "" '[]' "" ""
  write_event "0" "TASK_CREATED" "task created from ${sf}"

  if ! acquire_lock; then
    ensure_status_on_lock_fail
    log_info "Task ${TASK_ID} already running"
    NORMAL_EXIT=1; exit 0
  fi

  local att=1
  while [ "$att" -le "$ma" ]; do
    process_control
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
  local mx=0
  for d in "${TASK_DIR}"/attempt_*; do
    if [ -d "$d" ]; then
      local n; n=$(basename "$d" | sed 's/attempt_//' | sed 's/^0*//')
      [ -n "$n" ] && [ "$n" -gt "$mx" ] && mx=$n
    fi
  done
  CURRENT_ATTEMPT=$mx
  process_control
  local cs=""; [ -f "${TASK_DIR}/status.json" ] && cs=$(json_read "${TASK_DIR}/status.json" "state" "")
  if [ "$cs" = "READY_FOR_REVIEW" ] || [ "$cs" = "FAILED" ]; then
    log_info "Task ${tid} in terminal state: ${cs}"; NORMAL_EXIT=1; exit 0
  fi
  if ! acquire_lock; then
    ensure_status_on_lock_fail; log_info "Task ${TASK_ID} already running"; NORMAL_EXIT=1; exit 0
  fi
  local nxt=$(( mx + 1 ))
  if [ "$nxt" -le "$ma" ]; then
    write_status "RUNNING" "$CURRENT_ATTEMPT" "$ma" "false" "" "" '[]' "" ""
    local att=$nxt
    while [ "$att" -le "$ma" ]; do
      process_control; run_attempt "$att"; att=$(( att + 1 ))
    done
  else
    log_info "No more attempts (${mx}/${ma})"
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
