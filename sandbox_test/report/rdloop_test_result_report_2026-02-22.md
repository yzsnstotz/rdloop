# rdloop Sandbox Test Result Report

- Date: 2026-02-22 (local)
- Workspace: `/Users/yzliu/work/projects/rdloop`
- Requirement source: `/Users/Shared/ao001/rdloop/test/rdloop_sandbox_test_tasklist.md`
- Notes:
  - The checklist asks for full sandbox isolation via `SANDBOX_ROOT`; however, `coordinator/run_task.sh` currently writes to hardcoded `out/` in this repo.
  - GUI E2E Playwright tests are blocked in this environment (`playwright` binary missing).

## Environment and Evidence

- Selfcheck log: `sandbox_test/selfcheck.log`
- Direct gate task run log: `sandbox_test/sandbox_gate_20260222_150902.run.log`
- Selfcheck gate output dir: `out/_selfcheck_v1_1/structure_gate_20260222_150846_83353/`
- Direct gate output dir: `out/sandbox_gate_20260222_150902/`
- GUI API checks log (raw): `sandbox_test/gui_api_checks.log`
- GUI API checks log (corrected payloads): `sandbox_test/gui_api_checks_corrected.log`
- GUI server logs: `sandbox_test/gui_server_test*.log`, `sandbox_test/gui_server_ro*.log`

## Executed Commands (major)

- `bash examples/selfcheck_v1_1.sh --keep`
- `bash coordinator/run_task.sh sandbox_test/sandbox_gate_20260222_150902.json`
- `node --test tests/unit/*.test.js`
- Multiple `curl` checks against GUI API on `http://localhost:17333`
- `python3 coordinator/lib/validate_verdict.py out/sandbox_gate_20260222_150902/attempt_001/judge/verdict.json`

## Result Summary by Test Case

| Test ID | Status | Evidence / Notes |
|---|---|---|
| TC-P0-01 | PASS | `out/sandbox_gate_20260222_150902/status.json` has required fields and types; `updated_at` format matches `YYYY-MM-DDTHH:mm:ssZ`. |
| TC-P0-02 | PASS | `status.state=READY_FOR_REVIEW` (valid enum). |
| TC-P0-03 | PARTIAL_PASS | Static code confirms atomic write (`coordinator/lib/atomic_write.py`: temp->flush->fsync->`os.replace`). Concurrent API writes kept JSON parseable for `runtime_overrides.json`; no 100x concurrent read/write stress done for all 4 files. |
| TC-P0-04 | PARTIAL_FAIL | No `PIPESTATUS` usage found, but shell pipe operators (`|`) exist in adapter scripts (response parsing). Full macOS bash3 rc triad harness from checklist not present/executed. |
| TC-P0-05 | FAIL | Produced attempt layout differs from required B2-1 contract (`instruction.txt`/`run.log` etc., missing required `prompt.txt`, `stdout.log`, `stderr.log` under coder). Evidence: `out/sandbox_gate_20260222_150902/attempt_001/`. |
| TC-P0-06 | PASS | `schemas/judge_rubric.json` exists and passes required top-level/dimension/weight sum checks. |
| TC-P0-07 | PASS | `out/sandbox_gate_20260222_150902/final_summary.json` has required fields and UTC-second `updated_at`. |
| TC-P1-01 | PARTIAL_PASS | API ETag/304 works on log endpoint: first `200`, second `304` with `If-None-Match` for `/api/task/:id/log/coder.log`. Playwright DOM non-update assertion not run (blocked). |
| TC-P1-02 | BLOCKED | Playwright unavailable (`playwright: command not found`). |
| TC-P1-03 | NOT_RUN | Multi-path fallback scenarios (stdout/run.log/legacy names/all missing) not fully simulated end-to-end. |
| TC-P1-04 | BLOCKED | GUI XSS Playwright verification not run (no Playwright runtime). |
| TC-P1-05 | PASS | Illegal task IDs returned `400/404`; valid task ID returned `200`. |
| TC-P1-06 | NOT_RUN | Judge timeout policy scenario (rc=124, retry logic, 2nd timeout->FAILED) not executed. |
| TC-P1-07 | NOT_RUN | events half-line tolerance API scenario not executed. |
| TC-P1-08 | FAIL | `/api/tasks` includes pseudo entries with empty `updated_at` (e.g. `_audit`, `_index`), violating strict format for all returned rows. |
| TC-P1-09 | PASS | Decision table vectors pass in both selfcheck Step 5 and `tests/unit/decision_table.test.js`. |
| TC-P2-01 | PASS | Duplicate `request_id` on runtime_overrides deduplicated (`deduplicated:true`), audit includes `"dedup":true`. |
| TC-P2-02 | PASS | 20 concurrent runtime_overrides writes; final `runtime_overrides.json` parse OK. |
| TC-P2-03 | PASS | Read-only task dir produced `WRITE_FAILED` (HTTP 500); `status.effective_max_attempts` unchanged. |
| TC-P2-04 | PASS | 10 concurrent user_input appends; all JSONL lines parse, no broken lines. |
| TC-P2-05 | PASS | `validate_verdict.py` on produced verdict exits `0`. |
| TC-P2-06 | NOT_RUN | Invalid scoring mode (`holistic_impression`) injection test not executed. |
| TC-P2-07 | PASS | K5-3 consistency checks covered by `tests/unit/validate_verdict.test.js` (`exit 2` on anti-flat/keyword mismatches, pass on varied scores). |
| TC-P2-08 | PASS | Selfcheck K8-6 calibration step passed (real judge range check + synthetic validation). |
| TC-P2-09 | FAIL | `examples/selfcheck_v1_1.sh` overall failed because Step 2 writes task under `out/_selfcheck_v1_1/...` but coordinator `--continue` looks at `out/<task_id>/task.json`; subsequent K8-4 artifact checks fail. |
| TC-P3-01 | PARTIAL_PASS | No-LLM policy statically present in OpenClaw (`openclaw/config.js`, `openclaw/no_llm.js`). Telegram `/rdloop` pagination/sort behavior not executed in live bot. |
| TC-P3-02 | NOT_RUN | Telegram state card rendering not executed. |
| TC-P3-03 | NOT_RUN | Telegram notification trigger/dedup/ratelimit scenarios not executed. |
| TC-P3-04 | NOT_RUN | Telegram error-template behavior not executed end-to-end. |
| TC-P3-05 | NOT_RUN | Telegram events-via-API proxy check could not be validated (no `telegram_bot/` module in this repo layout). |
| TC-P3-06 | PASS | TaskSpec CRUD API succeeds with correct payload shape (`spec` object); copy/update/delete-to-trash verified. |
| TC-P3-07 | PASS | Prompt write in whitelist path works (`system_prompt.md` -> 200); traversal-like name rejected (`400`). |
| TC-P3-08 | PASS | With clean `READ_ONLY=true` server instance, write endpoints return `403`. |
| TC-DOC-01 | PASS | Required docs/files exist and troubleshooting doc contains `rc=124`, timeout, `verdict.json`, extract error references. |

## Additional Automated Suite Result

- Unit tests: `node --test tests/unit/*.test.js`
  - Result: PASS
  - Stats: 89 tests passed, 0 failed.

## Key Defects Found

1. `examples/selfcheck_v1_1.sh` K8-1 execution path issue (task location mismatch vs coordinator `--continue`).
2. Attempt directory contract mismatch vs B2-1 required canonical files.
3. `/api/tasks` includes rows with invalid/empty `updated_at` for pseudo directories.
4. GUI E2E validations requiring Playwright currently not executable in this environment.

