#!/usr/bin/env python3
"""validate_verdict.py — Validate a JudgeVerdict JSON file.

Usage:
    python3 validate_verdict.py <verdict_file>
    cat verdict.json | python3 validate_verdict.py -

Exit 0 = valid, Exit 1 = invalid (structural), Exit 2 = inconsistent (K5-3).
"""
import json
import math
import os
import sys

VALID_DECISIONS = {"PASS", "FAIL", "NEED_USER_INPUT"}

# Valid score values: 0, 0.5, 1.0, ..., 5.0
VALID_SCORES = {i * 0.5 for i in range(11)}  # 0.0, 0.5, 1.0, ... 5.0

# K5-3 keyword → dimension mapping for reason-score alignment
KEYWORD_DIM_MAX = {
    "缺失": {"completeness": 4.0, "scene_completeness": 4.0},
    "未覆盖验收": {"acceptance_testability": 4.0},
    "不可运行": {"runnability": 3.0},
    "安全漏洞": {"security": 3.0},
    "测试缺失": {"test_and_validation": 3.0},
    "逻辑错误": {"correctness": 3.0},
    "不清晰": {"clarity": 4.0, "visual_clarity": 4.0},
    "合规问题": {"constraints_and_compliance": 3.0, "platform_compliance": 3.0},
    "missing": {"completeness": 4.0, "scene_completeness": 4.0},
    "not runnable": {"runnability": 3.0},
}

RUBRIC_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "schemas", "judge_rubric.json")


def load_rubric():
    try:
        with open(RUBRIC_PATH, "r") as f:
            return json.load(f)
    except Exception:
        return None


def is_v2(data):
    """Detect v2 verdict: has task_type AND scores."""
    return "task_type" in data and "scores" in data and isinstance(data["scores"], dict)


def validate_v1(data):
    """Original v1 validation — unchanged for backward compat."""
    errors = []
    for field in ("decision", "reasons", "next_instructions", "questions_for_user"):
        if field not in data:
            errors.append("missing required field: %s" % field)
    if errors:
        return errors

    if data["decision"] not in VALID_DECISIONS:
        errors.append("invalid decision: %s (must be one of %s)" % (data["decision"], ", ".join(sorted(VALID_DECISIONS))))

    if not isinstance(data["reasons"], list) or len(data["reasons"]) == 0:
        errors.append("reasons must be a non-empty array")

    if not isinstance(data["next_instructions"], str):
        errors.append("next_instructions must be a string")

    if data["decision"] == "FAIL" and (not isinstance(data["next_instructions"], str) or data["next_instructions"].strip() == ""):
        errors.append("FAIL verdict requires non-empty next_instructions")

    if not isinstance(data["questions_for_user"], list):
        errors.append("questions_for_user must be an array")

    if data["decision"] == "NEED_USER_INPUT":
        if not isinstance(data["questions_for_user"], list) or len(data["questions_for_user"]) == 0:
            errors.append("NEED_USER_INPUT verdict requires non-empty questions_for_user")

    return errors


def validate_v2_structural(data):
    """V2 structural validation (B4-2). Returns list of errors."""
    errors = []

    # Run v1 checks first (v2 is superset)
    v1_errors = validate_v1(data)
    if v1_errors:
        errors.extend(v1_errors)

    # Required v2 fields
    v2_required = [
        "scores", "weights", "raw_score_0_5", "penalty",
        "final_score_0_5", "final_score_0_100", "gated",
        "gating_reasons", "top_issues", "fix_suggestions",
        "scoring_mode_used"
    ]
    for field in v2_required:
        if field not in data:
            errors.append("missing v2 required field: %s" % field)

    if errors:
        return errors

    scores = data["scores"]
    weights = data["weights"]

    # scores.* must be valid (0, 0.5, 1, ..., 5)
    for dim, val in scores.items():
        if not isinstance(val, (int, float)):
            errors.append("scores.%s must be a number, got %s" % (dim, type(val).__name__))
        elif val not in VALID_SCORES:
            errors.append("scores.%s = %s not in valid range (0, 0.5, 1, ..., 5)" % (dim, val))

    # penalty in [0, 2] step 0.5
    penalty = data["penalty"]
    if not isinstance(penalty, (int, float)):
        errors.append("penalty must be a number")
    elif penalty < 0 or penalty > 2 or (penalty * 2) != int(penalty * 2):
        errors.append("penalty = %s must be in [0, 2] step 0.5" % penalty)

    # top_issues: 2..5 items, each max 120 chars
    top_issues = data["top_issues"]
    if not isinstance(top_issues, list):
        errors.append("top_issues must be an array")
    elif len(top_issues) < 2 or len(top_issues) > 5:
        errors.append("top_issues must have 2..5 items, got %d" % len(top_issues))
    else:
        for i, item in enumerate(top_issues):
            if not isinstance(item, str):
                errors.append("top_issues[%d] must be a string" % i)
            elif len(item) > 120:
                errors.append("top_issues[%d] exceeds 120 chars (%d)" % (i, len(item)))

    # fix_suggestions: max 5 items, each max 160 chars
    fix_suggestions = data["fix_suggestions"]
    if not isinstance(fix_suggestions, list):
        errors.append("fix_suggestions must be an array")
    elif len(fix_suggestions) > 5:
        errors.append("fix_suggestions max 5 items, got %d" % len(fix_suggestions))
    else:
        for i, item in enumerate(fix_suggestions):
            if not isinstance(item, str):
                errors.append("fix_suggestions[%d] must be a string" % i)
            elif len(item) > 160:
                errors.append("fix_suggestions[%d] exceeds 160 chars (%d)" % (i, len(item)))

    # weights sum ~= 1.0 (tolerance 0.01)
    if isinstance(weights, dict) and all(isinstance(v, (int, float)) for v in weights.values()):
        w_sum = sum(weights.values())
        if abs(w_sum - 1.0) > 0.01:
            errors.append("weights sum = %.4f, must be ~1.0 (tolerance 0.01)" % w_sum)

    # Validate scores dimensions match weights dimensions
    if isinstance(weights, dict) and isinstance(scores, dict):
        if set(scores.keys()) != set(weights.keys()):
            errors.append("scores dimensions %s do not match weights dimensions %s" % (
                sorted(scores.keys()), sorted(weights.keys())))

    # raw_score_0_5 = weighted sum of scores (tolerance 0.05)
    if isinstance(scores, dict) and isinstance(weights, dict) and not errors:
        computed_raw = sum(scores.get(d, 0) * weights.get(d, 0) for d in scores)
        raw = data["raw_score_0_5"]
        if isinstance(raw, (int, float)) and abs(computed_raw - raw) > 0.05:
            errors.append("raw_score_0_5 = %.4f but computed = %.4f (tolerance 0.05)" % (raw, computed_raw))

    # final_score_0_5 = max(0, raw - penalty) (tolerance 0.05)
    raw = data.get("raw_score_0_5", 0)
    final5 = data.get("final_score_0_5", 0)
    if isinstance(raw, (int, float)) and isinstance(final5, (int, float)) and isinstance(penalty, (int, float)):
        expected_final = max(0, raw - penalty)
        if abs(expected_final - final5) > 0.05:
            errors.append("final_score_0_5 = %.4f but expected max(0, %.4f - %.1f) = %.4f" % (
                final5, raw, penalty, expected_final))

    # final_score_0_100 = round(20 * final_score_0_5) (tolerance 1)
    final100 = data.get("final_score_0_100", 0)
    if isinstance(final5, (int, float)) and isinstance(final100, (int, float)):
        expected100 = round(20 * final5)
        if abs(expected100 - final100) > 1:
            errors.append("final_score_0_100 = %s but expected round(20 * %.4f) = %s" % (
                final100, final5, expected100))

    # Validate against rubric if available
    rubric = load_rubric()
    if rubric:
        task_type = data.get("task_type", "")
        alias_map = rubric.get("alias_map", {})
        normalized_type = alias_map.get(task_type, task_type)
        types = rubric.get("task_types", {})
        if normalized_type in types:
            tt = types[normalized_type]
            expected_dims = set(tt["dimensions"])
            actual_dims = set(scores.keys())
            if expected_dims != actual_dims:
                errors.append("task_type '%s' expects dimensions %s but got %s" % (
                    normalized_type, sorted(expected_dims), sorted(actual_dims)))

    return errors


