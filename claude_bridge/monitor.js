const { spawn } = require('child_process');
const { BridgeIPC } = require('./ipc');
const { detectPermissionPrompt, detectUsageLimit } = require('./patterns');

const APPROVAL_TIMEOUT = parseInt(process.env.BRIDGE_APPROVAL_TIMEOUT || '300', 10) * 1000;
const POLL_INTERVAL = parseInt(process.env.BRIDGE_POLL_INTERVAL || '100', 10);

class ClaudeMonitor {
  constructor(options = {}) {
    this.claudeCmd = options.claudeCmd || process.env.CLAUDE_CMD || 'claude';
    this.claudeArgs = options.claudeArgs || [];
    this.sessionId = options.sessionId || process.env.BRIDGE_SESSION_ID || this._makeSessionId();
    this.ipc = options.ipc || new BridgeIPC(options.bridgeDir);
    this.logFn = options.logFn || console.log;

    this.proc = null;
    this.lineBuffer = [];
    this.exitCode = null;
    this.stopped = false;
    this._pendingApproval = null;
    this._limitDetected = false;
  }

  _makeSessionId() {
    return `session_${Date.now().toString(36)}`;
  }

  _log(msg) {
    this.logFn(`[claude_bridge] ${new Date().toISOString()} ${msg}`);
  }

  start() {
    this._log(`Starting Claude CLI: ${this.claudeCmd} ${this.claudeArgs.join(' ')}`);

    this.ipc.writeState({
      session_id: this.sessionId,
      status: 'running',
      claude_cmd: this.claudeCmd,
      claude_args: this.claudeArgs,
      started_at: new Date().toISOString()
    });

    this.proc = spawn(this.claudeCmd, this.claudeArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    this.proc.stdout.on('data', (chunk) => this._onOutput(chunk, 'stdout'));
    this.proc.stderr.on('data', (chunk) => this._onOutput(chunk, 'stderr'));

    this.proc.on('close', (code) => {
      this.exitCode = code;
      this._log(`Claude CLI exited with code ${code}`);
      this._onExit(code);
    });

    this.proc.on('error', (err) => {
      this._log(`Claude CLI spawn error: ${err.message}`);
      this.ipc.writeState({
        session_id: this.sessionId,
        status: 'error',
        error: err.message
      });
      this.ipc.appendEvent('error', { error: err.message });
    });

    return this;
  }

  async _onOutput(chunk, stream) {
    let text;
    try {
      text = chunk.toString();
    } catch {
      return;
    }

    if (stream === 'stdout') {
      process.stdout.write(text);
    } else {
      process.stderr.write(text);
    }

    const lines = text.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        this.lineBuffer.push(line);
        if (this.lineBuffer.length > 50) {
          this.lineBuffer.shift();
        }
      }
    }

    if (this._pendingApproval || this._limitDetected) return;

    const permResult = detectPermissionPrompt(this.lineBuffer);
    if (permResult.matched) {
      await this._handlePermissionPrompt(permResult);
      return;
    }

    const limitResult = detectUsageLimit(this.lineBuffer);
    if (limitResult.matched) {
      this._limitDetected = true;
      this._handleUsageLimit(limitResult);
    }
  }

  async _handlePermissionPrompt(result) {
    this._pendingApproval = true;
    this._log(`Permission prompt detected (pattern: ${result.pattern})`);

    const requestId = this.ipc.writePermissionRequest(
      result.prompt,
      result.choices,
      result.choiceLabels,
      { session_id: this.sessionId }
    );

    this.ipc.writeState({
      session_id: this.sessionId,
      status: 'waiting_approval',
      pending_request_id: requestId,
      last_prompt: result.prompt
    });

    this._log(`Waiting for approval (request: ${requestId}, timeout: ${APPROVAL_TIMEOUT / 1000}s)`);

    const response = await this.ipc.pollForResponse(requestId, APPROVAL_TIMEOUT, POLL_INTERVAL);

    if (response) {
      this._log(`Received response: ${response.choice}`);
      this._sendToStdin(response.choice);
    } else {
      this._log('Approval timed out — auto-rejecting');
      const defaultReject = result.choices.includes('n') ? 'n' : 'no';
      this._sendToStdin(defaultReject);
      this.ipc.writeResponse(requestId, defaultReject, 'timeout');
      this.ipc.appendEvent('approval_timeout', { id: requestId });
    }

    this.lineBuffer = [];
    this._pendingApproval = false;

    this.ipc.writeState({
      session_id: this.sessionId,
      status: 'running'
    });
  }

  _handleUsageLimit(result) {
    this._log(`Usage limit detected: ${result.message}`);

    const requestId = this.ipc.writeLimitEvent(
      result.message,
      result.nextAvailable,
      { session_id: this.sessionId }
    );

    this.ipc.writeState({
      session_id: this.sessionId,
      status: 'limited',
      limit_message: result.message,
      next_available: result.nextAvailable,
      pending_request_id: requestId
    });

    this.lineBuffer = [];
  }

  _sendToStdin(text) {
    if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
      this.proc.stdin.write(text + '\n');
    }
  }

  async _onExit(code) {
    const state = this.ipc.readState();
    const isLimited = state && state.status === 'limited';

    if (isLimited) {
      this._log('Claude CLI exited due to usage limit — waiting for resume signal');
      this.ipc.appendEvent('exit_limited', { code, session_id: this.sessionId });
      await this._waitForResume();
    } else {
      this.ipc.writeState({
        session_id: this.sessionId,
        status: 'exited',
        exit_code: code
      });
      this.ipc.appendEvent('exit', { code, session_id: this.sessionId });
    }
  }

  async _waitForResume() {
    this._log('Polling for resume signal...');
    const poll = () => {
      if (this.stopped) return;
      const state = this.ipc.readState();
      if (state && state.action === 'resume') {
        this._log('Resume signal received — restarting Claude CLI');
        this.ipc.appendEvent('resume', { session_id: this.sessionId });
        this.lineBuffer = [];
        this._limitDetected = false;

        this.ipc.writeState({
          session_id: this.sessionId,
          status: 'resuming',
          action: null
        });

        const continueArgs = [...this.claudeArgs];
        if (!continueArgs.includes('--continue') && !continueArgs.includes('-c')) {
          continueArgs.push('--continue');
        }
        this.claudeArgs = continueArgs;
        this.start();
        return;
      }

      if (state && state.action === 'cancel') {
        this._log('Cancel signal received — stopping');
        this.ipc.writeState({
          session_id: this.sessionId,
          status: 'exited',
          action: null,
          exit_reason: 'cancelled_by_user'
        });
        this.ipc.appendEvent('cancelled', { session_id: this.sessionId });
        return;
      }

      setTimeout(poll, 2000);
    };
    poll();
  }

  stop() {
    this.stopped = true;
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
    }
  }
}

module.exports = { ClaudeMonitor };
