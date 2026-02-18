const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { computeFingerprint, formatNotification } = require('../../openclaw/notifier');

describe('notifier computeFingerprint', () => {
  it('same task produces same fingerprint', () => {
    const task = { task_id: 'test_001', state: 'RUNNING', current_attempt: 1, state_version: 1 };
    const fp1 = computeFingerprint(task);
    const fp2 = computeFingerprint(task);
    assert.equal(fp1, fp2);
  });

  it('different state produces different fingerprint', () => {
    const t1 = { task_id: 'test_001', state: 'RUNNING', current_attempt: 1, state_version: 1 };
    const t2 = { task_id: 'test_001', state: 'PAUSED', current_attempt: 1, state_version: 2 };
    assert.notEqual(computeFingerprint(t1), computeFingerprint(t2));
  });

  it('different attempt produces different fingerprint', () => {
    const t1 = { task_id: 'test_001', state: 'RUNNING', current_attempt: 1, state_version: 1 };
    const t2 = { task_id: 'test_001', state: 'RUNNING', current_attempt: 2, state_version: 2 };
    assert.notEqual(computeFingerprint(t1), computeFingerprint(t2));
  });

  it('handles missing fields gracefully', () => {
    const fp = computeFingerprint({});
    assert.ok(typeof fp === 'string');
    assert.equal(fp.length, 16);
  });
});

describe('notifier formatNotification', () => {
  it('formats PAUSED notification', () => {
    const msg = formatNotification({
      task_id: 'task_001',
      state: 'PAUSED',
      pause_reason_code: 'PAUSED_CODER_TIMEOUT',
      current_attempt: 2,
      max_attempts: 3,
      message: 'Coder timed out'
    });
    assert.ok(msg.includes('task_001'));
    assert.ok(msg.includes('PAUSED'));
    assert.ok(msg.includes('PAUSED_CODER_TIMEOUT'));
    assert.ok(msg.includes('2/3'));
  });

  it('escapes HTML entities', () => {
    const msg = formatNotification({
      task_id: 'test<script>',
      state: 'RUNNING',
      message: 'a & b < c'
    });
    assert.ok(msg.includes('test&lt;script&gt;'));
    assert.ok(!msg.includes('<script>'));
  });
});
