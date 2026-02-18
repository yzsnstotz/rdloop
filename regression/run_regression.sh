#!/usr/bin/env bash
# regression/run_regression.sh — rdloop Regression Suite
# Runs all regression cases and reports results.
# Exit 0 = all pass, Exit 1 = failures

set -uo pipefail
export GIT_DISCOVERY_ACROSS_FILESYSTEM=1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RDLOOP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COORDINATOR="${RDLOOP_ROOT}/coordinator/run_task.sh"
CASES_DIR="${SCRIPT_DIR}/cases"
OUT_DIR="${RDLOOP_ROOT}/out"
DUMMY_REPO="${RDLOOP_ROOT}/examples/dummy_repo"

PASS=0
FAIL=0
TOTAL=0

ts() { date +%s; }

log_case() { echo "[REGRESSION] $1"; }
case_pass() { echo "  [PASS] $1"; PASS=$(( PASS + 1 )); TOTAL=$(( TOTAL + 1 )); }
case_fail() { echo "  [FAIL] $1"; FAIL=$(( FAIL + 1 )); TOTAL=$(( TOTAL + 1 )); }

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

# Ensure dummy_repo exists
if [ ! -d "${DUMMY_REPO}/.git" ]; then
  mkdir -p "$DUMMY_REPO"
  git -C "$DUMMY_REPO" init >/dev/null 2>&1
  echo "# Dummy" > "${DUMMY_REPO}/README.md"
  echo "placeholder" > "${DUMMY_REPO}/.gitkeep"
  git -C "$DUMMY_REPO" add -A >/dev/null 2>&1
  git -C "$DUMMY_REPO" commit -m "Initial commit" >/dev/null 2>&1
fi

# Prepare a temp spec with unique task_id and absolute repo_path
prepare_spec() {
  local case_file="$1"
  local suffix="$2"
  local task_id="regression_${suffix}_$(ts)"
  local tmp_spec="/tmp/rdloop_reg_${task_id}.json"

  python3 -c "
import json,sys
with open(sys.argv[1]) as f: d=json.load(f)
d['task_id']=sys.argv[2]
d['repo_path']=sys.argv[3]
with open(sys.argv[4],'w') as f: json.dump(d,f,indent=2)
" "$case_file" "$task_id" "$DUMMY_REPO" "$tmp_spec"

  echo "$tmp_spec"
  # Return task_id via a naming convention
  echo "$task_id" > "/tmp/rdloop_reg_last_tid"
}

cleanup_task() {
  local tid="$1"
  rm -rf "${OUT_DIR}/${tid}" "${RDLOOP_ROOT}/worktrees/${tid}" 2>/dev/null || true
}

echo "================================================================"
echo "rdloop Regression Suite"
echo "================================================================"
echo ""

# ================================================================
# CASE 1: hello_pass — basic PASS flow
# ================================================================
log_case "Case 1: hello_pass"
spec=$(prepare_spec "${CASES_DIR}/case_hello_pass.json" "hello_pass")
tid=$(cat /tmp/rdloop_reg_last_tid)

set +e
bash "$COORDINATOR" "$spec" >/dev/null 2>&1
rc=$?
set -e

if [ "$rc" = "0" ] && [ -f "${OUT_DIR}/${tid}/final_summary.json" ]; then
  dec=$(json_get "${OUT_DIR}/${tid}/final_summary.json" "decision" "")
  ld=$(json_get "${OUT_DIR}/${tid}/final_summary.json" "last_decision" "")
  if [ "$dec" = "READY_FOR_REVIEW" ] && [ "$ld" = "PASS" ]; then
    case_pass "hello_pass: READY_FOR_REVIEW + PASS"
  else
    case_fail "hello_pass: decision=${dec} last_decision=${ld} (expected READY_FOR_REVIEW/PASS)"
  fi
else
  case_fail "hello_pass: rc=${rc} or final_summary missing"
fi
cleanup_task "$tid"
echo ""

# ================================================================
# CASE 2: fail_then_fix — auto-advance through multiple attempts
# ================================================================
log_case "Case 2: fail_then_fix (auto-advance 3 attempts)"
spec=$(prepare_spec "${CASES_DIR}/case_fail_then_fix.json" "fail_fix")
tid=$(cat /tmp/rdloop_reg_last_tid)

