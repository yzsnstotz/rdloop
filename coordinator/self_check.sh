#!/usr/bin/env bash
# coordinator/self_check.sh — §19 Four Critical Checks
# Scans out/* and validates:
#   1. PAUSED alignment (status + final_summary)
#   2. Lock failure → status.json exists
#   3. Auto-advance logic (FAIL auto-advances without GUI)
#   4. Trap cleanup (PAUSED_CRASH writes)
# Usage: bash coordinator/self_check.sh [out_dir]
# Exit 0 = all pass, Exit 1 = failures found

set -uo pipefail

RDLOOP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-${RDLOOP_ROOT}/out}"

PASS=0
FAIL=0
WARN=0

check_pass() { echo "  [PASS] $1"; PASS=$(( PASS + 1 )); }
check_fail() { echo "  [FAIL] $1"; FAIL=$(( FAIL + 1 )); }
check_warn() { echo "  [WARN] $1"; WARN=$(( WARN + 1 )); }

json_get() {
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
" "$1" "$2" "${3:-}" 2>/dev/null
}

echo "================================================================"
echo "rdloop self_check.sh — §19 Critical Checks"
echo "Scanning: ${OUT_DIR}"
echo "================================================================"
echo ""

# Enumerate tasks
task_count=0
for task_dir in "${OUT_DIR}"/*/; do
  [ ! -d "$task_dir" ] && continue
  task_id=$(basename "$task_dir")
  [ "$task_id" = "*" ] && continue
  [[ "$task_id" == _* ]] && continue
  task_count=$(( task_count + 1 ))

  echo "--- Task: ${task_id} ---"

  status_file="${task_dir}/status.json"
  summary_file="${task_dir}/final_summary.json"
  task_file="${task_dir}/task.json"
  events_file="${task_dir}/events.jsonl"

  # =========================================================
  # CHECK 1: PAUSED alignment — status + final_summary both exist and match
  # =========================================================
  echo " Check 1: PAUSED alignment"
  if [ ! -f "$status_file" ]; then
    check_fail "status.json missing"
  else
    local_state=$(json_get "$status_file" "state" "")
    if [ "$local_state" = "PAUSED" ]; then
      # Must have final_summary
      if [ ! -f "$summary_file" ]; then
        check_fail "state=PAUSED but final_summary.json missing"
      else
        s_decision=$(json_get "$summary_file" "decision" "")
        if [ "$s_decision" != "PAUSED" ]; then
          check_fail "status=PAUSED but final_summary.decision='${s_decision}' (expected PAUSED)"
        else
          check_pass "PAUSED: status and final_summary aligned"
        fi
      fi

      # questions_for_user must be non-empty
      q=$(json_get "$status_file" "questions_for_user" "[]")
      q_len=$(python3 -c "import json,sys;print(len(json.loads(sys.argv[1])))" "$q" 2>/dev/null || echo "0")
      if [ "$q_len" = "0" ]; then
        check_fail "PAUSED but questions_for_user is empty"
      else
        check_pass "PAUSED: questions_for_user non-empty"
      fi

      # pause_reason_code must be in enum
      prc=$(json_get "$status_file" "pause_reason_code" "")
      valid_codes="PAUSED_CURSOR_MISSING PAUSED_CODEX_MISSING PAUSED_JUDGE_INVALID PAUSED_JUDGE_TIMEOUT PAUSED_ALLOWED_PATHS PAUSED_FORBIDDEN_GLOBS PAUSED_USER PAUSED_CRASH PAUSED_TASK_ID_CONFLICT PAUSED_NOT_GIT_REPO PAUSED_CODER_AUTH_195 PAUSED_JUDGE_AUTH_195 PAUSED_CODER_TIMEOUT PAUSED_TEST_TIMEOUT PAUSED_WAITING_USER_INPUT PAUSED_SCORE_GATED PAUSED_SCORE_BELOW_THRESHOLD PAUSED_JUDGE_VERDICT_INVALID PAUSED_JUDGE_VERDICT_INCONSISTENT"
      found=0
      for vc in $valid_codes; do
        [ "$prc" = "$vc" ] && found=1
      done
      if [ "$found" = "0" ]; then
        check_fail "PAUSED but pause_reason_code='${prc}' not in valid enum"
      else
        check_pass "PAUSED: pause_reason_code valid (${prc})"
      fi

      # pause_category check
      pcat=$(json_get "$status_file" "pause_category" "")
      if [ -z "$pcat" ]; then
        check_fail "PAUSED but pause_category is empty"
      else
        check_pass "PAUSED: pause_category set (${pcat})"
      fi

    elif [ "$local_state" = "READY_FOR_REVIEW" ] || [ "$local_state" = "FAILED" ]; then
      # Terminal states: final_summary should exist
      if [ -f "$summary_file" ]; then
        s_decision=$(json_get "$summary_file" "decision" "")
        if [ "$local_state" = "READY_FOR_REVIEW" ] && [ "$s_decision" = "READY_FOR_REVIEW" ]; then
          check_pass "READY_FOR_REVIEW: aligned"
        elif [ "$local_state" = "FAILED" ] && [ "$s_decision" = "FAILED" ]; then
          check_pass "FAILED: aligned"
        else
          check_fail "state=${local_state} but final_summary.decision=${s_decision}"
        fi
      else
        check_fail "Terminal state ${local_state} but final_summary.json missing"
      fi
    elif [ "$local_state" = "RUNNING" ]; then
      check_pass "state=RUNNING (in progress or already running)"
    else
      check_warn "Unknown state: ${local_state}"
    fi
  fi

  # =========================================================
  # CHECK 2: status.json always exists (even on lock fail)
  # =========================================================
  echo " Check 2: status.json existence"
  if [ -f "$status_file" ]; then
    # Verify all 11 required fields present
    fields_ok=1
    for field in task_id state current_attempt max_attempts pause_flag last_decision message questions_for_user pause_category pause_reason_code updated_at; do
      val=$(json_get "$status_file" "$field" "__MISSING__")
      if [ "$val" = "__MISSING__" ]; then
        check_fail "status.json missing field: ${field}"
        fields_ok=0
      fi
    done
    [ "$fields_ok" = "1" ] && check_pass "status.json has all 11 required fields"

    # Check P0 new fields: state_version, effective_max_attempts
    # These are WARN (not FAIL) for pre-P0 tasks that lack them
    sv=$(json_get "$status_file" "state_version" "__MISSING__")
    if [ "$sv" = "__MISSING__" ] || [ "$sv" = "0" ] || [ "$sv" = "" ]; then
      check_warn "status.json missing or zero state_version (pre-P0 task?)"
    else
      check_pass "status.json has state_version=${sv}"
    fi

    ema=$(json_get "$status_file" "effective_max_attempts" "__MISSING__")
    if [ "$ema" = "__MISSING__" ] || [ "$ema" = "" ]; then
      check_warn "status.json missing effective_max_attempts (pre-P0 task?)"
    else
      check_pass "status.json has effective_max_attempts=${ema}"
    fi

    # Check _index/tasks/<task_id>.json exists (A1-6)
    # WARN for pre-P0 tasks that lack it
    index_file="${OUT_DIR}/_index/tasks/${task_id}.json"
    if [ -f "$index_file" ]; then
      idx_tid=$(json_get "$index_file" "task_id" "")
      if [ "$idx_tid" = "$task_id" ]; then
        check_pass "_index/tasks/${task_id}.json exists and valid"
      else
        check_fail "_index/tasks/${task_id}.json has wrong task_id='${idx_tid}'"
      fi
    else
      check_warn "_index/tasks/${task_id}.json missing (pre-P0 task?)"
    fi
  else
    check_fail "status.json does not exist at all"
  fi

  # =========================================================
  # CHECK 3: Auto-advance verification
  # =========================================================
  echo " Check 3: Auto-advance (FAIL + attempt < max → next attempt)"
  if [ -f "$task_file" ]; then
    max_att=$(json_get "$task_file" "max_attempts" "1")
    # Count attempt dirs
    att_count=0
    for d in "${task_dir}"attempt_*; do
      [ -d "$d" ] && att_count=$(( att_count + 1 ))
    done

    if [ -f "$status_file" ]; then
      final_state=$(json_get "$status_file" "state" "")
      last_dec=$(json_get "$status_file" "last_decision" "")
      cur_att=$(json_get "$status_file" "current_attempt" "0")

      if [ "$final_state" = "FAILED" ] && [ "$max_att" -gt 1 ]; then
        if [ "$att_count" -ge "$max_att" ]; then
          check_pass "Auto-advance: FAILED after ${att_count}/${max_att} attempts (all used)"
        else
          check_warn "FAILED but only ${att_count}/${max_att} attempts run"
        fi
      elif [ "$final_state" = "READY_FOR_REVIEW" ]; then
        check_pass "Auto-advance: PASS reached (no need to exhaust attempts)"
      elif [ "$final_state" = "PAUSED" ]; then
        check_pass "Auto-advance: PAUSED (external factor, not auto-advance issue)"
      elif [ "$final_state" = "RUNNING" ]; then
        check_pass "Auto-advance: still RUNNING"
      fi
    fi
  else
    check_warn "No task.json to verify auto-advance"
  fi

  # =========================================================
  # CHECK 4: Trap cleanup (PAUSED_CRASH writes)
  # =========================================================
  echo " Check 4: Trap cleanup verification"
  if [ -f "$status_file" ]; then
    prc=$(json_get "$status_file" "pause_reason_code" "")
    state=$(json_get "$status_file" "state" "")

    if [ "$prc" = "PAUSED_CRASH" ]; then
      # If PAUSED_CRASH, lockdir should not exist (cleaned by trap)
      if [ -d "${task_dir}/.lockdir" ]; then
        lock_pid=""
        [ -f "${task_dir}/.lockdir/pid" ] && lock_pid=$(cat "${task_dir}/.lockdir/pid" 2>/dev/null || echo "")
        if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
          check_warn "PAUSED_CRASH but lockdir still held by live process ${lock_pid}"
        else
          check_fail "PAUSED_CRASH but stale lockdir remains (trap did not clean)"
        fi
      else
        check_pass "PAUSED_CRASH: lockdir properly cleaned"
      fi

      # final_summary should exist
      if [ -f "$summary_file" ]; then
        sd=$(json_get "$summary_file" "decision" "")
        if [ "$sd" = "PAUSED" ]; then
          check_pass "PAUSED_CRASH: final_summary aligned"
        else
          check_fail "PAUSED_CRASH: final_summary.decision='${sd}' (expected PAUSED)"
        fi
      else
        check_fail "PAUSED_CRASH but no final_summary.json"
      fi
    elif [ "$state" = "RUNNING" ]; then
      # Check if lockdir exists
      if [ -d "${task_dir}/.lockdir" ]; then
        lock_pid=""
        [ -f "${task_dir}/.lockdir/pid" ] && lock_pid=$(cat "${task_dir}/.lockdir/pid" 2>/dev/null || echo "")
        if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
          check_pass "RUNNING with live lock (pid=${lock_pid})"
        else
          check_fail "RUNNING but lockdir stale (pid=${lock_pid:-none} not alive) — trap should have cleaned"
        fi
      else
        check_pass "RUNNING without lockdir (normal after completion)"
      fi
    else
      check_pass "Trap check: no crash scenario detected"
    fi
  fi

  echo ""
done

if [ "$task_count" = "0" ]; then
  echo "No tasks found in ${OUT_DIR}/"
  echo "Run examples/run_hello.sh first."
  exit 1
fi

echo "================================================================"
echo "Summary: ${PASS} passed, ${FAIL} failed, ${WARN} warnings"
echo "================================================================"

if [ "$FAIL" -gt 0 ]; then
  echo "RESULT: FAILED"
  exit 1
else
  echo "RESULT: ALL CHECKS PASSED"
  exit 0
fi
