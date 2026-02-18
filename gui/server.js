const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = 17333;
const OUT_DIR = path.resolve(__dirname, '..', 'out');
const COORDINATOR = path.resolve(__dirname, '..', 'coordinator', 'run_task.sh');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: validate taskId — alphanumeric, underscore, hyphen only (C0-2)
const VALID_TASK_ID = /^[A-Za-z0-9_-]+$/;
function isValidTaskId(taskId) {
  return VALID_TASK_ID.test(taskId);
}

// Middleware: validate taskId param and guard path traversal (C0-2)
function validateTaskId(req, res, next) {
  const taskId = req.params.taskId;
  if (!isValidTaskId(taskId)) {
    return res.status(400).json({ error: 'Invalid task_id format' });
  }
  const resolved = path.resolve(OUT_DIR, taskId);
  if (!resolved.startsWith(OUT_DIR + path.sep)) {
    return res.status(400).json({ error: 'Invalid task_id: path traversal detected' });
  }
  next();
}

// Helper: safe JSON read
function readJSON(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch { return null; }
}

// Helper: safe file read
function readFile(filepath, maxLines) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    if (maxLines) {
      const lines = content.split('\n');
      return lines.slice(-maxLines).join('\n');
    }
    return content;
  } catch { return null; }
}

// Helper: read events.jsonl with half-line tolerance (K3-6)
function readEvents(filepath, tail) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const rawLines = content.split('\n').filter(l => l.trim());
    const parsed = [];
    for (const line of rawLines) {
      try { parsed.push(JSON.parse(line)); } catch { /* drop half-line */ }
    }
    if (typeof tail === 'number' && tail > 0) {
      return parsed.slice(-tail);
    }
    return parsed;
  } catch { return []; }
}

// Helper: map READY -> READY_FOR_REVIEW (5.4 compat)
function normalizeState(state) {
  if (state === 'READY') return 'READY_FOR_REVIEW';
  return state;
}

// Helper: state rank for cursor-based pagination ordering
function stateRank(state) {
  switch (normalizeState(state)) {
    case 'RUNNING':          return 0;
    case 'PAUSED':           return 1;
    case 'READY_FOR_REVIEW': return 2;
    case 'FAILED':           return 3;
    default:                 return 4;
  }
}

// Helper: encode/decode cursor
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function decodeCursor(str) {
  try {
    return JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
  } catch { return null; }
}