def check_k5_3_consistency(data):
    """K5-3 consistency checks. Returns list of inconsistency reasons."""
    inconsistencies = []
    scores = data.get("scores", {})
    top_issues = data.get("top_issues", [])

    if not isinstance(scores, dict) or not scores:
        return inconsistencies

    score_values = [v for v in scores.values() if isinstance(v, (int, float))]

    # Anti-flat: dims >= 6, all scores identical → require >= 2 distinct or stddev >= 0.15
    if len(score_values) >= 6:
        distinct = len(set(score_values))
        if distinct < 2:
            inconsistencies.append("ANTI_FLAT: all %d dimensions have identical score %.1f" % (
                len(score_values), score_values[0]))
        else:
            mean = sum(score_values) / len(score_values)
            variance = sum((v - mean) ** 2 for v in score_values) / len(score_values)
            stddev = math.sqrt(variance)
            if stddev < 0.15 and distinct < 2:
                inconsistencies.append("ANTI_FLAT: stddev = %.3f < 0.15 with only %d distinct values" % (
                    stddev, distinct))

    # Reason-score alignment: keyword → dimension max score
    if isinstance(top_issues, list):
        issues_text = " ".join(str(i) for i in top_issues).lower()
        for keyword, dim_max_map in KEYWORD_DIM_MAX.items():
            if keyword.lower() in issues_text:
                for dim, max_score in dim_max_map.items():
                    if dim in scores and scores[dim] > max_score:
                        inconsistencies.append(
                            "KEYWORD_MISMATCH: top_issues mentions '%s' but %s = %.1f (max %.1f)" % (
                                keyword, dim, scores[dim], max_score))

    # top_issues count: 0 issues with non-perfect score → INCONSISTENT
    perfect = all(v == 5.0 for v in score_values) if score_values else True
    if not perfect and isinstance(top_issues, list) and len(top_issues) == 0:
        inconsistencies.append("MISSING_ISSUES: non-perfect scores but top_issues is empty")

    return inconsistencies


def validate(data):
    """Main validate entry point. Returns (errors, inconsistencies)."""
    if is_v2(data):
        errors = validate_v2_structural(data)
        inconsistencies = check_k5_3_consistency(data) if not errors else []
        return errors, inconsistencies
    else:
        errors = validate_v1(data)
        return errors, []


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: validate_verdict.py <file_or_->\n")
        sys.exit(1)

    path = sys.argv[1]
    try:
        if path == "-":
            raw = sys.stdin.read()
        else:
            with open(path, "r") as f:
                raw = f.read()

        data = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.stderr.write("invalid JSON: %s\n" % str(e))
        sys.exit(1)
    except Exception as e:
        sys.stderr.write("error reading file: %s\n" % str(e))
        sys.exit(1)

    errors, inconsistencies = validate(data)

    if errors:
        for err in errors:
            sys.stderr.write("VALIDATION ERROR: %s\n" % err)
        sys.exit(1)
    elif inconsistencies:
        for inc in inconsistencies:
            sys.stderr.write("INCONSISTENCY: %s\n" % inc)
        sys.exit(2)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
