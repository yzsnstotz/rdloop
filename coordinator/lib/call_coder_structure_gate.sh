#!/usr/bin/env bash
# call_coder_structure_gate.sh — Structure Gate Coder Adapter (K8-3)
# Produces a fixed artifacts/requirements.md with title "# 需求文档"
# No LLM required — deterministic structure output.
#
# Interface: $1=task_json_path $2=out_attempt_dir $3=worktree_dir $4=instruction_file
# Outputs: out_attempt_dir/coder/run.log, coder/rc.txt; worktree_dir/artifacts/requirements.md

set -uo pipefail

task_json_path="$1"
out_attempt_dir="$2"
worktree_dir="$3"
instruction_file="${4:-}"

mkdir -p "${out_attempt_dir}/coder"
exec > "${out_attempt_dir}/coder/run.log" 2>&1

echo "[structure_gate_coder] Starting structure gate coder"
echo "[structure_gate_coder] worktree: ${worktree_dir}"
echo "[structure_gate_coder] task_json: ${task_json_path}"

# Read task_type from task.json
task_type=$(python3 -c "
import json,sys
try:
  with open(sys.argv[1]) as f: d=json.load(f)
  print(d.get('task_type','requirements_doc'))
except: print('requirements_doc')
" "$task_json_path" 2>/dev/null || echo "requirements_doc")

# Create artifacts directory in worktree
artifacts_dir="${worktree_dir}/artifacts"
mkdir -p "$artifacts_dir"

# Generate requirements.md with fixed title and structure
cat > "${artifacts_dir}/requirements.md" << 'REQDOC'
# 需求文档

**文档类型**：结构验证文档（Structure Gate）
**版本**：1.0.0
**状态**：Gate Pass

---

## 1. 目标与范围

本需求文档为管道结构验证（Pipeline Structure Gate）产物，用于验证 rdloop Coordinator 的完整管道结构——包括任务创建、Coder 执行、证据落盘、Judge 评估与状态机流转。

## 2. 验收标准

- 本文件（artifacts/requirements.md）存在且非空
- 文件包含固定标题 `# 需求文档`
- 文件可被 Judge 识别为合法结构产物

## 3. 约束与合规

- 本文件由 structure_gate 适配器生成，不依赖外部 LLM
- 内容固定，确保回归测试的确定性

## 4. 风险与异常流

无（本文件为固定结构产物，无运行时风险）

## 5. 可实现性

- 实现路径：`coordinator/lib/call_coder_structure_gate.sh`
- 降级路径：无需降级，本适配器总是成功

## 6. 结构与可读性

文档遵循标准需求文档结构：目标、验收标准、约束、风险、可实现性。
REQDOC

echo "[structure_gate_coder] Created ${artifacts_dir}/requirements.md"

# Optionally create spec.json
cat > "${artifacts_dir}/spec.json" << 'SPECJSON'
{
  "schema_version": "v1",
  "type": "structure_gate",
  "artifacts": ["requirements.md"],
  "generated_by": "call_coder_structure_gate.sh"
}
SPECJSON

echo "[structure_gate_coder] Created ${artifacts_dir}/spec.json"
echo "[structure_gate_coder] Structure gate coder completed successfully"

echo "0" > "${out_attempt_dir}/coder/rc.txt"
exit 0