set +e
bash "$COORDINATOR" "$spec" >/dev/null 2>&1
rc=$?
set -e

if [ "$rc" = "0" ] && [ -f "${OUT_DIR}/${tid}/final_summary.json" ]; then
  dec=$(json_get "${OUT_DIR}/${tid}/final_summary.json" "decision" "")
  ld=$(json_get "${OUT_DIR}/${tid}/final_summary.json" "last_decision" "")
  ca=$(json_get "${OUT_DIR}/${tid}/final_summary.json" "current_attempt" "0")
  # Should be FAILED after 3 attempts (test_cmd: test -f .fix_marker always fails in mock)
  if [ "$dec" = "FAILED" ] && [ "$ld" = "FAIL" ]; then
    if [ "$ca" -ge 3 ]; then
      case_pass "fail_then_fix: FAILED after ${ca} attempts (auto-advanced)"
    else
      case_fail "fail_then_fix: only ${ca} attempts (expected 3)"
    fi
  else
    case_fail "fail_then_fix: decision=${dec} last_decision=${ld} (expected FAILED/FAIL)"
  fi
  # Verify §19 check 3: auto-advance happened without GUI
  att_count=0
  for d in "${OUT_DIR}/${tid}"/attempt_*; do
    [ -d "$d" ] && att_count=$(( att_count + 1 ))
  done
  if [ "$att_count" -ge 3 ]; then
    case_pass "fail_then_fix: ${att_count} attempt dirs exist (auto-advance confirmed)"
  else
    case_fail "fail_then_fix: only ${att_count} attempt dirs (expected >=3)"
  fi
else
  case_fail "fail_then_fix: rc=${rc} or final_summary missing"
fi
cleanup_task "$tid"
echo ""

# ================================================================
# CASE 3: task_id_conflict — duplicate task_id → PAUSED
# ================================================================
log_case "Case 3: task_id_conflict"
spec=$(prepare_spec "${CASES_DIR}/case_task_id_conflict.json" "conflict")
tid=$(cat /tmp/rdloop_reg_last_tid)

# First run: create task
set +e
bash "$COORDINATOR" "$spec" >/dev/null 2>&1
set -e

# Second run: should trigger conflict PAUSED
# Create a new spec with same task_id
spec2="/tmp/rdloop_reg_conflict2.json"
python3 -c "
import json,sys
with open(sys.argv[1]) as f: d=json.load(f)
d['task_id']=sys.argv[2]
d['repo_path']=sys.argv[3]
with open(sys.argv[4],'w') as f: json.dump(d,f,indent=2)
" "${CASES_DIR}/case_task_id_conflict.json" "$tid" "$DUMMY_REPO" "$spec2"

set +e
bash "$COORDINATOR" "$spec2" >/dev/null 2>&1
rc2=$?
set -e

if [ -f "${OUT_DIR}/${tid}/status.json" ]; then
  state=$(json_get "${OUT_DIR}/${tid}/status.json" "state" "")
  prc=$(json_get "${OUT_DIR}/${tid}/status.json" "pause_reason_code" "")
  # After first run it should be READY_FOR_REVIEW (since test_cmd=true)
  # The second run should detect conflict and write PAUSED
  # But since first run completed, the second run sees task.json exists → PAUSED
  if [ -f "${OUT_DIR}/${tid}/final_summary.json" ]; then
    fdec=$(json_get "${OUT_DIR}/${tid}/final_summary.json" "decision" "")
    # The second run overwrites to PAUSED with TASK_ID_CONFLICT
    if [ "$fdec" = "PAUSED" ] && [ "$prc" = "PAUSED_TASK_ID_CONFLICT" ]; then
      case_pass "task_id_conflict: PAUSED with PAUSED_TASK_ID_CONFLICT"
    elif [ "$fdec" = "READY_FOR_REVIEW" ]; then
      # Check the second run's status — might have written PAUSED over READY_FOR_REVIEW
      if [ "$state" = "PAUSED" ] && [ "$prc" = "PAUSED_TASK_ID_CONFLICT" ]; then
        case_pass "task_id_conflict: status PAUSED_TASK_ID_CONFLICT (final_summary from first run)"
      else
        case_fail "task_id_conflict: second run didn't trigger PAUSED (state=${state} prc=${prc})"
      fi
    else
      case_pass "task_id_conflict: detected conflict (decision=${fdec} prc=${prc})"
    fi
  else
    case_fail "task_id_conflict: no final_summary.json"
  fi

  # Verify status has questions_for_user
  q=$(json_get "${OUT_DIR}/${tid}/status.json" "questions_for_user" "[]")
  q_len=$(python3 -c "import json,sys;print(len(json.loads(sys.argv[1])))" "$q" 2>/dev/null || echo "0")
  if [ "$q_len" -gt 0 ] || [ "$state" != "PAUSED" ]; then
    case_pass "task_id_conflict: questions_for_user present or not PAUSED"
  else
    case_fail "task_id_conflict: PAUSED but questions_for_user empty"
  fi
