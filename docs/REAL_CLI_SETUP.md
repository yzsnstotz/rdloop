# Real CLI Integration Guide

This guide explains how to wire **real** Coder (Cursor CLI) and Judge (Codex CLI) into rdloop and run real tasks.

## 1. Task JSON: Switch to Real Adapters

In your task spec JSON, set:

```json
{
  "coder": "cursor",
  "judge": "codex",
  "cursor_cmd": "coder",
  "codex_cmd": "judger"
}
```

- **`coder`**: `"mock"` (default) | **`"cursor"`** — use `"cursor"` for real Coder CLI.
- **`judge`**: `"mock"` (default) | **`"codex"`** — use `"codex"` for real Judge CLI.
- **`cursor_cmd`**: executable name for Coder (default **`"coder"`**). Override if your CLI has another name or path.
- **`codex_cmd`**: executable name for Judge (default **`"judger"`**). Override if your Judge CLI has another name.

Use **absolute path** for `repo_path` and real `test_cmd`, `goal`, and `acceptance` for production tasks.

Example (minimal real task):

```json
{
  "schema_version": "v1",
  "task_id": "my_real_task",
  "repo_path": "/Users/you/path/to/your/repo",
  "base_ref": "main",
  "goal": "Implement feature X with backward compatibility.",
  "acceptance": "All unit tests pass and integration test suite passes.",
  "test_cmd": "npm test",
  "max_attempts": 3,
  "coder": "cursor",
  "judge": "codex",
  "cursor_cmd": "coder",
  "codex_cmd": "judger",
  "constraints": [],
  "created_at": "",
  "target_type": "external_repo",
  "allowed_paths": [],
  "forbidden_globs": ["**/.env", "**/secrets*", "**/*.pem"],
  "coder_timeout_seconds": 600,
  "judge_timeout_seconds": 300,
  "test_timeout_seconds": 300
}
```

---

## 2. Coder Side: Cursor CLI

### What the coordinator does

- Builds an **instruction file** per attempt (context + goal + acceptance; see `build_instruction()` in `coordinator/run_task.sh`).
- Runs in the **worktree directory**: `cd "$worktree_dir"` then `echo "$instruction" | "$cursor_cmd"`.
- Expects **exit code 0** for success; non-zero is treated as coder failure.
- Logs go to `attempt_dir/coder/run.log`, return code to `attempt_dir/coder/rc.txt`.

### What you need

1. **Install Coder CLI**  
   The adapter invokes the **`coder`** command by default. If your Cursor CLI is installed as `cursor`, set in task JSON: `"cursor_cmd": "cursor"`. If you install or alias it as `coder`, no override is needed. Ensure the chosen command is in PATH when you run `run_task.sh`.

2. **CLI contract**  
   - The adapter feeds **instruction text on stdin** and runs in the **worktree repo** as current directory.  
   - Your coder CLI should:
     - Read the instruction from stdin (or first argument, if you wrap it).
     - Apply changes in the current directory (the worktree).
     - Exit 0 on success, non-zero on failure.

3. **Optional override**  
   Default is `cursor_cmd: "coder"`. If your executable has another name or path, set in task JSON:
   - `"cursor_cmd": "cursor"` or `"cursor_cmd": "/full/path/to/your/coder"`.

### Verifying

```bash
command -v coder && echo "coder in PATH"
# Or if you use cursor: command -v cursor && echo "cursor in PATH"
cd /path/to/any/repo && echo "List files in this repo" | coder
# Expect exit code 0 and visible changes/log if your CLI supports stdin.
```

---

## 3. Judge Side: Codex CLI

### What the coordinator does

- Builds **stdin** for the judge as: **judge system prompt** (from `prompts/judge.prompt.md`) + `---` + **evidence JSON** (one-line `evidence.json` content).
- Runs: `echo "$judge_stdin" | "$codex_cmd"` and captures **stdout** as the judge output.
- Expects **stdout** to be (or to contain) a single **JudgeVerdict** JSON object.
- Writes parsed result to `attempt_dir/judge/verdict.json`. Exit code **127** is treated as “Codex CLI missing”; other non-zero as judge failure (with retries).

