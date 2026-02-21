const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_BRIDGE_DIR = path.resolve(__dirname, '..', 'out', 'claude_bridge');

class BridgeIPC {
  constructor(bridgeDir) {
    this.bridgeDir = bridgeDir || process.env.BRIDGE_DIR || DEFAULT_BRIDGE_DIR;
    this.pendingDir = path.join(this.bridgeDir, 'pending');
    this.responsesDir = path.join(this.bridgeDir, 'responses');
    this.statePath = path.join(this.bridgeDir, 'state.json');
    this.eventsPath = path.join(this.bridgeDir, 'events.jsonl');
    this._ensureDirs();
  }

  _ensureDirs() {
    for (const dir of [this.bridgeDir, this.pendingDir, this.responsesDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  _generateId() {
    return crypto.randomUUID();
  }

  _atomicWrite(filepath, data) {
    const tmp = filepath + '.tmp.' + crypto.randomBytes(4).toString('hex');
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmp, filepath);
    } catch (err) {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
  }

  writePermissionRequest(prompt, choices, choiceLabels, context) {
    const id = this._generateId();
    const req = {
      id,
      type: 'permission',
      prompt: String(prompt).slice(0, 2000),
      choices: choices || ['y', 'n'],
      choice_labels: choiceLabels || ['Approve', 'Reject'],
      context: context || {},
      created_at: new Date().toISOString()
    };
    this._atomicWrite(path.join(this.pendingDir, `${id}.json`), req);
    this.appendEvent('permission_request', { id, prompt: req.prompt });
    return id;
  }

  writeLimitEvent(message, nextAvailable, context) {
    const id = this._generateId();
    const evt = {
      id,
      type: 'usage_limit',
      message: String(message).slice(0, 2000),
      next_available: nextAvailable || null,
      context: context || {},
      created_at: new Date().toISOString()
    };
    this._atomicWrite(path.join(this.pendingDir, `${id}.json`), evt);
    this.appendEvent('usage_limit', { id, message: evt.message, next_available: evt.next_available });
    return id;
  }

  readResponse(requestId) {
    const filepath = path.join(this.responsesDir, `${requestId}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      return data;
    } catch {
      return null;
    }
  }

  writeResponse(requestId, choice, source, chatId) {
    const resp = {
      id: requestId,
      choice,
      responded_at: new Date().toISOString(),
      source: source || 'telegram',
      chat_id: chatId || null
    };
    this._atomicWrite(path.join(this.responsesDir, `${requestId}.json`), resp);
    this.appendEvent('response', { id: requestId, choice });
    this.removePending(requestId);
    return resp;
  }

  removePending(requestId) {
    const filepath = path.join(this.pendingDir, `${requestId}.json`);
    try { fs.unlinkSync(filepath); } catch {}
  }

  listPending() {
    try {
      return fs.readdirSync(this.pendingDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            return JSON.parse(fs.readFileSync(path.join(this.pendingDir, f), 'utf8'));
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    } catch {
      return [];
    }
  }

  readState() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return null;
    }
  }

  writeState(state) {
    this._atomicWrite(this.statePath, {
      ...state,
      updated_at: new Date().toISOString()
    });
  }

  appendEvent(type, data) {
    const entry = {
      ts: new Date().toISOString(),
      type,
      ...data
    };
    try {
      fs.appendFileSync(this.eventsPath, JSON.stringify(entry) + '\n');
    } catch {}
  }

  async pollForResponse(requestId, timeoutMs, intervalMs) {
    const timeout = timeoutMs || 300000;
    const interval = intervalMs || 100;
    const deadline = Date.now() + timeout;

    return new Promise((resolve) => {
      const check = () => {
        const resp = this.readResponse(requestId);
        if (resp) {
          resolve(resp);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(null);
          return;
        }
        setTimeout(check, interval);
      };
      check();
    });
  }
}

module.exports = { BridgeIPC };