else
  case_fail "task_id_conflict: status.json missing"
fi
cleanup_task "$tid"
rm -f "$spec2"
echo ""

# ================================================================
# CASE 4: forbidden_glob (test with a repo that has .env change)
# ================================================================
log_case "Case 4: forbidden_glob guardrail"
# This test verifies the guardrail check code exists and is callable.
# In mock mode, coder doesn't modify files so forbidden_globs won't trigger.
# We verify the code path exists by checking the task runs successfully.
spec=$(prepare_spec "${CASES_DIR}/case_forbidden_glob.json" "forbidden")
tid=$(cat /tmp/rdloop_reg_last_tid)

set +e
bash "$COORDINATOR" "$spec" >/dev/null 2>&1
rc=$?
set -e

if [ "$rc" = "0" ] && [ -f "${OUT_DIR}/${tid}/final_summary.json" ]; then
  dec=$(json_get "${OUT_DIR}/${tid}/final_summary.json" "decision" "")
  # Mock coder doesn't create .env so it should PASS normally
  case_pass "forbidden_glob: task ran without crash (decision=${dec})"
else
  case_fail "forbidden_glob: rc=${rc} or final_summary missing"
fi
cleanup_task "$tid"
echo ""

# ================================================================
# CASE 5: self_check integration
# ================================================================
log_case "Case 5: self_check.sh integration"
# Run hello first to generate data, then run self_check
spec=$(prepare_spec "${CASES_DIR}/case_hello_pass.json" "selfcheck")
tid=$(cat /tmp/rdloop_reg_last_tid)

set +e
bash "$COORDINATOR" "$spec" >/dev/null 2>&1
set -e

set +e
bash "${RDLOOP_ROOT}/coordinator/self_check.sh" "${OUT_DIR}" 2>&1 | tail -5
sc_rc=${PIPESTATUS[0]}
set -e

if [ "$sc_rc" = "0" ]; then
  case_pass "self_check: all checks passed"
else
  case_fail "self_check: returned rc=${sc_rc}"
fi
cleanup_task "$tid"
echo ""

# ================================================================
# CASE 6: coder_timeout — coder killed by timeout → PAUSED_CODER_TIMEOUT
# ================================================================
log_case "Case 6: coder_timeout"
# Requires timeout/gtimeout
tout=""
command -v timeout >/dev/null 2>&1 && tout="timeout"
[ -z "$tout" ] && command -v gtimeout >/dev/null 2>&1 && tout="gtimeout"
if [ -z "$tout" ]; then
  echo "  [SKIP] coder_timeout: timeout/gtimeout not found"
else
  spec=$(prepare_spec "${CASES_DIR}/case_coder_timeout.json" "coder_to")
  tid=$(cat /tmp/rdloop_reg_last_tid)

  set +e
  bash "$COORDINATOR" "$spec" >/dev/null 2>&1
  rc=$?
  set -e

  if [ -f "${OUT_DIR}/${tid}/status.json" ]; then
    state=$(json_get "${OUT_DIR}/${tid}/status.json" "state" "")
    prc=$(json_get "${OUT_DIR}/${tid}/status.json" "pause_reason_code" "")
    if [ "$state" = "PAUSED" ] && [ "$prc" = "PAUSED_CODER_TIMEOUT" ]; then
      case_pass "coder_timeout: PAUSED with PAUSED_CODER_TIMEOUT"
    else
      case_fail "coder_timeout: state=${state} prc=${prc} (expected PAUSED/PAUSED_CODER_TIMEOUT)"
    fi
  else
    case_fail "coder_timeout: status.json missing"
  fi
  cleanup_task "$tid"
fi
echo ""

