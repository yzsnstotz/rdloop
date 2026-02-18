const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const VALIDATE_SCRIPT = path.resolve(__dirname, '..', '..', 'coordinator', 'lib', 'validate_verdict.py');

function runValidate(verdict) {
  const tmp = path.join(os.tmpdir(), `vv_test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(verdict));
  try {
    execSync(`python3 "${VALIDATE_SCRIPT}" "${tmp}"`, { stdio: 'pipe' });
    return 0;
  } catch (err) {
    return err.status;
  } finally {
    fs.unlinkSync(tmp);
  }
}

// --- V1 tests ---

describe('validate_verdict v1', () => {
  it('valid v1 verdict → exit 0', () => {
    const rc = runValidate({
      decision: 'PASS',
      reasons: ['All tests pass'],
      next_instructions: '',
      questions_for_user: []
    });
    assert.equal(rc, 0);
  });

  it('v1 missing field → exit 1', () => {
    const rc = runValidate({
      decision: 'PASS',
      reasons: ['ok']
      // missing next_instructions, questions_for_user
    });
    assert.equal(rc, 1);
  });

  it('v1 FAIL without next_instructions → exit 1', () => {
    const rc = runValidate({
      decision: 'FAIL',
      reasons: ['bad code'],
      next_instructions: '',
      questions_for_user: []
    });
    assert.equal(rc, 1);
  });

  it('v1 NEED_USER_INPUT without questions → exit 1', () => {
    const rc = runValidate({
      decision: 'NEED_USER_INPUT',
      reasons: ['need clarification'],
      next_instructions: 'ask user',
      questions_for_user: []
    });
    assert.equal(rc, 1);
  });
});

// --- V2 tests ---

function makeV2Verdict(overrides = {}) {
  const base = {
    decision: 'PASS',
    reasons: ['Good overall'],
    next_instructions: '',
    questions_for_user: [],
    task_type: 'engineering_impl',
    scores: {
      correctness: 4.5,
      runnability: 5.0,
      test_and_validation: 4.0,
      security: 4.5,
      architecture_and_modularity: 3.5,
      readability_and_maintainability: 4.0,
      performance: 3.5
    },
    weights: {
      correctness: 0.20,
      runnability: 0.18,
      test_and_validation: 0.16,
      security: 0.14,
      architecture_and_modularity: 0.12,
      readability_and_maintainability: 0.10,
      performance: 0.10
    },
    raw_score_0_5: 4.27,
    penalty: 0,
    final_score_0_5: 4.27,
    final_score_0_100: 85,
    gated: false,
    gating_reasons: [],
    top_issues: [
      'Architecture could be improved',
      'Performance needs optimization'
    ],
    fix_suggestions: [
      'Refactor data layer',
      'Add caching'
    ],
    scoring_mode_used: 'rubric_analytic',
    rubric_version_used: '1.0.0',
    rubric_hash_used: ''
  };
  return { ...base, ...overrides };
}

describe('validate_verdict v2 structural', () => {
  it('valid v2 verdict → exit 0', () => {
    const rc = runValidate(makeV2Verdict());
    assert.equal(rc, 0);
  });

  it('v2 missing required field → exit 1', () => {
    const v = makeV2Verdict();
    delete v.scoring_mode_used;
    const rc = runValidate(v);
    assert.equal(rc, 1);
  });

  it('v2 scores out of range → exit 1', () => {
    const v = makeV2Verdict({ scores: { ...makeV2Verdict().scores, correctness: 5.5 } });
    const rc = runValidate(v);
    assert.equal(rc, 1);
  });

  it('v2 penalty out of range → exit 1', () => {
    const v = makeV2Verdict({ penalty: 2.5 });
    const rc = runValidate(v);
    assert.equal(rc, 1);
  });

  it('v2 penalty non-0.5-step → exit 1', () => {
    const v = makeV2Verdict({ penalty: 0.3 });
    const rc = runValidate(v);
    assert.equal(rc, 1);
  });

  it('v2 weight sum mismatch → exit 1', () => {
    const v = makeV2Verdict({
      weights: {
        correctness: 0.30,
        runnability: 0.18,
        test_and_validation: 0.16,
        security: 0.14,
        architecture_and_modularity: 0.12,
        readability_and_maintainability: 0.10,
        performance: 0.10
      }
    });
    const rc = runValidate(v);
    assert.equal(rc, 1);
  });

  it('v2 raw_score_0_5 mismatch → exit 1', () => {
    const v = makeV2Verdict({ raw_score_0_5: 3.0 });
    const rc = runValidate(v);
    assert.equal(rc, 1);
  });

  it('v2 final_score_0_100 mismatch → exit 1', () => {
    const v = makeV2Verdict({ final_score_0_100: 50 });
    const rc = runValidate(v);
    assert.equal(rc, 1);
  });

  it('v2 top_issues too few → exit 1', () => {
    const v = makeV2Verdict({ top_issues: ['only one'] });
    const rc = runValidate(v);
    assert.equal(rc, 1);
  });

  it('v2 top_issues too many → exit 1', () => {
    const v = makeV2Verdict({ top_issues: ['a', 'b', 'c', 'd', 'e', 'f'] });
    const rc = runValidate(v);
    assert.equal(rc, 1);
  });

  it('v2 dimensions mismatch with rubric → exit 1', () => {
    const v = makeV2Verdict({
      scores: { correctness: 4.0, runnability: 4.0 },
      weights: { correctness: 0.5, runnability: 0.5 },
      raw_score_0_5: 4.0,
      final_score_0_5: 4.0,
      final_score_0_100: 80
    });
    const rc = runValidate(v);
    assert.equal(rc, 1);
  });
});

describe('validate_verdict v2 K5-3 consistency', () => {
  it('anti-flat violation (all identical scores) → exit 2', () => {
    const scores = {
      correctness: 4.0,
      runnability: 4.0,
      test_and_validation: 4.0,
      security: 4.0,
      architecture_and_modularity: 4.0,
      readability_and_maintainability: 4.0,
      performance: 4.0
    };
    const raw = 4.0;
    const v = makeV2Verdict({
      scores,
      raw_score_0_5: raw,
      final_score_0_5: raw,
      final_score_0_100: 80,
      top_issues: ['Minor issue A', 'Minor issue B']
    });
    const rc = runValidate(v);
    assert.equal(rc, 2);
  });

  it('top_issues empty with non-perfect score → exit 1 (structural catches first)', () => {
    // Need to make top_issues empty but still pass structural (top_issues 2..5)
    // Actually structural requires 2..5 so empty would fail structural first.
    // We need a case where structural passes but K5-3 catches it.
    // The MISSING_ISSUES check fires when top_issues count = 0, but structural requires >= 2.
    // So this K5-3 check would only fire if structural validation was bypassed.
    // Actually, re-reading the code: K5-3 only runs if no structural errors.
    // Since structural requires 2..5 issues, MISSING_ISSUES never fires naturally.
    // This test verifies that structural catches the case first.
    const v = makeV2Verdict({ top_issues: [] });
    const rc = runValidate(v);
    assert.equal(rc, 1); // structural error (too few), not K5-3
  });

  it('keyword-score alignment violation → exit 2', () => {
    const v = makeV2Verdict({
      top_issues: [
        'correctness issue: 逻辑错误 in core module',
        'Minor style issue'
      ]
    });
    // correctness is 4.5 but keyword rule says max 3.0
    const rc = runValidate(v);
    assert.equal(rc, 2);
  });

  it('varied scores (no K5-3 violation) → exit 0', () => {
    const rc = runValidate(makeV2Verdict());
    assert.equal(rc, 0);
  });
});
