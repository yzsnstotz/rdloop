/**
 * decision_table.ts — K2-6 Decision State Machine for rdloop coordinator.
 *
 * Single export: decideNextState(ctx) => DecisionResult
 *
 * Priority order:
 *   1. CRASH
 *   2. rc=195 (AUTH)
 *   3. rc=124 (TIMEOUT) — role-dependent consume + consecutive>=2 → FAILED
 *   4. VERDICT_INVALID
 *   5. VERDICT_INCONSISTENT
 *   6. NEED_USER_INPUT
 *   7. PASS + !gated + thresholds → READY_FOR_REVIEW
 *   8. FAIL + gated → PAUSED_SCORE_GATED
 *   9. FAIL + !gated + !thresholds → PAUSED_SCORE_BELOW_THRESHOLD
 *  10. FAIL + normal → exhaust or continue
 */

export interface DecisionContext {
  role: "coder" | "test" | "judge" | "coordinator";
  rc: number;
  error_class: string;           // "" | "TIMEOUT" | "AUTH" | "CRASH" | "VERDICT_INVALID" | "VERDICT_INCONSISTENT"
  verdict_decision: string;      // "" | "PASS" | "FAIL" | "NEED_USER_INPUT"
  verdict_gated: boolean;
  thresholds_pass: boolean;
  current_attempt: number;
  effective_max_attempts: number;
  consecutive_timeout_count: number;
  consecutive_timeout_key: string;
}

export interface DecisionResult {
  next_state: "RUNNING" | "PAUSED" | "FAILED" | "READY_FOR_REVIEW";
  pause_reason_code: string;
  consume_attempt: boolean;
  last_decision: string;
  questions_for_user: string[];
  message: string;
}

