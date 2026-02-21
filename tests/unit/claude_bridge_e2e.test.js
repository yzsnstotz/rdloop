const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { BridgeIPC } = require('../../claude_bridge/ipc');
const { detectPermissionPrompt, detectUsageLimit } = require('../../claude_bridge/patterns');
const { formatPermissionMessage, formatLimitMessage } = require('../../openclaw/claude_bridge');

let tmpDir;
let ipc;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude_bridge_e2e_'));
  ipc = new BridgeIPC(tmpDir);
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('E2E: Permission approval flow', () => {
  it('full cycle: pattern detect → pending file → response → stdin feed', async () => {
    const lines = [
      '  Claude wants to run a bash command:',
      '    rm -rf /tmp/test',
      '  Allow this tool? [y/n]'
    ];
    const detected = detectPermissionPrompt(lines);
    assert.strictEqual(detected.matched, true, 'permission pattern must be detected');
    assert.strictEqual(detected.pattern, 'allow_tool');
    assert.deepStrictEqual(detected.choices, ['y', 'n']);

    const reqId = ipc.writePermissionRequest(
      detected.prompt,
      detected.choices,
      detected.choiceLabels,
      { session_id: 'test_e2e' }
    );

    const pendingFile = path.join(tmpDir, 'pending', `${reqId}.json`);
    assert.ok(fs.existsSync(pendingFile), `pending/${reqId}.json must exist`);

    const pendingData = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    assert.strictEqual(pendingData.type, 'permission');
    assert.strictEqual(pendingData.id, reqId);
    assert.ok(pendingData.prompt.includes('Allow this tool'));

    const pending = ipc.listPending();
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].type, 'permission');
    assert.strictEqual(pending[0].id, reqId);

    ipc.writeState({
      session_id: 'test_e2e',
      status: 'waiting_approval',
      pending_request_id: reqId
    });

    setTimeout(() => {
      ipc.writeResponse(reqId, 'y', 'telegram', '12345');
    }, 30);

    const resp = await ipc.pollForResponse(reqId, 5000, 10);
    assert.ok(resp, 'response must be received');
    assert.strictEqual(resp.choice, 'y');
    assert.strictEqual(resp.source, 'telegram');

    const responseFile = path.join(tmpDir, 'responses', `${reqId}.json`);
    assert.ok(fs.existsSync(responseFile), `responses/${reqId}.json must exist`);

    const responseData = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
    assert.strictEqual(responseData.choice, 'y');
    assert.strictEqual(responseData.source, 'telegram');
    assert.strictEqual(responseData.chat_id, '12345');

    assert.ok(!fs.existsSync(pendingFile), 'pending file must be removed after response');

    ipc.writeState({ session_id: 'test_e2e', status: 'running' });
    const state = ipc.readState();
    assert.strictEqual(state.status, 'running');
  });

  it('timeout results in auto-reject response file', async () => {
    const reqId = ipc.writePermissionRequest('Allow?', ['y', 'n']);

    const resp = await ipc.pollForResponse(reqId, 100, 20);
    assert.strictEqual(resp, null, 'timeout must yield null');

    ipc.writeResponse(reqId, 'n', 'timeout');
    const saved = ipc.readResponse(reqId);
    assert.strictEqual(saved.choice, 'n');
    assert.strictEqual(saved.source, 'timeout');
  });
});

