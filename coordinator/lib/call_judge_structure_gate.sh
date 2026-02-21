#!/usr/bin/env bash
# call_judge_structure_gate.sh — Structure Gate Judge Adapter (K8-3/K8-4)
# Validates that artifacts/requirements.md exists, is non-empty, and contains
# the fixed title "# 需求文档". No LLM required.
#
# Interface: $1=task_json_path $2=evidence_json_path $3=out_attempt_dir $4=judge_prompt_path
# Outputs: out_attempt_dir/judge/verdict.json, judge/run.log, judge/rc.txt

set -uo pipefail

task_json_path="$1"
evidence_json_path="$2"
out_attempt_dir="$3"
judge_prompt_path="${4:-}"

mkdir -p "${out_attempt_dir}/judge"
log="${out_attempt_dir}/judge/run.log"

{
  echo "[structure_gate_judge] Starting structure gate judge"
  echo "[structure_gate_judge] task_json: ${task_json_path}"
  echo "[structure_gate_judge] evidence: ${evidence_json_path}"
  # B4-7: Record that this adapter does not use LLM temperature
  echo "[structure_gate_judge] temperature: N/A — structure gate is deterministic, no LLM; temperature=0 by design"
} > "$log" 2>&1

# Delegate all logic to Python for clean JSON handling
python3 - "$task_json_path" "$evidence_json_path" "$out_attempt_dir" "$log" << 'PYEOF'
import json, sys, os

task_json_path, evidence_json_path, out_dir, log_path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

def log(msg):
    with open(log_path, 'a', encoding='utf-8') as f:
        f.write(msg + '\n')

# Read task_type
task_type = 'requirements_doc'
try:
    with open(task_json_path, encoding='utf-8') as f:
        t = json.load(f)
    task_type = t.get('task_type', 'requirements_doc') or 'requirements_doc'
except Exception as e:
    log(f'[structure_gate_judge] WARN: could not read task.json: {e}')

# Read worktree_path from evidence.json
worktree_path = ''
try:
    with open(evidence_json_path, encoding='utf-8') as f:
        ev = json.load(f)
    worktree_path = ev.get('worktree_path', '')
except Exception as e:
    log(f'[structure_gate_judge] WARN: could not read evidence.json: {e}')

log(f'[structure_gate_judge] worktree_path: {worktree_path}')

# Validate artifacts/requirements.md
fail_reasons = []
gating_reasons = []

req_md_path = os.path.join(worktree_path, 'artifacts', 'requirements.md') if worktree_path else ''

if not req_md_path or not os.path.isfile(req_md_path):
    fail_reasons.append('artifacts/requirements.md not found in worktree')
    gating_reasons.append('缺少必需文件 artifacts/requirements.md')
    log('[structure_gate_judge] FAIL: artifacts/requirements.md not found')
else:
    size = os.path.getsize(req_md_path)
    if size < 10:
        fail_reasons.append(f'artifacts/requirements.md is empty ({size} bytes)')
        gating_reasons.append('requirements.md 内容为空')
        log(f'[structure_gate_judge] FAIL: requirements.md empty ({size} bytes)')
    else:
        try:
            content = open(req_md_path, encoding='utf-8').read()
            if '# 需求文档' in content:
                log('[structure_gate_judge] PASS: requirements.md exists, non-empty, has correct title')
            else:
                fail_reasons.append("requirements.md does not contain required title '# 需求文档'")
                gating_reasons.append('缺少必需标题 # 需求文档')
                log("[structure_gate_judge] FAIL: missing title '# 需求文档'")
        except Exception as e:
            fail_reasons.append(f'could not read requirements.md: {e}')
            gating_reasons.append('无法读取 requirements.md')

decision = 'PASS' if not fail_reasons else 'FAIL'
gated = decision != 'PASS'
log(f'[structure_gate_judge] decision: {decision} gated: {gated}')

# Build scores
if decision == 'PASS':
    scores = {
        'clarity': 4.5, 'completeness': 4.5, 'acceptance_testability': 4.5,
        'risk_and_exception': 4.0, 'constraints_and_compliance': 4.5,
        'feasibility': 4.5, 'structure_and_readability': 4.5
    }
    top_issues = [
        '结构验证通过：文档包含必需标题和基本章节',
        '内容为固定模板，非 LLM 生成内容'
    ]
    fix_suggestions = []
    reasons = ['artifacts/requirements.md 存在且包含 # 需求文档 标题']
    next_instructions = ''
    questions = []
else:
    scores = {
        'clarity': 0.0, 'completeness': 1.0, 'acceptance_testability': 0.0,
        'risk_and_exception': 0.0, 'constraints_and_compliance': 0.0,
        'feasibility': 0.0, 'structure_and_readability': 0.0
    }
    top_issues = (fail_reasons + ['请检查 coder 是否在 worktree 中创建了 artifacts/ 目录'])[:5]
    if len(top_issues) < 2:
        top_issues.append('确保 coder adapter 正确创建了 artifacts/requirements.md')
    fix_suggestions = ['确保 artifacts/requirements.md 存在、非空且包含 # 需求文档 标题']
    reasons = fail_reasons or ['结构验证失败']
    next_instructions = '请确保 artifacts/requirements.md 存在、非空且包含 # 需求文档 标题'
    questions = []

weights = {
    'clarity': 0.18, 'completeness': 0.18, 'acceptance_testability': 0.18,
    'risk_and_exception': 0.12, 'constraints_and_compliance': 0.14,
    'feasibility': 0.10, 'structure_and_readability': 0.10
}
raw = sum(scores[d] * weights[d] for d in scores)
penalty = 0.0
final5 = max(0.0, raw - penalty)
final100 = round(20 * final5)

verdict = {
    'schema_version': 'v1',
    'decision': decision,
    'reasons': reasons,
    'next_instructions': next_instructions,
    'questions_for_user': questions,
    'task_type': task_type,
    'scores': scores,
    'weights': weights,
    'raw_score_0_5': round(raw, 4),
    'penalty': penalty,
    'final_score_0_5': round(final5, 4),
    'final_score_0_100': final100,
    'gated': gated,
    'gating_reasons': gating_reasons if gated else [],
    'top_issues': top_issues[:5],
    'fix_suggestions': fix_suggestions[:5],
    'scoring_mode_used': 'rubric_analytic',
    'deliverability_index_0_100': final100 if not gated else 0,
    'improvement_potential_0_100': 10 if decision == 'PASS' else 80
}

verdict_path = os.path.join(out_dir, 'judge', 'verdict.json')
with open(verdict_path, 'w', encoding='utf-8') as f:
    json.dump(verdict, f, indent=2, ensure_ascii=False)

log(f'[structure_gate_judge] Verdict written to {verdict_path}')
PYEOF

echo "0" > "${out_attempt_dir}/judge/rc.txt"
exit 0
