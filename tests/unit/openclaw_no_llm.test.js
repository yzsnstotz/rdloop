const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Create a temp OUT_DIR for each test
let tmpDir;
let origEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw_test_'));
  origEnv = process.env.RDLOOP_OUT_DIR;
  process.env.RDLOOP_OUT_DIR = tmpDir;
  // Clear module cache so config picks up new env
  delete require.cache[require.resolve('../../openclaw/config')];
  delete require.cache[require.resolve('../../openclaw/no_llm')];
});

afterEach(() => {
  if (origEnv !== undefined) {
    process.env.RDLOOP_OUT_DIR = origEnv;
  } else {
    delete process.env.RDLOOP_OUT_DIR;
  }
  // Clean up
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});

describe('no_llm', () => {
  it('assertNoLlm writes audit file on success', () => {
    const { assertNoLlm } = require('../../openclaw/no_llm');
    assertNoLlm();
    const auditFile = path.join(tmpDir, '_audit', 'no_llm_startup_assert.json');
    assert.ok(fs.existsSync(auditFile), 'audit file should exist');
    const data = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
    assert.equal(data.NO_LLM, true);
    assert.equal(data.module, 'openclaw');
    assert.ok(data.pid > 0);
  });

  it('guardLlmCall always throws', () => {
    const { guardLlmCall } = require('../../openclaw/no_llm');
    assert.throws(
      () => guardLlmCall('test context'),
      { message: /NO_LLM_VIOLATION/ }
    );
    const violationsFile = path.join(tmpDir, '_audit', 'no_llm_violations.jsonl');
    assert.ok(fs.existsSync(violationsFile), 'violations file should exist');
    const lines = fs.readFileSync(violationsFile, 'utf8').trim().split('\n');
    assert.ok(lines.length >= 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.context, 'test context');
  });
});
