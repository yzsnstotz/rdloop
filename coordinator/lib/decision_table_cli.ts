#!/usr/bin/env node
/**
 * decision_table_cli.ts — CLI wrapper for bash coordinator.
 *
 * Usage:
 *   node decision_table_cli.js '<json_context>'
 *
 * Reads a DecisionContext JSON from argv[2], calls decideNextState,
 * prints DecisionResult JSON to stdout.
 */

import { decideNextState, DecisionContext } from "./decision_table";

function main(): void {
  const raw = process.argv[2];
  if (!raw) {
    process.stderr.write("Usage: node decision_table_cli.js '<json>'\n");
    process.exit(1);
  }

  const ctx: DecisionContext = JSON.parse(raw);

  // Apply defaults for optional fields
  ctx.error_class = ctx.error_class ?? "";
  ctx.verdict_decision = ctx.verdict_decision ?? "";
  ctx.verdict_gated = ctx.verdict_gated ?? false;
  ctx.thresholds_pass = ctx.thresholds_pass ?? true;
  ctx.consecutive_timeout_count = ctx.consecutive_timeout_count ?? 0;
  ctx.consecutive_timeout_key = ctx.consecutive_timeout_key ?? "";

  const result = decideNextState(ctx);
  process.stdout.write(JSON.stringify(result) + "\n");
}

main();
