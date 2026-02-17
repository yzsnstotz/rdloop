# Judge failure troubleshooting

When a task stops with **PAUSED_JUDGE_TIMEOUT** or **PAUSED_JUDGE_INVALID** after several judge attempts, use the following to tell **timeout** vs **judge logic/CLI** issues.

## 1. Check attempt judge exit code

On the host where the task ran (e.g. where `out/<task_id>/` lives):

```bash
# Replace TASK_ID and attempt number (e.g. 001) with your run
cat out/<TASK_ID>/attempt_001/judge/rc.txt
```

- **124** → Judge was killed by `timeout` (not enough time).  
  - Fix: Increase `judge_timeout_seconds` in the task JSON (e.g. 600 → 900), or speed up the judge (simpler prompt, faster model).
- **0** → Judge process exited OK but verdict was invalid (e.g. `validate_verdict.py` failed or retries exhausted).  
  - Check: `out/<TASK_ID>/attempt_*/judge/verdict.json`, `extract_err.log`, and coordinator logs.
- **1** or other non-zero → Judge script failed (e.g. Cursor CLI error, JSON extract failed).  
  - Check: `out/<TASK_ID>/attempt_*/judge/cursor_stderr.log`, `extract_err.log`, and `call_judge_cursor.sh` logic.

## 2. Check judge logs for the last attempt

```bash
ls -la out/<TASK_ID>/attempt_003/judge/
cat out/<TASK_ID>/attempt_003/judge/rc.txt
cat out/<TASK_ID>/attempt_003/judge/cursor_stderr.log   # Cursor stderr
cat out/<TASK_ID>/attempt_003/judge/extract_err.log     # JSON extract errors if any
```

## 3. Coordinator behavior

- **PAUSED_JUDGE_TIMEOUT**: Coordinator only sets this when `judge_rc` is **124** (after retries). So if you see this state, it is a timeout; increase `judge_timeout_seconds` or optimize judge runtime.
- **PAUSED_JUDGE_INVALID**: Set when verdict is invalid or judge exits non-zero (including 124 if message says "invalid or timed out"). Check `judge/rc.txt` to distinguish timeout (124) from other failures.

## 4. Task JSON

- `judge_timeout_seconds`: Used by `run_task.sh` for the judge step (default 300). Example task `examples/task_optimize_openclaw_telegram_req.json` uses 600.