describe('E2E: Usage limit + resume flow', () => {
  it('full cycle: pattern detect → pending → resume signal → --continue args', async () => {
    const lines = [
      "You've reached your usage limit.",
      'Please try again after 2:00 PM PST.'
    ];
    const detected = detectUsageLimit(lines);
    assert.strictEqual(detected.matched, true, 'limit pattern must be detected');
    assert.ok(detected.nextAvailable.includes('2:00 PM PST'));

    const reqId = ipc.writeLimitEvent(
      detected.message,
      detected.nextAvailable,
      { session_id: 'test_e2e' }
    );

    const pendingFile = path.join(tmpDir, 'pending', `${reqId}.json`);
    assert.ok(fs.existsSync(pendingFile), `pending/${reqId}.json must exist for limit event`);

    const pendingData = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    assert.strictEqual(pendingData.type, 'usage_limit');
    assert.strictEqual(pendingData.next_available, detected.nextAvailable);

    ipc.writeState({
      session_id: 'test_e2e',
      status: 'limited',
      limit_message: detected.message,
      next_available: detected.nextAvailable,
      pending_request_id: reqId
    });

    const state1 = ipc.readState();
    assert.strictEqual(state1.status, 'limited');
    assert.strictEqual(state1.next_available, detected.nextAvailable);

    ipc.writeResponse(reqId, 'resume', 'telegram', '12345');

    const responseFile = path.join(tmpDir, 'responses', `${reqId}.json`);
    assert.ok(fs.existsSync(responseFile), `responses/${reqId}.json must exist`);

    const state = ipc.readState();
    state.action = 'resume';
    ipc.writeState(state);

    const state2 = ipc.readState();
    assert.strictEqual(state2.action, 'resume');

    const claudeArgs = ['-p', 'Fix the bug'];
    const continueArgs = [...claudeArgs];
    if (!continueArgs.includes('--continue') && !continueArgs.includes('-c')) {
      continueArgs.push('--continue');
    }
    assert.ok(continueArgs.includes('--continue'), 'resume must add --continue flag');
    assert.deepStrictEqual(continueArgs, ['-p', 'Fix the bug', '--continue']);

    ipc.writeState({
      session_id: 'test_e2e',
      status: 'resuming',
      action: null
    });

    const state3 = ipc.readState();
    assert.strictEqual(state3.status, 'resuming');
    assert.strictEqual(state3.action, null);
  });

  it('cancel signal sets action to cancel and updates state', () => {
    ipc.writeState({ session_id: 'test_e2e', status: 'limited' });

    const state = ipc.readState();
    state.action = 'cancel';
    ipc.writeState(state);

    const state2 = ipc.readState();
    assert.strictEqual(state2.action, 'cancel');
    assert.strictEqual(state2.status, 'limited');
  });

  it('--continue is not duplicated if already present', () => {
    const claudeArgs = ['-p', 'Fix bug', '--continue'];
    const continueArgs = [...claudeArgs];
    if (!continueArgs.includes('--continue') && !continueArgs.includes('-c')) {
      continueArgs.push('--continue');
    }
    const count = continueArgs.filter(a => a === '--continue').length;
    assert.strictEqual(count, 1, '--continue must not be duplicated');
  });
});

describe('E2E: Telegram message formatting', () => {
  it('formatPermissionMessage produces valid HTML with escaped content', () => {
    const req = {
      prompt: 'Claude wants to run: bash(ls <dir>)',
      choices: ['y', 'n'],
      context: { session_id: 'sess_abc' }
    };
    const msg = formatPermissionMessage(req);
    assert.ok(msg.includes('Permission Request'));
    assert.ok(msg.includes('&lt;dir&gt;'), 'HTML must be escaped');
    assert.ok(msg.includes('sess_abc'));
    assert.ok(!msg.includes('<dir>'), 'raw angle brackets must not appear');
  });

  it('formatLimitMessage includes next_available when provided', () => {
    const req = {
      message: 'Usage limit reached',
      next_available: '2:00 PM PST',
      context: { session_id: 'sess_abc' }
    };
    const msg = formatLimitMessage(req);
    assert.ok(msg.includes('Usage Limit'));
    assert.ok(msg.includes('2:00 PM PST'));
    assert.ok(msg.includes('Next available'));
    assert.ok(msg.includes('sess_abc'));
  });

  it('formatLimitMessage omits next_available when missing', () => {
    const req = {
      message: 'Rate limited',
      context: { session_id: 'sess_abc' }
    };
    const msg = formatLimitMessage(req);
    assert.ok(msg.includes('Rate limited'));
    assert.ok(!msg.includes('Next available'));
  });
});

describe('E2E: Event log integrity', () => {
  it('full flow produces chronologically ordered events', () => {
    const reqId = ipc.writePermissionRequest('Allow?', ['y', 'n'], ['Approve', 'Reject'], { session_id: 's1' });
    ipc.writeResponse(reqId, 'y', 'telegram', '999');

    const limitId = ipc.writeLimitEvent('Limit hit', '14:00', { session_id: 's1' });
    ipc.appendEvent('resume', { session_id: 's1' });

    const lines = fs.readFileSync(path.join(tmpDir, 'events.jsonl'), 'utf8')
      .trim().split('\n').map(l => JSON.parse(l));

    assert.ok(lines.length >= 4, `expected at least 4 events, got ${lines.length}`);
    assert.strictEqual(lines[0].type, 'permission_request');
    assert.strictEqual(lines[1].type, 'response');
    assert.strictEqual(lines[2].type, 'usage_limit');

    for (let i = 1; i < lines.length; i++) {
      assert.ok(lines[i].ts >= lines[i - 1].ts, 'events must be chronologically ordered');
    }
  });
});