### JudgeVerdict schema

Output must conform to `schemas/judge_verdict.json`:

```json
{
  "schema_version": "v1",
  "decision": "PASS" | "FAIL" | "NEED_USER_INPUT",
  "reasons": ["reason1", "reason2"],
  "next_instructions": "string (required for FAIL; actionable instructions for coder)",
  "questions_for_user": ["question1"]
}
```

- **PASS**: tests and acceptance met; `next_instructions` usually empty.
- **FAIL**: tests or acceptance not met; `next_instructions` must be actionable for the next coder attempt.
- **NEED_USER_INPUT**: unclear; `questions_for_user` must be non-empty.

### What you need

1. **A `judger` (or custom) CLI** that:
   - Reads from **stdin** the full prompt (judge prompt + `---` + evidence JSON).
   - Calls your LLM / Judge backend.
   - Prints **exactly one** JudgeVerdict JSON to **stdout** (no extra markdown or commentary, or the adapter will try to extract JSON from the last `{...}` block; see `call_judge_codex.sh`).

2. **Install or implement**  
   - Default executable name is **`judger`**. If you already have a CLI that does the above, install it as `judger` on `PATH`, or set `codex_cmd` in task JSON to the executable name/path.  
   - If not, implement a small wrapper (e.g. script or binary) that:
     - Reads stdin.
     - Sends content to your Judge API/LLM.
     - Parses the model output into JudgeVerdict and prints it to stdout; exit 0 on success.

3. **Optional override**  
   Default is `codex_cmd: "judger"`. To use another name or path:  
   - `"codex_cmd": "/full/path/to/your/judger"` or any name on `PATH`.

### Verifying

```bash
command -v judger && echo "judger in PATH"
# Or with a test evidence file:
echo "Judge prompt here
---
{\"task_id\":\"t1\",\"attempt\":1,\"test\":{\"rc\":0}}" | judger
# Expect a single JSON object on stdout with decision, reasons, next_instructions, questions_for_user.
```

---

## 4. Run a Real Task

1. **Create a task JSON** (as in section 1) with `"coder": "cursor"`, `"judge": "codex"`, real `repo_path`, `test_cmd`, `goal`, `acceptance`.

2. **Run the coordinator**:
   ```bash
   cd /Users/yzliu/work/projects/rdloop
   bash coordinator/run_task.sh /path/to/your_task.json
   ```

3. **Monitor**:
   - Logs and artifacts under `out/<task_id>/`.
   - GUI: `cd gui && npm start` then open http://localhost:17333 for task list, attempt details, and Pause/Resume/Run Next.

4. **If Coder or Judger CLI is missing**  
   The coordinator will pause with `PAUSED_CURSOR_MISSING` or `PAUSED_CODEX_MISSING` and write a message in `status.json` / GUI. Fix `PATH` or set `cursor_cmd` / `codex_cmd` in task JSON, then use **Run Next** in the GUI or `--continue <task_id>` to resume.

---

## 5. Summary

| Item            | Coder (Cursor)              | Judge (Codex)                    |
|----------------|-----------------------------|----------------------------------|
| Task field     | `"coder": "cursor"`         | `"judge": "codex"`               |
| CLI name       | `cursor_cmd` (default **`coder`**) | `codex_cmd` (default **`judger`**) |
| Input          | Instruction on stdin        | Judge prompt + `---` + evidence JSON on stdin |
| Output         | Exit code 0 = success       | One JudgeVerdict JSON on stdout |
| Adapter script | `coordinator/lib/call_coder_cursor.sh` | `coordinator/lib/call_judge_codex.sh` |

After both CLIs are installed (as `coder` and `judger` or overridden in task JSON) and wired in the task JSON, run `run_task.sh` with your task file to execute the full loop with real Coder and Judge.
