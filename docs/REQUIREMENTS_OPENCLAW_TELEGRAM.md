# Requirements: OpenClaw + rdloop Telegram Integration

**Version**: 1.0  
**Status**: Draft  
**Scope**: Formal integration of OpenClaw with rdloop Coordinator for Telegram-based status and notifications. All behavior must be **programmatic**; **no LLM** may be invoked.

---

## 1. Context and Goals

### 1.1 Baseline

- **rdloop**: Current project (Coordinator, GUI, `out/` output layout, task lifecycle).
- **OpenClaw**: Deployed on **ao001@100.114.240.117**, installation path **~/.openclaw**.
- **Objective**: Enable OpenClaw to **connect to rdloop Coordinator** and **obtain current work information**, so that Telegram can be used to list projects, show status, drill down, and receive proactive notifications.

### 1.2 Non-Goals / Constraints

- **No LLM usage**: All behaviors described below MUST be implemented by deterministic, programmatic logic. Under **no** circumstance (including errors, timeouts, or missing data) shall OpenClaw’s LLM be triggered for this integration.
- Implementation may use: config files, HTTP APIs, file reads, shell commands, Telegram Bot API, and fixed-format messages only.

---

## 2. Data Source: Coordinator “Current Work Info”

OpenClaw must be able to obtain “current and recent” rdloop work. The Coordinator’s view of work is represented under rdloop’s **`out/`** directory (and optionally the existing GUI API):

- **Per task** (one directory per `task_id` under `out/`):
  - **`out/<task_id>/status.json`**: `task_id`, `state`, `current_attempt`, `max_attempts`, `last_decision`, `message`, `questions_for_user`, `pause_reason_code`, `updated_at`, etc.
  - **`out/<task_id>/final_summary.json`**: terminal or summary view — `decision`, `last_decision`, `current_attempt`, `max_attempts`, `message`, `pause_reason_code`, `final_head_commit`, `updated_at`.
  - **`out/<task_id>/task.json`**: original task spec (e.g. `goal`, `acceptance`, `repo_path`).
  - **`out/<task_id>/events.jsonl`**: timeline of events (CODER_STARTED, TEST_FINISHED, JUDGE_STARTED, etc.).
  - **`out/<task_id>/attempt_*/`**: per-attempt details (test result, judge verdict, diff stats, etc.).

**States** (from Coordinator): `RUNNING`, `PAUSED`, `READY_FOR_REVIEW`, `FAILED`.  
**Decisions** (from Judge / summary): e.g. `PASS`, `FAIL`, `NEED_USER_INPUT`; terminal outcomes include `READY_FOR_REVIEW`, `FAILED`, `PAUSED`.

Integration must define **how** OpenClaw gets this data (e.g. read `out/` on the same host, or call rdloop GUI API if Coordinator/out is exposed over HTTP). That part is left to the design phase; this document only requires that OpenClaw can obtain the above information programmatically.

---

## 3. Functional Requirements

### 3.1 FR1: /rdloop Command — List and Basic Status in Telegram

**Trigger**: User sends **/rdloop** in a Telegram dialog (where the bot is available).

**Behavior**:

1. **List**: Show a **list of current and recent rdloop projects** (tasks). “Current and recent” means: tasks that have a directory under `out/` (or equivalent from the chosen data source), optionally filtered/sorted by e.g. `updated_at` or `state` so that active and recently updated tasks appear first. The list MUST be presented as a **Telegram menu** (e.g. inline keyboard or reply keyboard) so the user can choose an item by clicking.
2. **Basic status**: When the user **clicks** a project in that menu, the bot MUST reply in the **same Telegram dialog** with that project’s **basic status**, so the user can quickly understand:
   - Current state and execution situation (e.g. RUNNING, PAUSED, READY_FOR_REVIEW, FAILED).
   - At least: `task_id`, `state`, `current_attempt` / `max_attempts`, `last_decision`, short `message`, and optionally `updated_at` or `pause_reason_code` when relevant.
3. **Drill-down**: From that status view, the user MUST be able to **go deeper** (e.g. further menu or “More” action) to see more detailed information derived from the same programmatic data (e.g. latest events, last attempt summary, `questions_for_user` when PAUSED). No LLM; all text is built from structured fields (e.g. from `status.json`, `final_summary.json`, `events.jsonl`).