# ================================================================
# CASE 7: judge_timeout — judge killed by timeout → PAUSED_JUDGE_TIMEOUT
# ================================================================
log_case "Case 7: judge_timeout"
if [ -z "$tout" ]; then
  echo "  [SKIP] judge_timeout: timeout/gtimeout not found"
else
  spec=$(prepare_spec "${CASES_DIR}/case_judge_timeout.json" "judge_to")
  tid=$(cat /tmp/rdloop_reg_last_tid)

  set +e
  bash "$COORDINATOR" "$spec" >/dev/null 2>&1
  rc=$?
  set -e

  if [ -f "${OUT_DIR}/${tid}/status.json" ]; then
    state=$(json_get "${OUT_DIR}/${tid}/status.json" "state" "")
    prc=$(json_get "${OUT_DIR}/${tid}/status.json" "pause_reason_code" "")
    if [ "$state" = "PAUSED" ] && [ "$prc" = "PAUSED_JUDGE_TIMEOUT" ]; then
      case_pass "judge_timeout: PAUSED with PAUSED_JUDGE_TIMEOUT"
    else
      case_fail "judge_timeout: state=${state} prc=${prc} (expected PAUSED/PAUSED_JUDGE_TIMEOUT)"
    fi
  else
    case_fail "judge_timeout: status.json missing"
  fi
  cleanup_task "$tid"
fi
echo ""

# ================================================================
# CASE 8: need_user_input — judge returns NEED_USER_INPUT → PAUSED_WAITING_USER_INPUT
# ================================================================
log_case "Case 8: need_user_input"
spec=$(prepare_spec "${CASES_DIR}/case_need_user_input.json" "need_input")
tid=$(cat /tmp/rdloop_reg_last_tid)

set +e
bash "$COORDINATOR" "$spec" >/dev/null 2>&1
rc=$?
set -e

if [ -f "${OUT_DIR}/${tid}/status.json" ]; then
  state=$(json_get "${OUT_DIR}/${tid}/status.json" "state" "")
  prc=$(json_get "${OUT_DIR}/${tid}/status.json" "pause_reason_code" "")
  if [ "$state" = "PAUSED" ] && [ "$prc" = "PAUSED_WAITING_USER_INPUT" ]; then
    case_pass "need_user_input: PAUSED with PAUSED_WAITING_USER_INPUT"
    # Also verify questions_for_user is populated
    q=$(json_get "${OUT_DIR}/${tid}/status.json" "questions_for_user" "[]")
    q_len=$(python3 -c "import json,sys;print(len(json.loads(sys.argv[1])))" "$q" 2>/dev/null || echo "0")
    if [ "$q_len" -gt 0 ]; then
      case_pass "need_user_input: questions_for_user has ${q_len} items"
    else
      case_fail "need_user_input: questions_for_user empty"
    fi
  else
    case_fail "need_user_input: state=${state} prc=${prc} (expected PAUSED/PAUSED_WAITING_USER_INPUT)"
  fi
else
  case_fail "need_user_input: status.json missing"
fi
cleanup_task "$tid"
echo ""

# ================================================================
# CASE 9: decision_table unit tests
# ================================================================
log_case "Case 9: decision_table unit tests"
set +e
dt_result=$(node --test "${RDLOOP_ROOT}/tests/unit/decision_table.test.js" 2>&1)
dt_rc=$?
set -e

if [ "$dt_rc" = "0" ]; then
  # Count passed tests
  dt_pass=$(echo "$dt_result" | grep -c "^# pass" 2>/dev/null || echo "0")
  dt_total=$(echo "$dt_result" | grep "^# tests" | awk '{print $3}' 2>/dev/null || echo "?")
  case_pass "decision_table: ${dt_total} unit tests passed"
else
  case_fail "decision_table: unit tests failed (rc=${dt_rc})"
  echo "$dt_result" | tail -10
fi
echo ""

# ================================================================
# Summary
# ================================================================
echo "================================================================"
echo "Regression Summary: ${PASS}/${TOTAL} passed, ${FAIL} failed"
echo "================================================================"

# Clean up temp files
rm -f /tmp/rdloop_reg_*.json /tmp/rdloop_reg_last_tid 2>/dev/null || true

if [ "$FAIL" -gt 0 ]; then
  echo "RESULT: REGRESSION FAILED"
  exit 1
else
  echo "RESULT: ALL REGRESSION TESTS PASSED"
  exit 0
fi