// Helper: compute etag for a file (K4-1)
function computeFileEtag(filepath) {
  try {
    const stat = fs.statSync(filepath);
    const raw = `${filepath}|${stat.mtimeMs}|${stat.size}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  } catch { return null; }
}

// GET /api/tasks — cursor-based pagination (5.1)
app.get('/api/tasks', (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 100);
    const cursorStr = req.query.cursor || null;
    const cursor = cursorStr ? decodeCursor(cursorStr) : null;

    const dirs = fs.readdirSync(OUT_DIR).filter(d => {
      if (!isValidTaskId(d)) return false;
      const p = path.join(OUT_DIR, d);
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    });

    let tasks = dirs.map(taskId => {
      const status = readJSON(path.join(OUT_DIR, taskId, 'status.json'));
      const rawState = status?.state || 'UNKNOWN';
      const state = normalizeState(rawState);
      return {
        task_id: taskId,
        state,
        current_attempt: status?.current_attempt || 0,
        last_decision: status?.last_decision || '',
        message: status?.message || '',
        updated_at: status?.updated_at || '',
        _rank: stateRank(state)
      };
    });

    // Sort: state_rank ASC, updated_at DESC, task_id ASC
    tasks.sort((a, b) => {
      if (a._rank !== b._rank) return a._rank - b._rank;
      if (a.updated_at !== b.updated_at) return (b.updated_at || '').localeCompare(a.updated_at || '');
      return a.task_id.localeCompare(b.task_id);
    });

    // Apply cursor: skip past cursor position
    if (cursor) {
      const idx = tasks.findIndex(t =>
        t._rank === cursor.state_rank &&
        t.updated_at === cursor.updated_at &&
        t.task_id === cursor.task_id
      );
      if (idx >= 0) {
        tasks = tasks.slice(idx + 1);
      }
    }

    // Take limit + 1 to determine if there's a next page
    const page = tasks.slice(0, limit);
    const hasMore = tasks.length > limit;

    // Build next_cursor
    let next_cursor = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      next_cursor = encodeCursor({
        state_rank: last._rank,
        updated_at: last.updated_at,
        task_id: last.task_id
      });
    }

    // Strip internal _rank
    const items = page.map(({ _rank, ...rest }) => rest);

    res.json({ items, next_cursor });
  } catch (err) {
    res.json({ items: [], next_cursor: null, error: err.message });
  }
});

// GET /api/tasks/:id/events — events with tail support (5.2)
app.get('/api/tasks/:taskId/events', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);
  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const tail = req.query.tail ? parseInt(req.query.tail, 10) : undefined;
  const events = readEvents(path.join(taskDir, 'events.jsonl'), tail);
  res.json({ events });
});

// GET /api/task/:taskId — full task detail
app.get('/api/task/:taskId', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);

  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const taskJson = readJSON(path.join(taskDir, 'task.json'));
  const status = readJSON(path.join(taskDir, 'status.json'));
  if (status && status.state) status.state = normalizeState(status.state);
  const finalSummary = readJSON(path.join(taskDir, 'final_summary.json'));
  const events = readEvents(path.join(taskDir, 'events.jsonl'));

  // Scan attempts
  const attempts = [];
  try {
    const entries = fs.readdirSync(taskDir).filter(d => d.startsWith('attempt_')).sort();
    for (const dir of entries) {
      const attDir = path.join(taskDir, dir);
      const testRc = readFile(path.join(attDir, 'test', 'rc.txt'));
      const diffStat = readFile(path.join(attDir, 'git', 'diff.stat'));
      const verdict = readJSON(path.join(attDir, 'judge', 'verdict.json'));
      attempts.push({
        name: dir,
        test_rc: testRc ? testRc.trim() : null,
        diff_stat: diffStat,
        judge_decision: verdict?.decision || null
      });
    }
  } catch {}

  res.json({
    task: taskJson,
    status,
    final_summary: finalSummary,
    attempts,
    timeline: events
  });
});

// GET /api/task/:taskId/log/:logName — live log with etag/304 (K4-1)
app.get('/api/task/:taskId/log/:logName', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const logName = req.params.logName;
  // Only allow known log file names
  const allowedLogs = ['run.log', 'coordinator.log'];
  if (!allowedLogs.includes(logName)) {
    return res.status(400).json({ error: 'Unknown log name' });
  }
  const logPath = path.join(OUT_DIR, taskId, 'gui', logName);
  const etag = computeFileEtag(logPath);
  if (!etag) {
    return res.status(404).json({ error: 'Log not found' });
  }
  if (req.headers['if-none-match'] === `"${etag}"`) {
    return res.status(304).end();
  }
  const tail = req.query.tail ? parseInt(req.query.tail, 10) : undefined;
  const content = readFile(logPath, tail);
  if (content === null) {
    return res.status(404).json({ error: 'Log not found' });
  }
  res.set('ETag', `"${etag}"`);
  res.type('text/plain').send(content);
});

// GET /api/task/:taskId/attempt/:n — attempt detail
app.get('/api/task/:taskId/attempt/:n', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const n = parseInt(req.params.n, 10);
  const pad = String(n).padStart(3, '0');
  const attDir = path.join(OUT_DIR, taskId, `attempt_${pad}`);

  if (!fs.existsSync(attDir)) {
    return res.status(404).json({ error: 'Attempt not found' });
  }

  res.json({
    evidence: readJSON(path.join(attDir, 'evidence.json')),
    verdict: readJSON(path.join(attDir, 'judge', 'verdict.json')),
    metrics: readJSON(path.join(attDir, 'metrics.json')),
    test_rc: readFile(path.join(attDir, 'test', 'rc.txt'))?.trim() || null,
    test_log: readFile(path.join(attDir, 'test', 'stdout.log'), 400),
    diff_stat: readFile(path.join(attDir, 'git', 'diff.stat')),
    instruction: readFile(path.join(attDir, 'coder', 'instruction.txt')),
    env: readJSON(path.join(attDir, 'env.json'))
  });
});

// POST /api/task/:taskId/control — write control.json
app.post('/api/task/:taskId/control', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);

  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const { action, payload } = req.body;
  const control = {
    action: action || 'PAUSE',
    payload: payload || {},
    nonce: crypto.randomUUID(),
    created_at: new Date().toISOString()
  };

  fs.writeFileSync(path.join(taskDir, 'control.json'), JSON.stringify(control, null, 2));
  res.json({ ok: true, nonce: control.nonce });
});

// POST /api/task/:taskId/run — trigger coordinator
app.post('/api/task/:taskId/run', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);
  const force = req.query.force === '1';

  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Check lockdir (§13.1)
  const lockDir = path.join(taskDir, '.lockdir');
  if (!force && fs.existsSync(lockDir)) {
    return res.status(409).json({ error: 'Task is already running (lockdir exists)', hint: 'Use ?force=1 to force' });
  }

  // Spawn coordinator
  const guiDir = path.join(taskDir, 'gui');
  if (!fs.existsSync(guiDir)) fs.mkdirSync(guiDir, { recursive: true });

  const logFile = path.join(guiDir, 'run.log');
  const logFd = fs.openSync(logFile, 'a');

  const child = spawn('bash', [COORDINATOR, '--continue', taskId], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: path.resolve(__dirname, '..')
  });

  fs.writeFileSync(path.join(guiDir, 'runner.pid'), String(child.pid));
  child.unref();

  res.json({ ok: true, pid: child.pid });
});

// ================================================================
// API extensions for OpenClaw Telegram integration (Epic A)
// ================================================================

const START_TIME = Date.now();
const AUDIT_DIR = path.join(OUT_DIR, '_audit');

// Helper: ensure audit dir exists and append to audit log (K7-3)
function auditLog(entry) {
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(path.join(AUDIT_DIR, 'gui_actions.jsonl'), line);
  } catch { /* best effort */ }
}

// GET /api/health — uptime + task count
app.get('/api/health', (req, res) => {
  try {
    let taskCount = 0;
    if (fs.existsSync(OUT_DIR)) {
      const dirs = fs.readdirSync(OUT_DIR).filter(d => {
        if (!isValidTaskId(d)) return false;
        try { return fs.statSync(path.join(OUT_DIR, d)).isDirectory(); } catch { return false; }
      });
      taskCount = dirs.length;
    }
    res.json({
      status: 'ok',
      uptime_ms: Date.now() - START_TIME,
      task_count: taskCount
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// GET /api/tasks/:taskId/status — status.json content (normalized)
app.get('/api/tasks/:taskId/status', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);
  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const status = readJSON(path.join(taskDir, 'status.json'));
  if (!status) {
    return res.status(404).json({ error: 'status.json not found' });
  }
  if (status.state) status.state = normalizeState(status.state);
  res.json(status);
});

// POST /api/tasks/:taskId/runtime_overrides — atomic write runtime_overrides.json + audit
app.post('/api/tasks/:taskId/runtime_overrides', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);
  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const { overrides, request_id } = req.body || {};
  if (!request_id || typeof request_id !== 'string') {
    return res.status(400).json({ error: 'request_id is required' });
  }
  if (!overrides || typeof overrides !== 'object') {
    return res.status(400).json({ error: 'overrides object is required' });
  }
  if (overrides.max_attempts !== undefined) {
    const ma = overrides.max_attempts;
    if (!Number.isInteger(ma) || ma < 1 || ma > 10) {
      return res.status(400).json({ error: 'max_attempts must be integer in [1, 10]' });
    }
  }

  const payload = {
    overrides,
    request_id,
    written_at: new Date().toISOString()
  };
  fs.writeFileSync(path.join(taskDir, 'runtime_overrides.json'), JSON.stringify(payload, null, 2));

  auditLog({
    actor: 'gui',
    source: 'http',
    action: 'runtime_overrides',
    task_id: taskId,
    request_id,
    payload: overrides
  });

  res.json({ ok: true, request_id });
});

// POST /api/tasks/:taskId/user_input — append to user_input.jsonl + audit
app.post('/api/tasks/:taskId/user_input', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);
  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const { text, request_id } = req.body || {};
  if (!request_id || typeof request_id !== 'string') {
    return res.status(400).json({ error: 'request_id is required' });
  }
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }

  // Dedup: check request_id in last 100 lines (A5-4)
  const inputFile = path.join(taskDir, 'user_input.jsonl');
  try {
    if (fs.existsSync(inputFile)) {
      const content = fs.readFileSync(inputFile, 'utf8');
      const lines = content.split('\n').filter(l => l.trim()).slice(-100);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.request_id === request_id) {
            return res.json({ ok: true, request_id, deduplicated: true });
          }
        } catch { /* skip malformed lines */ }
      }
    }
  } catch { /* if read fails, proceed */ }

  const entry = {
    ts: new Date().toISOString(),
    text,
    request_id
  };
  fs.appendFileSync(inputFile, JSON.stringify(entry) + '\n');

  auditLog({
    actor: 'gui',
    source: 'http',
    action: 'user_input',
    task_id: taskId,
    request_id,
    payload: { text }
  });

  res.json({ ok: true, request_id });
});

app.listen(PORT, () => {
  console.log(`rdloop GUI running at http://localhost:${PORT}`);
  console.log(`OUT_DIR: ${OUT_DIR}`);
});