All of the above MUST be implemented with **programmatic logic only** (read JSON, format strings, build menus). No LLM calls.

### 3.2 FR2: Proactive Notifications on Completion / Abort / User Intervention

**Trigger**: When rdloop reaches a **terminal or intervention-required** situation, the system MUST **proactively notify** the user.

**Notify when** (programmatic detection only):

- **Completion**: Task reaches **READY_FOR_REVIEW** (e.g. Judge PASS, all checks passed).
- **Abort / failure**: Task reaches **FAILED** (e.g. max attempts reached) or **PAUSED** with an abort-like reason (e.g. PAUSED_CRASH, PAUSED_JUDGE_TIMEOUT).
- **User intervention needed**: Task is **PAUSED** with reason requiring user action (e.g. PAUSED_USER, PAUSED_JUDGE_INVALID, PAUSED_ALLOWED_PATHS, PAUSED_FORBIDDEN_GLOBS, or any PAUSED with non-empty `questions_for_user`).

**Notification channels** (both SHALL be used when configured):

1. **PM (Private Message)**: Send a message to the **bound Telegram user** (the user who is associated with this rdloop/OpenClaw instance).
2. **AOG group**: Send a message to the designated **AOG group** and **@mention** that user in the message, so the mention appears in the group.

**Content**: Message MUST be derived **only** from structured data (e.g. `task_id`, `state`, `decision`, `message`, `pause_reason_code`, `questions_for_user`). Format can be fixed templates (e.g. “Task &lt;task_id&gt;: &lt;state&gt; — &lt;message&gt;”). No LLM-generated text.

**Implementation note**: The Coordinator (or a small daemon/hook alongside it) must signal “terminal or intervention” events to OpenClaw (e.g. by writing a sentinel file, calling a webhook, or OpenClaw polling `out/` and diffing state). The exact mechanism is design; this document only requires that when such an event occurs, the two notification channels are triggered programmatically.

### 3.3 FR3: No LLM Under Any Circumstance

- Every feature above (list, status, drill-down, notifications) MUST be implemented with **deterministic, programmatic logic**.
- **OpenClaw’s LLM MUST NOT be invoked** for:
  - Generating or summarizing task list or status text.
  - Generating notification messages.
  - Handling errors, timeouts, or missing data (use fixed fallback messages or safe defaults instead).
- If data is missing or malformed, the implementation MUST either skip the entry, show a short fixed message (e.g. “Data unavailable”), or retry according to a fixed policy—**never** “ask the LLM what to do”.

---

## 4. Out of Scope for This Document

- Changes to rdloop Coordinator core logic (task lifecycle, Judge/Coder adapters).
- How OpenClaw is installed or configured on ao001 (only that it runs at ~/.openclaw and must be able to access Coordinator work info).
- Telegram bot creation, token, or AOG group setup (assumed existing or done separately).
- Exact deployment topology (whether rdloop `out/` is on the same host as OpenClaw or reached via API); the requirement is only that OpenClaw can obtain the described “current work info” by some programmatic means.

---

## 5. Summary Table

| ID   | Requirement | LLM |
|------|-------------|-----|
| FR1  | /rdloop → menu list of current/recent tasks → click → basic status in Telegram → optional drill-down | No |
| FR2  | On completion/abort/user-intervention → notify via PM + AOG group @mention | No |
| FR3  | All behavior programmatic; never trigger OpenClaw LLM | No |

---

## 6. References

- rdloop: `README.md`, `coordinator/run_task.sh`, `gui/server.js` (e.g. `/api/tasks`, `/api/task/:taskId`).
- Coordinator output: `out/<task_id>/status.json`, `final_summary.json`, `events.jsonl`; state/decision enums in README (§19, Pause Reason Codes).
- OpenClaw: ao001@100.114.240.117, ~/.openclaw (integration point to be designed).

---

## 7. rdloop Task for This Doc

The optimization of this requirements document is tracked as an rdloop task:

- **Task spec**: `examples/task_optimize_openclaw_telegram_req.json`
- **Run**: `bash examples/run_optimize_openclaw_telegram_req.sh`
- **Task id**: `optimize_openclaw_telegram_req` (appears under `out/` and in GUI).
