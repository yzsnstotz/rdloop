# ANCHOR-RULES: Privilege & Scoring Gates

Generated from:
- `docs/requirement/requirement 2nd.md` (v1.8.1)
- `docs/评分规则-Judge-Scoring-Rules.md`
- `~/.claude/CLAUDE.md`

---

## A) Privilege / User-Domain Boundaries (MUST / MUST NOT / ONLY IF)

1. **MUST** run as `yzliu` on `YZ-Mac-mini.local`. If `whoami` or `hostname` mismatch, STOP and report.
2. **MUST** use SSH config aliases (`local-ao000`, `local-ao001`, `local-ao002`) for cross-user execution. Pattern: `ssh local-ao00X 'zsh -lc "<cmd>"'`.
3. **MUST NOT** use `sudo` (`sudo -u`, `sudo -H -u`, `sudo -n -u`) for any ao-user operations.
4. **MUST NOT** commit or expose sensitive files (`.env`, `**/secrets*`, `**/*.pem`, `.claude/settings.local.json`, API keys).
5. **MUST** use atomic write for all critical JSON: `write temp -> flush -> fsync -> rename(os.replace)` (K1-3). Files: `status.json`, `final_summary.json`, `task.json`, `verdict.json`, `runtime_overrides.json`, `_index/tasks/<task_id>.json`.
6. **MUST** validate `task_id` as `[A-Za-z0-9_-]+` and `path.resolve` boundary check before any file read/write (C0-2).
7. **MUST NOT** use `innerHTML` to insert dynamic/user text in GUI; use `textContent` or `escapeHtml()` (C0-1).
8. **MUST NOT** allow Telegram write operations unless `RDLOOP_ENABLE_WRITES=true` AND token/allowlist auth passes (A5-0). Default: writes disabled.
9. **MUST** audit all GUI/Telegram write operations to `out/_audit/gui_actions.jsonl` (K7-3).
10. **MUST NOT** invoke LLM from OpenClaw/Telegram integration. `NO_LLM=true` enforced at startup; violations → `NO_LLM_VIOLATION` error + audit to `out/_audit/no_llm_violations.jsonl` (A4-1..A4-5).
11. **MUST** use `status.json` as Single Source for State. GUI/Telegram/Coordinator MUST NOT derive state from `verdict.json` or `events.jsonl` (Hard Constraint v1.8.0).
12. **MUST NOT** use pipe to capture rc in shell (B1-4). Use temp file or subshell: `cmd >out 2>err; rc=$?; echo "$rc" >rc.txt`.
13. **MUST** bind GUI control endpoints to localhost or require token; log actor+source in audit (C0-3, K7-3).
14. **MUST** use `YYYY-MM-DDTHH:mm:ssZ` (seconds-level UTC) for all `updated_at` fields. No milliseconds in writes (K1-5).
15. **ONLY IF** `ALLOW_PARTIAL_RUN=true`: PARTIAL adapters may be used for Run. Default: PARTIAL adapters blocked from Run/default selection (C1-1).
16. **MUST** limit Telegram notify rate: max 5/minute (configurable via `RDLOOP_NOTIFY_RATE_LIMIT`). Write rate: max 10/minute (A3-5, A5-0).

---

## B) Scoring / Acceptance Gates (MUST)

### B.1 Verdict Output Contract

1. **MUST** output `verdict.json` as strict JSON (no surrounding text). Fields: `decision`, `scores`, `weights`, `raw_score_0_5`, `penalty`, `final_score_0_5`, `final_score_0_100`, `gated`, `gating_reasons`, `top_issues`, `fix_suggestions`, `deliverability_index_0_100`, `improvement_potential_0_100`, `scoring_mode_used`, `rubric_version_used`, `rubric_hash_used`, `thresholds_used` (B4-2, K5-1).
2. **MUST** use `scoring_mode_used = rubric_analytic` for K8 Gate tasks. Non-analytic verdicts → `PAUSED_JUDGE_VERDICT_INVALID` or `PAUSED_JUDGE_MODE_INVALID` (B4-0).
3. **MUST** set Judge adapter `temperature=0` and log it in `run.log` (B4-7).
4. **MUST** enforce score range: `scores.*` in `{0, 0.5, 1, ..., 5}`; `penalty` in `[0, 2]` step 0.5; `top_issues` 2..5 items, each max 120 chars; `fix_suggestions` max 5 items, each max 160 chars (B4-7).

### B.2 Gating Rules

5. **MUST** gate (gated=true, FAIL) if any hard-gate dimension scores < threshold (default 2.0) (B4-1, Scoring Rules 0.2).
6. **MUST** apply penalty P (0..2) and compute `S = max(0, S_raw - P)`. Penalty triggers: secrets/forbidden globs → P=2+gated; missing required section → P=1..2; plagiarism/copyright → P=2+gated (Scoring Rules 0.2).
7. **MUST** map `S_100 = 20 * S` for percentage score (Scoring Rules 0.2).

### B.3 Consistency Rules (rubric_analytic only, K5-3)

8. **MUST** reject anti-flat violation: if dimensions >= 6, all scores identical (e.g., all 4.5) → `PAUSED_JUDGE_VERDICT_INCONSISTENT`. Require >= 2 distinct values or stddev >= 0.15.
9. **MUST** enforce reason-score alignment per K5-3 keyword table: e.g., top_issue contains "缺失/未覆盖验收" → `acceptance_testability` max 4.0.
10. **MUST** require top_issues count in [2, 5]; 0 issues with non-perfect score → inconsistent.

### B.4 Decision → State Mapping (K2-6)

