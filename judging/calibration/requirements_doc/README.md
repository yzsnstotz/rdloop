# Calibration Pack: requirements_doc

Anchor meanings for each score level per dimension.

## Score Anchors (0-5 scale)

| Score | Meaning |
|-------|---------|
| 0 | Completely absent or irrelevant |
| 1 | Present but fundamentally flawed or unusable |
| 2 | Below minimum — major gaps, hard gate threshold |
| 3 | Acceptable minimum — meets basic requirements with notable gaps |
| 4 | Good — solid coverage with minor issues |
| 5 | Excellent — comprehensive, no significant issues |

## Dimension Anchors

### clarity (weight: 0.18, hard gate)
- 0: No requirements text at all
- 2: Ambiguous phrasing, multiple interpretations possible
- 3: Core requirements clear, some edge cases ambiguous
- 5: Unambiguous, each requirement has single clear interpretation

### completeness (weight: 0.18, hard gate)
- 0: Empty or placeholder only
- 2: Major functional areas missing
- 3: Core features covered, non-functional requirements sparse
- 5: All functional + non-functional requirements documented

### acceptance_testability (weight: 0.18, hard gate)
- 0: No acceptance criteria
- 2: Criteria exist but untestable (vague, subjective)
- 3: Most criteria testable, some need clarification
- 5: Every requirement has clear, automatable acceptance test

### constraints_and_compliance (weight: 0.14, hard gate)
- 0: No constraints mentioned
- 2: Technical constraints missing or contradictory
- 3: Major constraints listed, compliance requirements noted
- 5: All constraints explicit with rationale

### risk_and_exception (weight: 0.12)
- 0: No risk analysis
- 3: Major risks identified with basic mitigation
- 5: Comprehensive risk register with mitigations and contingencies

### feasibility (weight: 0.10)
- 0: Requirements clearly infeasible
- 3: Feasible with known technical challenges noted
- 5: All requirements validated against technical constraints

### structure_and_readability (weight: 0.10)
- 0: Unstructured text dump
- 3: Logical sections, some inconsistent formatting
- 5: Professional structure, consistent formatting, easy navigation

## Cases

Place calibration case files in `cases/` with expected verdicts in `expected/`.
Format: JSON matching the judge_verdict_v2 schema.