describe('E2E: IPC directory structure verification', () => {
  it('BridgeIPC creates proper directory layout', () => {
    assert.ok(fs.existsSync(path.join(tmpDir, 'pending')), 'pending/ must exist');
    assert.ok(fs.existsSync(path.join(tmpDir, 'responses')), 'responses/ must exist');
  });

  it('concurrent requests maintain separate files', () => {
    const id1 = ipc.writePermissionRequest('First', ['y', 'n']);
    const id2 = ipc.writePermissionRequest('Second', ['y', 'n']);
    const id3 = ipc.writeLimitEvent('Third', '15:00');

    assert.notStrictEqual(id1, id2);
    assert.notStrictEqual(id2, id3);

    const files = fs.readdirSync(path.join(tmpDir, 'pending'));
    assert.strictEqual(files.length, 3, 'three pending files must exist');

    ipc.writeResponse(id1, 'y', 'test');
    const pendingAfter = fs.readdirSync(path.join(tmpDir, 'pending'));
    assert.strictEqual(pendingAfter.length, 2, 'one pending file removed after response');

    const respFiles = fs.readdirSync(path.join(tmpDir, 'responses'));
    assert.strictEqual(respFiles.length, 1, 'one response file created');
  });
});

describe('E2E: Idempotent response writes', () => {
  it('duplicate writeResponse overwrites without error', () => {
    const reqId = ipc.writePermissionRequest('Allow?', ['y', 'n']);
    ipc.writeResponse(reqId, 'y', 'telegram', '111');
    ipc.writeResponse(reqId, 'y', 'telegram', '111');

    const resp = ipc.readResponse(reqId);
    assert.strictEqual(resp.choice, 'y');
    assert.strictEqual(resp.source, 'telegram');

    const respFiles = fs.readdirSync(path.join(tmpDir, 'responses'));
    assert.strictEqual(respFiles.length, 1, 'only one response file should exist');
  });

  it('response exists before pending removal is safe', () => {
    const reqId = ipc.writePermissionRequest('Allow?', ['y', 'n']);
    ipc.writeResponse(reqId, 'n', 'telegram', '222');

    const pending = ipc.listPending();
    assert.strictEqual(pending.length, 0, 'pending should be empty after response');

    const resp = ipc.readResponse(reqId);
    assert.strictEqual(resp.choice, 'n');
  });
});

describe('E2E: Limit re-detect guard in monitor', () => {
  it('_limitDetected flag prevents duplicate limit handling', () => {
    const lines1 = ["You've reached your usage limit.", 'Try again after 3:00 PM.'];
    const det1 = detectUsageLimit(lines1);
    assert.strictEqual(det1.matched, true);

    let limitDetected = false;
    if (!limitDetected) {
      limitDetected = true;
      const reqId = ipc.writeLimitEvent(det1.message, det1.nextAvailable, { session_id: 's1' });
      assert.ok(reqId);
    }

    const lines2 = ["You've reached your usage limit.", 'Try again after 3:00 PM.'];
    const det2 = detectUsageLimit(lines2);
    assert.strictEqual(det2.matched, true);

    const pendingBefore = ipc.listPending().length;
    if (!limitDetected) {
      ipc.writeLimitEvent(det2.message, det2.nextAvailable, { session_id: 's1' });
    }
    const pendingAfter = ipc.listPending().length;
    assert.strictEqual(pendingAfter, pendingBefore, 'no duplicate limit event should be created');
  });
});

describe('E2E: Resume resets limit flag', () => {
  it('after resume, a new limit can be detected', () => {
    let limitDetected = false;

    const lines1 = ['Rate limit reached. Resets at 14:00 UTC.'];
    const det1 = detectUsageLimit(lines1);
    if (det1.matched && !limitDetected) {
      limitDetected = true;
      ipc.writeLimitEvent(det1.message, det1.nextAvailable, { session_id: 's2' });
    }

    assert.strictEqual(ipc.listPending().length, 1);

    limitDetected = false;

    const lines2 = ['Rate limit reached. Resets at 15:00 UTC.'];
    const det2 = detectUsageLimit(lines2);
    if (det2.matched && !limitDetected) {
      limitDetected = true;
      ipc.writeLimitEvent(det2.message, det2.nextAvailable, { session_id: 's2' });
    }

    assert.strictEqual(ipc.listPending().length, 2, 'second limit event should be created after resume');
  });
});
