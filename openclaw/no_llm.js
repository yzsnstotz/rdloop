const fs = require('fs');
const path = require('path');
const config = require('./config');

const AUDIT_DIR = path.join(config.OUT_DIR, '_audit');

function ensureAuditDir() {
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  }
}

function assertNoLlm() {
  ensureAuditDir();
  const entry = {
    ts: new Date().toISOString(),
    module: 'openclaw',
    NO_LLM: config.NO_LLM,
    pid: process.pid
  };

  if (config.NO_LLM !== true) {
    // Violation — write and throw
    const violation = { ...entry, violation: 'NO_LLM is not true' };
    fs.appendFileSync(
      path.join(AUDIT_DIR, 'no_llm_violations.jsonl'),
      JSON.stringify(violation) + '\n'
    );
    throw new Error('NO_LLM_VIOLATION: config.NO_LLM is not true');
  }

  // Write startup assert
  fs.writeFileSync(
    path.join(AUDIT_DIR, 'no_llm_startup_assert.json'),
    JSON.stringify(entry, null, 2)
  );
}

function guardLlmCall(context) {
  ensureAuditDir();
  const violation = {
    ts: new Date().toISOString(),
    module: 'openclaw',
    violation: 'LLM call attempted',
    context: context || 'unknown',
    pid: process.pid
  };
  fs.appendFileSync(
    path.join(AUDIT_DIR, 'no_llm_violations.jsonl'),
    JSON.stringify(violation) + '\n'
  );
  throw new Error('NO_LLM_VIOLATION: LLM calls are forbidden in openclaw');
}

module.exports = { assertNoLlm, guardLlmCall };
