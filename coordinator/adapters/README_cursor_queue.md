# Cursor Queue CLI

同步调用 Cursor Agent 的命令行工具，通过文件队列实现。

**依赖**：必须在 `yzliu` 用户上运行 `coordinator/adapters/cursor/worker.sh`（通常通过 LaunchAgent 后台运行）。

**用法**：`coordinator/adapters/cursor_queue_cli.sh "<prompt>" [--id <job_id>] [--timeout <sec>]`

**行为**：写入 `out/cursor_queue/<job_id>.job` → 轮询等待 `out/cursor_out/<job_id>.rc`（200ms 间隔，默认 600s 超时）→ 读取 rc 作为 exit code，输出 response.txt 到 stdout。