export function decideNextState(ctx: DecisionContext): DecisionResult {
  // 1. CRASH
  if (ctx.error_class === "CRASH") {
    return {
      next_state: "PAUSED",
      pause_reason_code: "PAUSED_CRASH",
      consume_attempt: false,
      last_decision: "NEED_USER_INPUT",
      questions_for_user: ["Coordinator crashed. Please check logs and re-run with --continue."],
      message: "coordinator crash detected",
    };
  }

  // 2. rc=195 (AUTH)
  if (ctx.rc === 195 || ctx.error_class === "AUTH") {
    const code =
      ctx.role === "coder"
        ? "PAUSED_CODER_AUTH_195"
        : ctx.role === "judge"
          ? "PAUSED_JUDGE_AUTH_195"
          : "PAUSED_CODER_AUTH_195";
    return {
      next_state: "PAUSED",
      pause_reason_code: code,
      consume_attempt: false,
      last_decision: "NEED_USER_INPUT",
      questions_for_user: [
        "Authentication failed (rc=195). Check SSH keys / keychain / API tokens.",
      ],
      message: `${ctx.role} auth failure (rc=195)`,
    };
  }

  // 3. rc=124 (TIMEOUT)
  if (ctx.rc === 124 || ctx.error_class === "TIMEOUT") {
    // consecutive >= 2 → FAILED
    if (ctx.consecutive_timeout_count >= 2) {
      return {
        next_state: "FAILED",
        pause_reason_code: "",
        consume_attempt: true,
        last_decision: "FAIL",
        questions_for_user: [],
        message: `${ctx.role} timed out ${ctx.consecutive_timeout_count} consecutive times — marking FAILED`,
      };
    }

    const consume = ctx.role === "test";
    let code: string;
    switch (ctx.role) {
      case "coder":
        code = "PAUSED_CODER_TIMEOUT";
        break;
      case "test":
        code = "PAUSED_TEST_TIMEOUT";
        break;
      case "judge":
        code = "PAUSED_JUDGE_TIMEOUT";
        break;
      default:
        code = "PAUSED_CODER_TIMEOUT";
    }

    return {
      next_state: "PAUSED",
      pause_reason_code: code,
      consume_attempt: consume,
      last_decision: "NEED_USER_INPUT",
      questions_for_user: [
        `${ctx.role} timed out (rc=124). Increase timeout or investigate.`,
      ],
      message: `${ctx.role} timeout`,
    };
  }

  // 4. VERDICT_INVALID
  if (ctx.error_class === "VERDICT_INVALID") {
    return {
      next_state: "PAUSED",
      pause_reason_code: "PAUSED_JUDGE_VERDICT_INVALID",
      consume_attempt: false,
      last_decision: "NEED_USER_INPUT",
      questions_for_user: [
        "Judge returned invalid verdict JSON. Check judge output.",
      ],
      message: "judge verdict invalid",
    };
  }

  // 5. VERDICT_INCONSISTENT
  if (ctx.error_class === "VERDICT_INCONSISTENT") {
    return {
      next_state: "PAUSED",
      pause_reason_code: "PAUSED_JUDGE_VERDICT_INCONSISTENT",
      consume_attempt: false,
      last_decision: "NEED_USER_INPUT",
      questions_for_user: [
        "Judge verdict is internally inconsistent. Please review.",
      ],
      message: "judge verdict inconsistent",
    };
  }

  // 6. NEED_USER_INPUT
  if (ctx.verdict_decision === "NEED_USER_INPUT") {
    return {
      next_state: "PAUSED",
      pause_reason_code: "PAUSED_WAITING_USER_INPUT",
      consume_attempt: false,
      last_decision: "NEED_USER_INPUT",
      questions_for_user: ["Judge requests user input. See verdict for details."],
      message: "judge requests user input",
    };
  }

  // 7. PASS + !gated + thresholds → READY_FOR_REVIEW
  if (ctx.verdict_decision === "PASS" && !ctx.verdict_gated && ctx.thresholds_pass) {
    return {
      next_state: "READY_FOR_REVIEW",
      pause_reason_code: "",
      consume_attempt: false,
      last_decision: "PASS",
      questions_for_user: [],
      message: "All checks passed",
    };
  }

  // 8. FAIL + gated → PAUSED_SCORE_GATED
  if (ctx.verdict_decision === "FAIL" && ctx.verdict_gated) {
    return {
      next_state: "PAUSED",
      pause_reason_code: "PAUSED_SCORE_GATED",
      consume_attempt: true,
      last_decision: "FAIL",
      questions_for_user: [
        "Score is below gated threshold. Review required.",
      ],
      message: "score gated — paused for review",
    };
  }

  // 9. FAIL + !gated + !thresholds → PAUSED_SCORE_BELOW_THRESHOLD
  if (ctx.verdict_decision === "FAIL" && !ctx.verdict_gated && !ctx.thresholds_pass) {
    return {
      next_state: "PAUSED",
      pause_reason_code: "PAUSED_SCORE_BELOW_THRESHOLD",
      consume_attempt: true,
      last_decision: "FAIL",
      questions_for_user: [
        "Score is below threshold. Review and adjust.",
      ],
      message: "score below threshold — paused",
    };
  }

  // 10. FAIL + normal → exhaust or continue
  if (ctx.verdict_decision === "FAIL") {
    if (ctx.current_attempt >= ctx.effective_max_attempts) {
      return {
        next_state: "FAILED",
        pause_reason_code: "",
        consume_attempt: true,
        last_decision: "FAIL",
        questions_for_user: [],
        message: "max attempts reached",
      };
    }
    return {
      next_state: "RUNNING",
      pause_reason_code: "",
      consume_attempt: true,
      last_decision: "FAIL",
      questions_for_user: [],
      message: "advancing to next attempt",
    };
  }

  // Fallback: unknown state → PAUSED
  return {
    next_state: "PAUSED",
    pause_reason_code: "PAUSED_JUDGE_VERDICT_INVALID",
    consume_attempt: false,
    last_decision: "NEED_USER_INPUT",
    questions_for_user: ["Unexpected decision state. Please review."],
    message: `unknown verdict_decision: ${ctx.verdict_decision}`,
  };
}
