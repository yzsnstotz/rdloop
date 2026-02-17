#!/usr/bin/env python3
"""validate_verdict.py — Validate a JudgeVerdict JSON file.

Usage:
    python3 validate_verdict.py <verdict_file>
    cat verdict.json | python3 validate_verdict.py -

Exit 0 = valid, Exit 1 = invalid (prints reason to stderr).
"""
import json
import sys

VALID_DECISIONS = {"PASS", "FAIL", "NEED_USER_INPUT"}


def validate(data):
    errors = []

    # Required fields
    for field in ("decision", "reasons", "next_instructions", "questions_for_user"):
        if field not in data:
            errors.append("missing required field: %s" % field)

    if errors:
        return errors

    # decision value
    if data["decision"] not in VALID_DECISIONS:
        errors.append("invalid decision: %s (must be one of %s)" % (data["decision"], ", ".join(sorted(VALID_DECISIONS))))

    # reasons must be non-empty array
    if not isinstance(data["reasons"], list) or len(data["reasons"]) == 0:
        errors.append("reasons must be a non-empty array")

    # next_instructions must be string
    if not isinstance(data["next_instructions"], str):
        errors.append("next_instructions must be a string")

    # FAIL => next_instructions non-empty
    if data["decision"] == "FAIL" and (not isinstance(data["next_instructions"], str) or data["next_instructions"].strip() == ""):
        errors.append("FAIL verdict requires non-empty next_instructions")

    # questions_for_user must be array
    if not isinstance(data["questions_for_user"], list):
        errors.append("questions_for_user must be an array")

    # NEED_USER_INPUT => questions_for_user non-empty
    if data["decision"] == "NEED_USER_INPUT":
        if not isinstance(data["questions_for_user"], list) or len(data["questions_for_user"]) == 0:
            errors.append("NEED_USER_INPUT verdict requires non-empty questions_for_user")

    return errors


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

    errors = validate(data)
    if errors:
        for err in errors:
            sys.stderr.write("VALIDATION ERROR: %s\n" % err)
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