11. **MUST** implement `decideNextState(ctx)` as single entry point (`coordinator/lib/decision_table.ts`). GUI/Telegram MUST NOT replicate decision logic.
12. **MUST** follow K2-6-test-table mapping:
    - `judge rc=124 TIMEOUT` → PAUSED / PAUSED_JUDGE_TIMEOUT / consume=false
    - `coder rc=124 TIMEOUT` → PAUSED / PAUSED_CODER_TIMEOUT / consume=false
    - `coder rc=195 AUTH` → PAUSED / PAUSED_CODER_AUTH_195 / consume=false
    - `test rc=124 TIMEOUT` → PAUSED / PAUSED_TEST_TIMEOUT / consume=true
    - `judge FAIL gated=true` → PAUSED / PAUSED_SCORE_GATED / consume=true
    - `judge FAIL gated=false thresholds=false` → PAUSED / PAUSED_SCORE_BELOW_THRESHOLD / consume=true
    - `judge NEED_USER_INPUT` → PAUSED / PAUSED_WAITING_USER_INPUT / consume=false
    - `judge PASS thresholds=true` → READY_FOR_REVIEW
    - `coordinator CRASH` → PAUSED / PAUSED_CRASH
    - `judge VERDICT_INVALID` → PAUSED / PAUSED_JUDGE_VERDICT_INVALID
    - `judge VERDICT_INCONSISTENT` → PAUSED / PAUSED_JUDGE_VERDICT_INCONSISTENT
13. **MUST** track consecutive same-type timeouts: consecutive >= 2 → FAILED (F1-4). "Consecutive" = adjacent attempts + same reason_key.

### B.5 Evidence & Artifacts (MUST persist)

14. **MUST** persist attempt directory structure per B2-1: `out/<task_id>/attempt_<n>/{coder,judge,test}/` with `rc.txt`, `run.log`, `stdout.log`, `verdict.json`.
15. **MUST** write `status.json` with all K1-1a fields: `task_id`, `state`, `state_version`, `updated_at`, `current_attempt`, `effective_max_attempts`, `last_decision`, `pause_reason_code`, `message`, `questions_for_user`, `paths`, `rubric_version_used`, `last_user_input_ts_consumed`. Plus `last_transition` when PAUSED/FAILED.
16. **MUST** write `final_summary.json` with K1-1b fields including `state_version`, `final_score_0_100`, `verdict_summary`, `paths`.
17. **MUST** write `_index/tasks/<task_id>.json` after every `write_status()` (A1-6).
18. **MUST** write `events.jsonl` with K3-1 minimum event set per attempt. Flush after each append (K3-6). Read-side: drop last unparseable line (half-line tolerance).
19. **MUST** use `state` enum: `RUNNING | PAUSED | READY_FOR_REVIEW | FAILED`. Read-compat: map `READY` → `READY_FOR_REVIEW` (K1-1a-state).

### B.6 Regression & Gate Scripts

20. **MUST** pass `coordinator/self_check.sh` (all checks) before merge.
21. **MUST** pass `regression/run_regression.sh` (all cases) before merge.
22. **MUST** pass `node --test tests/unit/decision_table.test.js` (all K2-6 vectors) before merge.
23. **MUST** run K8-1 selfcheck (`examples/selfcheck_v1_1.sh`) with pipeline-structure gate task (K8-3) for merge gate.
24. Script paths:
    - `coordinator/run_task.sh` — main coordinator
    - `coordinator/self_check.sh` — structural self-check
    - `regression/run_regression.sh` — regression suite
    - `coordinator/lib/decision_table.ts` → compiled `decision_table.js` — decision state machine
    - `coordinator/lib/atomic_write.py` — atomic JSON writer
    - `tests/unit/decision_table.test.js` — K2-6 unit tests

### B.7 Task-Type Scoring Dimensions

25. **MUST** select rubric by `task_type`. Canonical enum values: `requirements_doc`, `engineering_impl`, `douyin_script`, `storyboard`, `paid_mini_drama`. Alias `engineering_implementation` → read-compat only, normalize to `engineering_impl` on write (B3-3a).
26. **MUST** persist rubric in `schemas/judge_rubric.json` with `rubric_version`, `rubric_hash` (sha256 canonical JSON), `task_types` with dimensions/weights/hard_gates/penalty_rules (B4-3a).

---

## Missing / Unclear Gates

Items the requirement documents leave ambiguous or may need future clarification:

1. **K8 calibration case content**: Only directory structure and expected format are defined; no actual calibration input documents ship yet. K8-6 degrades to WARN if missing.
2. **`validate_verdict.py` implementation**: Referenced in K5-1b but no implementation exists yet. Needed for B4 enforcement.
3. **`selfcheck_v1_1.sh` (K8-1)**: Not yet implemented. Required for merge-gate automation.
4. **GUI `escapeHtml` audit**: C0-1 requires all innerHTML insertion points to use escapeHtml, but no automated check/linter rule exists.
5. **Telegram `request_id` dedup storage**: A5-4 requires idempotency via `request_id` in `user_input.jsonl`, but dedup lookup mechanism (in-memory vs file scan) is unspecified.
6. **`runtime_overrides.json` rollback endpoint**: A5-0 defines rollback API/script, but no implementation or test exists yet.
7. **Crash trap verification**: F3-2 requires COORDINATOR_CRASHED event + PAUSED_CRASH on signal, but automated test is difficult on macOS (mock timeout adapters can help).
8. **Playwright E2E for etag/304**: K4-1 marks `tests/e2e/etag-304.spec.js` as P1 mandatory, but no Playwright setup exists yet.
9. **`stale lock` 30-min timeout**: F3-3 mentions stale lock detection but threshold and trigger mechanism are implementation-defined.
10. **Penalty `force_gated` behavior**: B4-3a shows `force_gated: true` in penalty_rules but no explicit coordinator handling is defined for penalty-triggered gating vs dimension-triggered gating.
