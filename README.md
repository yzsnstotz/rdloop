# rdloop — Research & Development Loop Engine

Automated code review loop: **Coder (AI) → Test → Judge (AI) → Auto-retry (up to N times)**



## 30-Second Quick Verification


```bash

# kill & start
./restart-gui.sh

cd ~/work/projects/rdloop

# 1. Basic loop
bash examples/run_hello.sh
# RC=0, decision=READY_FOR_REVIEW

# 2. Self-check (§19 four critical checks)
bash coordinator/self_check.sh
# RC=0

# 3. Regression suite
bash regression/run_regression.sh
# RC=0
```

All three returning RC=0 means the system is working correctly.

## Directory Structure

```
rdloop/
├── coordinator/
│   ├── run_task.sh          # Core coordinator (main entry)
│   ├── self_check.sh        # §19 four critical checks
│   └── lib/
│       ├── validate_verdict.py    # Judge output validator
│       ├── call_coder_mock.sh     # Mock coder adapter
│       ├── call_coder_cursor.sh   # Cursor CLI coder adapter
│       ├── call_judge_mock.sh     # Mock judge adapter
│       └── call_judge_codex.sh    # Codex CLI judge adapter
├── schemas/
│   ├── task_spec.json        # TaskSpec schema reference
│   ├── evidence_bundle.json  # EvidenceBundle schema reference
│   └── judge_verdict.json    # JudgeVerdict schema reference
├── prompts/
│   ├── judge.prompt.md       # Judge system prompt
│   └── coder.prompt.md       # Coder system prompt
├── examples/
│   ├── dummy_repo/           # Test git repository
│   ├── task_hello.json       # Basic hello world task
│   └── run_hello.sh          # One-click hello world runner
├── regression/
│   ├── run_regression.sh     # Regression suite runner
│   └── cases/                # Test case definitions
├── gui/
│   ├── server.js             # Express server (port 17333)
│   ├── public/               # Frontend (HTML/CSS/JS)
│   └── package.json
├── out/                      # Runtime output (gitignored)
│   ├── _default/             # Tasks with no task_type
│   ├── requirements_doc/     # task_type=requirements_doc
│   │   └── test/             # Test runs for requirements_doc
│   └── engineering_impl/     # task_type=engineering_impl
└── worktrees/                # Git worktrees (gitignored)
```

**Output layout by task type:** Run results are stored under `out/<task_id>/`. To classify by task type, use a `task_id` that includes the type and optional subfolder, e.g. `requirements_doc/test/run_001`. Ensure the directory structure exists with:

```bash
bash coordinator/ensure_out_structure.sh
```

## Running Examples

```bash
# Run the basic hello world loop
bash examples/run_hello.sh

# Check output
find out -maxdepth 4 -type f | sort
cat out/hello_world/final_summary.json
```

## Running Regression Suite

```bash
bash regression/run_regression.sh
```

Covers: basic PASS, auto-advance FAIL, task_id conflict, forbidden_globs, self_check integration.

## GUI

```bash
cd gui && npm install && npm start
# Open http://localhost:17333
```

Features: task list, attempt details, timeline, Pause/Resume/RunNext controls, instruction editing.

## Cursor / Judge execution (cliapi)

Cursor (coder/judge) and other adapters use **cliapi** (API key; no queue or worker):

- **cursor-agent**: cursorcliapi at `http://127.0.0.1:8000/v1`, API key `openclawaousers`.
- **codex-cli / claude-cli / antigravity-cli**: CLIProxyAPI at `http://127.0.0.1:8317/v1`. Ensure gateway is running; rdloop calls `/chat/completions`.

## Maintenance Commands

```bash
# Reset a task (clean worktrees, write PAUSED)
bash coordinator/run_task.sh --reset <task_id>

# Rerun from a specific attempt
bash coordinator/run_task.sh --rerun-attempt <task_id> <attempt_number>

# Continue a paused/failed task
bash coordinator/run_task.sh --continue <task_id>

# Self-improve (meta-task)
bash coordinator/run_task.sh --self-improve <idea.md>
```

## §19 Critical Check Items

These four checks are validated by `coordinator/self_check.sh`:

1. **PAUSED Alignment**: `status.json` and `final_summary.json` must both be written with consistent data when entering PAUSED state. `questions_for_user` must be non-empty. `pause_reason_code` must be in the valid enum.

2. **Lock Failure → Status Exists**: Even when lock acquisition fails (task already running), `status.json` must exist with all required fields.

3. **Auto-Advance vs GUI Run Next**: FAIL + attempt < max_attempts → Coordinator auto-advances. GUI Run Next is only for PAUSED recovery or instruction edits.

4. **Trap Cleanup**: On crash/kill, trap must clean lockdir and write PAUSED_CRASH status. Normal exit must NOT write PAUSED_CRASH.

## Pause Reason Codes

| Code | Category | Description |
|------|----------|-------------|
| PAUSED_CODEX_MISSING | PAUSED_INFRA | Codex CLI not in PATH |
| PAUSED_CRASH | PAUSED_INFRA | Process crashed or killed |
| PAUSED_NOT_GIT_REPO | PAUSED_INFRA | repo_path not a git repo |
| PAUSED_TASK_ID_CONFLICT | PAUSED_INFRA | Duplicate task_id |
| PAUSED_CODER_FAILED | PAUSED_INFRA | Coder step did not complete (rc≠0); test and judge skipped |
| PAUSED_CODER_NO_OUTPUT | PAUSED_INFRA | Coder run.log too small; judge skipped (avoids judge on empty evidence) |
| PAUSED_JUDGE_INVALID | PAUSED_JUDGE | Judge output invalid after retries |
| PAUSED_JUDGE_TIMEOUT | PAUSED_JUDGE | Judge timed out after retries |
| PAUSED_ALLOWED_PATHS | PAUSED_POLICY | File outside allowed paths |
| PAUSED_FORBIDDEN_GLOBS | PAUSED_POLICY | File matches forbidden glob |
| PAUSED_USER | PAUSED_MANUAL | User requested pause |
| PAUSED_WAITING_USER_INPUT | PAUSED_MANUAL | Judge returned NEED_USER_INPUT (no auto-advance) |

**Judge verdict and flow**: When the judge returns **FAIL** and attempts remain, the coordinator (via `decision_table`) sets `next_state: RUNNING` and `consume_attempt: true`, then continues to the next attempt without pausing. When the judge returns **NEED_USER_INPUT**, the task is **PAUSED** (e.g. `PAUSED_WAITING_USER_INPUT`); use GUI Resume or Run Next after providing input. So “pause” is not caused by FAIL — it is caused by user pause, infra issues, or judge asking for user input.

## Task Lifecycle

```
NEW → RUNNING → [attempt loop] → READY_FOR_REVIEW (PASS)
                               → FAILED (max attempts)
                               → PAUSED (intervention needed)
```

## macOS Compatibility

- Uses Bash 3.2 compatible constructs only
- mkdir-based atomic locking (no flock)
- No associative arrays, globstar, readarray/mapfile
- Uses `while IFS= read -r` for line processing
