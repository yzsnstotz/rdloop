# Coder run.log 仅 179 字节问题 + Queue CLI → Cliapi 迁移说明

用于审查当前报错与从 queue CLI 切换到 API（coder/judge）的完整过程。

---

## 一、当前问题描述

### 现象

- **报错文案**：`Questions for user: Coder run.log has only 179 bytes (need ≥600). Check out/<task_id>/attempt_*/coder/run.log and ensure the coder adapter (cliapi gateway) is running and returning output; then use Run Next to retry.`
- **触发条件**：`coordinator/run_task.sh` 在单次 attempt 结束后检查 `out/<task_id>/attempt_<n>/coder/run.log` 的字节数；若 **&lt; 600**，则跳过 Judge，并进入 PAUSED，把上述文案写入 `questions_for_user`。
- **已知情况**：用户侧确认「服务均无问题」——如 CLIProxyAPI 8317、Cursor CLI API 8000 的 health 检查返回 200。即网关进程在跑，但 **run.log 仍然只有约 179 字节**。

### 逻辑位置（run_task.sh）

- 第 907–918 行：Judge 前做「run.log 是否有实质 coder 输出」的守卫：
  - `coder_log_size=$(wc -c < "$coder_log")`
  - 若 `coder_log_size -lt 600` → 不跑 Judge，`enter_paused`，并提示检查 run.log 与 coder adapter（cliapi gateway）。

### 179 字节可能含义

1. **API 返回 200 但内容极短**  
   - 网关返回 `choices[0].message.content` 为空或只有几个字符，适配器只把这段短内容写入 run.log，加上两行 header 和一行 "Finished"，总长约 179 字节。
2. **API 返回错误（如 403/401）**  
   - 若仍在使用**未改版**的适配器，可能只把简短 error 信息写入 run.log（例如 `{"error":{"message":"..."}}` 的摘要），总长也可在 ~179 字节。
3. **实际使用的不是 Cursor 适配器**  
   - 任务里 `coder` 若为 `codex_cli` / `claude_bridge` / `antigravity` 等，则写 run.log 的是 `call_coder_<suffix>.sh`，不是 `call_coder_cursor.sh`；需确认任务 JSON 里的 `coder` 类型。

### 建议立刻做的排查

1. **看实际 run.log 内容**  
   - 打开 `out/<task_id>/attempt_<n>/coder/run.log`，看是否有：
     - `[CODER][cursor] ... Starting via cliapi`
     - `HTTP_CODE=...`、`API returned no content`、`Raw response (first 1200 chars)` 等（若已部署带增强错误日志的 `call_coder_cursor.sh`）。
   - 若没有这些行，要么是旧版脚本，要么当前任务用的不是 cursor coder。
2. **确认任务用的 coder 类型**  
   - 在任务 JSON 或 GUI 中确认 `coder` 为 `cursor_cli` / `cursor-agent`，才会走 `call_coder_cursor.sh`。
3. **确认脚本版本**  
   - 当前 `coordinator/lib/call_coder_cursor.sh` 在「无有效 content」或解析失败时会写入 HTTP_CODE 和 Raw response 前 1200 字符；若 run.log 里从无这些内容，说明跑的是旧版或别的适配器。

---

## 二、从 Queue CLI 到 API（Cliapi）的迁移过程

### 原先：Queue CLI 模式（已移除）

- **Coder**  
  - 通过类似 `cursor_queue_cli.sh` 把请求放入队列；某处 `worker` 消费队列并调用 Cursor CLI，结果写回；rdloop 用 `wait_result.sh` / `enqueue.sh` 等轮询或取结果。  
  - 结果最终写入 `attempt_dir/coder/run.log`。
- **Judge**  
  - 同理，通过队列 + worker 调用 Cursor CLI，结果写回，形成 `attempt_dir/judge/verdict.json`。
- **特点**：依赖独立 worker 进程、队列、以及 CLI 的可用性；调试链较长（queue → worker → CLI → 结果回写）。

### 现在：Cliapi 模式（当前）

