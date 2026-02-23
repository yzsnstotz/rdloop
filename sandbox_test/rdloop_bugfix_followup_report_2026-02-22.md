# rdloop Bugfix Follow-up Report (Non-Telegram)

- Date: 2026-02-22
- Scope: Fix and retest per `/Users/Shared/ao001/rdloop_bugfix_dev_tasks.docx`
- Exclusion applied: Telegram-related items (`TC-P3-01`~`TC-P3-05`) were not tested/fixed per request.

## Code Fixes Completed

1. BUG-01 (selfcheck path / out-dir contract)
- `coordinator/run_task.sh` now honors `RDLOOP_OUT_DIR`.
- `examples/selfcheck_v1_1.sh` works with `RDLOOP_OUT_DIR=$OUT_ROOT` and `--continue` path contract.

2. BUG-02 (attempt directory B2-1 contract)
- `coordinator/run_task.sh` now pre-creates canonical files:
  - `coder/prompt.txt`, `coder/stdout.log`, `coder/stderr.log`, `coder/rc.txt`
  - `judge/prompt.txt`, `judge/stdout.log`, `judge/stderr.log`, `judge/rc.txt`
- `build_instruction()` writes canonical `coder/prompt.txt` and keeps legacy `instruction.txt` for compatibility.
- Removed non-contract attempt subdir `git/` (moved to root files: `diff.patch`, `diff.stat`, `head_commit.txt`).
- Added fallback filling for stdout/stderr from `run.log` when adapters don’t emit canonical logs.

3. BUG-03 (`/api/tasks` invalid `updated_at` rows)
- `gui/server.js` task list now excludes pseudo/internal dirs (`_...`) and enforces legal task-id pattern for list scan.
- Rows with missing/invalid `status.json` or invalid `updated_at` are skipped.
- `updated_at` normalization retained to second-level UTC Z.

4. BUG-04 (adapter pipe risk for rc)
- Removed response-parsing pipes in:
  - `coordinator/lib/call_coder_cursor.sh`
  - `coordinator/lib/call_coder_antigravity.sh`
  - `coordinator/lib/call_judge_cursor.sh`
  - `coordinator/lib/call_judge_antigravity.sh`
- Verified no `PIPESTATUS` and no literal command-pipe operators in `coordinator/lib/call_*.sh`.

5. Additional defects found and fixed during retest
- `run_task.sh` did not persist `judge/rc.txt` for timeout-killed judge process: fixed by writing fallback `rc.txt` from `judge_rc`.
- Consecutive timeout key mismatch across `--continue` caused second judge timeout not escalating to `FAILED`: fixed key mapping restore logic.
- Worktree fallback could exceed selfcheck timeout by copying full repo: improved `setup_worktree()`:
  - bounded `git worktree add` attempt
  - fast `git archive` fallback instead of full-tree copy.
- GUI live-log fallback priority mismatch (expected stdout/stderr first): fixed in `resolveLiveLogPath()`.
- GUI attempt diff path compatibility after removing `git/` dir: now reads `diff.stat` root path with legacy fallback.
- E2E tests were stale vs current API contract: updated `tests/e2e/etag-304.spec.js` and `tests/e2e/gui-e2e.spec.js` stubs to current API shape.

## Test Results (Post-fix)

### P0 / Core
- `TC-P2-09` selfcheck gate: PASS
  - Command: `bash examples/selfcheck_v1_1.sh --keep`
  - Result: `PASS: 31, FAIL: 0`
- `TC-P0-05` attempt dir contract: PASS
  - Verified canonical files exist and only top-level dirs are `coder`, `judge`, `test`.
- `TC-P0-04` pipe/rc risk scan: PASS
  - `PIPESTATUS` hits: none
  - literal `|` in adapter scripts: none

### P1 (non-Telegram)
- `TC-P1-01` ETag/304 + DOM behavior: PASS
  - Playwright: `tests/e2e/etag-304.spec.js` passed.
- `TC-P1-02` tab retention/live behavior: PASS
  - Playwright: `tests/e2e/gui-e2e.spec.js` passed.
- `TC-P1-03` live-log multi-path fallback: PASS
  - A stdout/stderr path: PASS
  - B run.log fallback: PASS
  - C legacy `cursor_stdout.log`: PASS
  - D all missing => fixed message: PASS
- `TC-P1-05` path traversal: PASS (`400/404` on invalid ids; valid id `200`)
- `TC-P1-06` judge timeout policy: PASS
  - first timeout: `PAUSED_JUDGE_TIMEOUT`, `judge/rc.txt=124`
  - second consecutive timeout after `--continue`: state `FAILED`
- `TC-P1-07` events half-line tolerance: PASS
  - appended truncated JSON line, API `/api/tasks/:id/events?tail=20` returned `200` with valid `events` payload.
- `TC-P1-08` updated_at format: PASS
  - bad_count = 0 for `/api/tasks` rows.
- `TC-P1-04` XSS protection: PASS
  - Playwright check with injected `<script>`/`onerror` payload confirmed `window._xss === undefined`.

### P2 (non-Telegram)
- `TC-P2-06` scoring mode gate: PASS
  - task with `scoring_mode=holistic_impression` now pauses with `PAUSED_JUDGE_MODE_INVALID`.
- `TC-P2-08` calibration gate: PASS (covered by selfcheck Step 4)

### Regression suites
- Unit tests: PASS
  - `node --test tests/unit/*.test.js` => 89 passed, 0 failed.
- Playwright E2E: PASS
  - `npm --prefix tests/e2e test -- etag-304.spec.js gui-e2e.spec.js` => 7 passed.

## Environment unblock status

- ENV-01 (Playwright unavailable): RESOLVED for this workspace.
  - installed `tests/e2e` deps and Chromium runtime.
  - Playwright suite now executable and passing.

## Files Changed

- `coordinator/run_task.sh`
- `coordinator/lib/call_coder_cursor.sh`
- `coordinator/lib/call_coder_antigravity.sh`
- `coordinator/lib/call_judge_cursor.sh`
- `coordinator/lib/call_judge_antigravity.sh`
- `gui/server.js`
- `tests/e2e/etag-304.spec.js`
- `tests/e2e/gui-e2e.spec.js`
