# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

rdloop is an automated code review loop engine: **Coder (AI) → Test → Judge (AI) → Auto-retry (up to N attempts)**. The coordinator (`coordinator/run_task.sh`) orchestrates the full lifecycle. Adapters in `coordinator/lib/` are pluggable — `mock` for testing, `cursor` for real Cursor CLI coder, `codex` for real Codex CLI judge.

## Common Commands

```bash
# Quick verification (all three should return RC=0)
bash examples/run_hello.sh
bash coordinator/self_check.sh
bash regression/run_regression.sh

# Run a task
bash coordinator/run_task.sh <task_spec.json>
bash coordinator/run_task.sh --continue <task_id>
bash coordinator/run_task.sh --reset <task_id>
bash coordinator/run_task.sh --rerun-attempt <task_id> <attempt_number>
bash coordinator/run_task.sh --self-improve <idea.md>

# GUI (Express on port 17333)
cd gui && npm install && npm start
```

## Architecture

- **coordinator/run_task.sh**: Single-file Bash coordinator (~990 lines). Handles task lifecycle (NEW → RUNNING → READY_FOR_REVIEW/FAILED/PAUSED), locking (mkdir-based atomic locks, no flock), worktree management, security guardrails (allowed_paths, forbidden_globs), and crash recovery via trap.
- **coordinator/lib/call_coder_*.sh**: Coder adapters. Interface: `$1=task_json $2=attempt_dir $3=worktree_dir $4=instruction_path`. Outputs: `attempt_dir/coder/run.log` and `attempt_dir/coder/rc.txt`.
- **coordinator/lib/call_judge_*.sh**: Judge adapters. Interface: `$1=task_json $2=evidence_json $3=attempt_dir $4=judge_prompt`. Outputs: `attempt_dir/judge/verdict.json` (must conform to JudgeVerdict schema).
- **coordinator/lib/validate_verdict.py**: Validates judge output against JudgeVerdict schema.
- **schemas/**: JSON schema references for TaskSpec, EvidenceBundle, JudgeVerdict.
- **prompts/**: System prompts for judge and coder agents.
- **gui/**: Express.js server + vanilla HTML/CSS/JS frontend. REST API reads from `out/` directory and writes `control.json` for Pause/Resume/RunNext/EditInstruction.
- **out/**: Runtime output per task (gitignored). Each task gets `status.json`, `final_summary.json`, `events.jsonl`, and per-attempt directories.
- **worktrees/**: Git worktrees per task/attempt (gitignored).

## Key Design Constraints

- **Bash 3.2 compatibility** (macOS default): no associative arrays, no globstar, no readarray/mapfile, no `flock`. Use `while IFS= read -r` for line processing and `mkdir`-based atomic locking.
- All JSON manipulation goes through `python3 -c` inline scripts (the `json_read` helper and `write_*` functions).
- The `§19` reference denotes the four critical invariants validated by `self_check.sh`: PAUSED alignment, lock failure status existence, auto-advance correctness, and trap cleanup.

## Task Lifecycle & State Machine

```
NEW → RUNNING → [attempt loop] → READY_FOR_REVIEW (PASS)
                               → FAILED (max attempts exhausted)
                               → PAUSED (intervention needed, with pause_reason_code)
```

FAIL + attempt < max_attempts → coordinator auto-advances without GUI. GUI "Run Next" is only for PAUSED recovery.

## Adding New Adapters

Create `coordinator/lib/call_coder_<name>.sh` or `coordinator/lib/call_judge_<name>.sh` following the existing interface contracts. Set `"coder": "<name>"` or `"judge": "<name>"` in the task JSON.