- **Coder**  
  - **脚本**：`coordinator/lib/call_coder_cursor.sh`  
  - **接口**：`$1=task_json_path`，`$2=attempt_dir`，`$3=worktree_dir`，`$4=instruction_path`。  
  - **输出**：`attempt_dir/coder/run.log`，`attempt_dir/coder/rc.txt`。  
  - **实现**：用 `curl` 向 **cursorcliapi** 发 HTTP 请求：
    - URL：`${RDLOOP_CURSOR_CLIAPI_BASE_URL:-http://127.0.0.1:8000/v1}/chat/completions`
    - Header：`Authorization: Bearer ${OPENCLAW_API_KEY:-openclawaousers}`，`Content-Type: application/json`
    - Body：OpenAI 风格 `{ "model": "<coder_model|auto>", "messages": [ { "role": "user", "content": "<full_prompt>" } ] }`
  - 响应若含 `choices[0].message.content`，则把该 content 写入 run.log；否则（或解析失败）写入增强错误信息（HTTP 状态码 + 原始响应前 1200 字符），并设 `rc.txt=195`。
- **Judge**  
  - **脚本**：`coordinator/lib/call_judge_cursor.sh`  
  - **接口**：`$1=task_json_path`，`$2=evidence_json_path`，`$3=out_attempt_dir`，`$4=judge_prompt_path`。  
  - **输出**：`out_attempt_dir/judge/verdict.json`，`out_attempt_dir/judge/rc.txt`。  
  - **实现**：同样用 `curl` 请求同一 cursorcliapi 的 `/chat/completions`，system 为 judge prompt，user 为 evidence；从返回的 content 中抽取 verdict JSON 写入 `verdict.json`。

### 已删除/不再使用的部分

- 已删除：`cursor_queue_cli.sh`、`cursor/worker.sh`、`wait_result.sh`、`enqueue.sh`、以及相关 README（如 `README_cursor_queue.md`）。
- `run_task.sh`、`write_env_json`、README、GUI 中已去除对 queue/worker 的引用；暂停文案改为只提示检查 run.log 与「coder adapter (cliapi gateway)」，不再提 queue CLI。

### 配置与环境

- **环境变量**（coder/judge 共用）：  
  - `RDLOOP_CURSOR_CLIAPI_BASE_URL`：默认 `http://127.0.0.1:8000/v1`  
  - `OPENCLAW_API_KEY`：默认 `openclawaousers`（需与 cursorcliapi 的鉴权一致，如 `CODEX_GATEWAY_TOKEN`）  
- **模型**：  
  - Coder：任务 JSON 或 `CODER_MODEL`，默认 `auto`  
  - Judge：任务 JSON 或 `JUDGE_MODEL`，默认 `auto`  
- **适配器选择**（run_task.sh）：  
  - `coder_type` / `judge_type` 为 `cursor-agent` 或 `cursor_cli` 时，使用 `call_coder_cursor.sh` / `call_judge_cursor.sh`。

---

## 三、审查与排查清单

| 项目 | 说明 |
|------|------|
| 任务用的 coder 类型 | 确认是 `cursor_cli` / `cursor-agent`，才会用 `call_coder_cursor.sh` 写 run.log。 |
| 实际 run.log 内容 | 打开 `out/<task_id>/attempt_*/coder/run.log`，看是否有 HTTP_CODE/Raw response 等；若有，说明是 API 错误/无内容；若没有，可能是旧脚本或非 cursor 适配器。 |
| cursorcliapi 是否真正处理 /chat/completions | health 200 只说明进程在；需确认 8000 的 `/v1/chat/completions` 在相同 Authorization 与 body 下能返回正常长度的 content。 |
| OPENCLAW_API_KEY 与网关鉴权 | 与 cursorcliapi（及上游）的 token 一致，否则易出现 403 等，响应体短，导致 run.log 很短。 |
| 600 字节阈值 | 在 `run_task.sh` 约 909–912 行；仅当 run.log ≥600 字节才跑 Judge；179 字节会触发当前「Questions for user」提示。 |

---

## 四、相关文件一览

- **判断 run.log 大小并提示**：`coordinator/run_task.sh`（约 907–918 行）
- **Cursor coder 适配器**：`coordinator/lib/call_coder_cursor.sh`（写 run.log、rc.txt）
- **Cursor judge 适配器**：`coordinator/lib/call_judge_cursor.sh`（写 verdict.json、rc.txt）
- **适配器选择**：`coordinator/run_task.sh`（约 753–755、781、936 行：coder_script_suffix / judge_script_suffix）

此文档便于审查「run.log 仅 179 字节」与「queue → cliapi」迁移是否一致，以及下一步应查 run.log 内容还是网关/鉴权/模型配置。
