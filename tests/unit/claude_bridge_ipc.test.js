const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { BridgeIPC } = require('../../claude_bridge/ipc');

let tmpDir;
let ipc;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude_bridge_test_'));
  ipc = new BridgeIPC(tmpDir);
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('BridgeIPC', () => {
  it('creates directory structure on init', () => {
    assert.ok(fs.existsSync(path.join(tmpDir, 'pending')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'responses')));
  });

  it('writePermissionRequest creates pending file', () => {
    const id = ipc.writePermissionRequest('Allow bash?', ['y', 'n'], ['Approve', 'Reject'], { session_id: 'test' });
    assert.ok(id);

    const filepath = path.join(tmpDir, 'pending', `${id}.json`);
    assert.ok(fs.existsSync(filepath));

    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    assert.strictEqual(data.type, 'permission');
    assert.strictEqual(data.prompt, 'Allow bash?');
    assert.deepStrictEqual(data.choices, ['y', 'n']);
  });

  it('writeLimitEvent creates pending file', () => {
    const id = ipc.writeLimitEvent('Usage limit reached', '14:00 UTC', { session_id: 'test' });
    assert.ok(id);

    const filepath = path.join(tmpDir, 'pending', `${id}.json`);
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    assert.strictEqual(data.type, 'usage_limit');
    assert.strictEqual(data.next_available, '14:00 UTC');
  });

  it('writeResponse creates response file and removes pending', () => {
    const reqId = ipc.writePermissionRequest('Allow?', ['y', 'n']);
    assert.ok(fs.existsSync(path.join(tmpDir, 'pending', `${reqId}.json`)));

    ipc.writeResponse(reqId, 'y', 'telegram', '12345');

    assert.ok(fs.existsSync(path.join(tmpDir, 'responses', `${reqId}.json`)));
    assert.ok(!fs.existsSync(path.join(tmpDir, 'pending', `${reqId}.json`)));

    const resp = ipc.readResponse(reqId);
    assert.strictEqual(resp.choice, 'y');
    assert.strictEqual(resp.source, 'telegram');
  });

  it('listPending returns sorted requests', () => {
    const id1 = ipc.writePermissionRequest('First', ['y', 'n']);
    const id2 = ipc.writePermissionRequest('Second', ['y', 'n']);

    const pending = ipc.listPending();
    assert.strictEqual(pending.length, 2);
    assert.strictEqual(pending[0].id, id1);
    assert.strictEqual(pending[1].id, id2);
  });

  it('readState/writeState round-trips', () => {
    ipc.writeState({ session_id: 'test', status: 'running' });
    const state = ipc.readState();
    assert.strictEqual(state.session_id, 'test');
    assert.strictEqual(state.status, 'running');
    assert.ok(state.updated_at);
  });

  it('pollForResponse resolves when response appears', async () => {
    const reqId = ipc.writePermissionRequest('Allow?', ['y', 'n']);

    setTimeout(() => {
      ipc.writeResponse(reqId, 'y', 'test');
    }, 50);

    const resp = await ipc.pollForResponse(reqId, 5000, 20);
    assert.ok(resp);
    assert.strictEqual(resp.choice, 'y');
  });

  it('pollForResponse resolves null on timeout', async () => {
    const resp = await ipc.pollForResponse('nonexistent', 200, 50);
    assert.strictEqual(resp, null);
  });

  it('appendEvent writes to events.jsonl', () => {
    ipc.appendEvent('test_event', { foo: 'bar' });
    const content = fs.readFileSync(path.join(tmpDir, 'events.jsonl'), 'utf8');
    const line = JSON.parse(content.trim());
    assert.strictEqual(line.type, 'test_event');
    assert.strictEqual(line.foo, 'bar');
  });

  it('readResponse returns null for missing file', () => {
    const resp = ipc.readResponse('nonexistent');
    assert.strictEqual(resp, null);
  });
});
