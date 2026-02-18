/**
 * decision_table.test.js — K2-6 unit tests (17 vectors).
 *
 * Run: node --test tests/unit/decision_table.test.js
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { decideNextState } = require("../../coordinator/lib/decision_table");

/** Helper: build a full context with defaults, overriding with partial. */
function ctx(partial) {
  return {
    role: "judge",
    rc: 0,
    error_class: "",
    verdict_decision: "",
    verdict_gated: false,
    thresholds_pass: true,
    current_attempt: 1,
    effective_max_attempts: 3,
    consecutive_timeout_count: 0,
    consecutive_timeout_key: "",
    ...partial,
  };
}

describe("decision_table K2-6 vectors", () => {
  // #1  judge timeout → PAUSED_JUDGE_TIMEOUT, consume=false
  it("#1 judge rc=124 TIMEOUT → PAUSED_JUDGE_TIMEOUT", () => {
    const r = decideNextState(ctx({ role: "judge", rc: 124, error_class: "TIMEOUT" }));
    assert.equal(r.next_state, "PAUSED");
    assert.equal(r.pause_reason_code, "PAUSED_JUDGE_TIMEOUT");
    assert.equal(r.consume_attempt, false);
  });

  // #2  coder timeout → PAUSED_CODER_TIMEOUT, consume=false
  it("#2 coder rc=124 TIMEOUT → PAUSED_CODER_TIMEOUT", () => {
    const r = decideNextState(ctx({ role: "coder", rc: 124, error_class: "TIMEOUT" }));
    assert.equal(r.next_state, "PAUSED");
    assert.equal(r.pause_reason_code, "PAUSED_CODER_TIMEOUT");
    assert.equal(r.consume_attempt, false);
  });

  // #3  coder auth 195 → PAUSED_CODER_AUTH_195, consume=false
  it("#3 coder rc=195 AUTH → PAUSED_CODER_AUTH_195", () => {
    const r = decideNextState(ctx({ role: "coder", rc: 195, error_class: "AUTH" }));
    assert.equal(r.next_state, "PAUSED");
    assert.equal(r.pause_reason_code, "PAUSED_CODER_AUTH_195");
    assert.equal(r.consume_attempt, false);
  });

  // #4  test timeout → PAUSED_TEST_TIMEOUT, consume=true
  it("#4 test rc=124 TIMEOUT → PAUSED_TEST_TIMEOUT, consume=true", () => {
    const r = decideNextState(ctx({ role: "test", rc: 124, error_class: "TIMEOUT" }));
    assert.equal(r.next_state, "PAUSED");
    assert.equal(r.pause_reason_code, "PAUSED_TEST_TIMEOUT");
    assert.equal(r.consume_attempt, true);
  });

  // #5  judge FAIL + gated → PAUSED_SCORE_GATED, consume=true
  it("#5 judge FAIL gated → PAUSED_SCORE_GATED", () => {
    const r = decideNextState(ctx({ verdict_decision: "FAIL", verdict_gated: true }));
    assert.equal(r.next_state, "PAUSED");
    assert.equal(r.pause_reason_code, "PAUSED_SCORE_GATED");
    assert.equal(r.consume_attempt, true);
  });

  // #6  judge FAIL + !gated + !thresholds → PAUSED_SCORE_BELOW_THRESHOLD, consume=true
  it("#6 judge FAIL !gated !thresholds → PAUSED_SCORE_BELOW_THRESHOLD", () => {
    const r = decideNextState(ctx({ verdict_decision: "FAIL", verdict_gated: false, thresholds_pass: false }));
    assert.equal(r.next_state, "PAUSED");
    assert.equal(r.pause_reason_code, "PAUSED_SCORE_BELOW_THRESHOLD");
    assert.equal(r.consume_attempt, true);
  });

  // #7  judge NEED_USER_INPUT → PAUSED_WAITING_USER_INPUT, consume=false
  it("#7 NEED_USER_INPUT → PAUSED_WAITING_USER_INPUT", () => {
    const r = decideNextState(ctx({ verdict_decision: "NEED_USER_INPUT" }));
    assert.equal(r.next_state, "PAUSED");
    assert.equal(r.pause_reason_code, "PAUSED_WAITING_USER_INPUT");
    assert.equal(r.consume_attempt, false);
  });

  // #8  judge PASS + !gated + thresholds → READY_FOR_REVIEW
  it("#8 PASS !gated thresholds → READY_FOR_REVIEW", () => {
    const r = decideNextState(ctx({ verdict_decision: "PASS", thresholds_pass: true }));
    assert.equal(r.next_state, "READY_FOR_REVIEW");
    assert.equal(r.pause_reason_code, "");
    assert.equal(r.last_decision, "PASS");
  });

  // #9  coordinator CRASH → PAUSED_CRASH
  it("#9 coordinator CRASH → PAUSED_CRASH", () => {
    const r = decideNextState(ctx({ role: "coordinator", error_class: "CRASH" }));
    assert.equal(r.next_state, "PAUSED");
    assert.equal(r.pause_reason_code, "PAUSED_CRASH");
  });

  // #10 judge VERDICT_INVALID → PAUSED_JUDGE_VERDICT_INVALID
  it("#10 VERDICT_INVALID → PAUSED_JUDGE_VERDICT_INVALID", () => {
    const r = decideNextState(ctx({ error_class: "VERDICT_INVALID" }));
    assert.equal(r.next_state, "PAUSED");
    assert.equal(r.pause_reason_code, "PAUSED_JUDGE_VERDICT_INVALID");
  });

  // #11 judge VERDICT_INCONSISTENT → PAUSED_JUDGE_VERDICT_INCONSISTENT
  it("#11 VERDICT_INCONSISTENT → PAUSED_JUDGE_VERDICT_INCONSISTENT", () => {
    const r = decideNextState(ctx({ error_class: "VERDICT_INCONSISTENT" }));
    assert.equal(r.next_state, "PAUSED");
    assert.equal(r.pause_reason_code, "PAUSED_JUDGE_VERDICT_INCONSISTENT");
  });

  // #12 judge timeout consecutive=2 → FAILED
  it("#12 judge TIMEOUT consecutive=2 → FAILED", () => {
    const r = decideNextState(ctx({
      role: "judge", rc: 124, error_class: "TIMEOUT",
      consecutive_timeout_count: 2, consecutive_timeout_key: "judge_timeout",
    }));
    assert.equal(r.next_state, "FAILED");
    assert.equal(r.pause_reason_code, "");
    assert.equal(r.consume_attempt, true);
  });

  // #13 FAIL normal, attempt < max → RUNNING (continue)
  it("#13 FAIL normal attempt<max → RUNNING", () => {
    const r = decideNextState(ctx({
      verdict_decision: "FAIL", current_attempt: 1, effective_max_attempts: 3,
    }));
    assert.equal(r.next_state, "RUNNING");
    assert.equal(r.consume_attempt, true);
    assert.equal(r.last_decision, "FAIL");
  });

  // #14 FAIL normal, attempt >= max → FAILED
  it("#14 FAIL normal attempt>=max → FAILED", () => {
    const r = decideNextState(ctx({
      verdict_decision: "FAIL", current_attempt: 3, effective_max_attempts: 3,
    }));
    assert.equal(r.next_state, "FAILED");
    assert.equal(r.consume_attempt, true);
    assert.equal(r.last_decision, "FAIL");
  });

  // #15 judge AUTH 195 → PAUSED_JUDGE_AUTH_195
  it("#15 judge rc=195 → PAUSED_JUDGE_AUTH_195", () => {
    const r = decideNextState(ctx({ role: "judge", rc: 195, error_class: "AUTH" }));
    assert.equal(r.next_state, "PAUSED");
    assert.equal(r.pause_reason_code, "PAUSED_JUDGE_AUTH_195");
    assert.equal(r.consume_attempt, false);
  });
});

describe("decision_table priority", () => {
  // CRASH takes priority over rc=195
  it("CRASH beats AUTH", () => {
    const r = decideNextState(ctx({ rc: 195, error_class: "CRASH" }));
    assert.equal(r.pause_reason_code, "PAUSED_CRASH");
  });

  // AUTH takes priority over TIMEOUT
  it("AUTH beats TIMEOUT (rc=195 checked before rc=124)", () => {
    const r = decideNextState(ctx({ role: "coder", rc: 195, error_class: "AUTH" }));
    assert.equal(r.pause_reason_code, "PAUSED_CODER_AUTH_195");
  });
});
