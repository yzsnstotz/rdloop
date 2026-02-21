const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');

const app = express();
const PORT = 17333;
const OUT_DIR = path.resolve(__dirname, '..', 'out');
const COORDINATOR = path.resolve(__dirname, '..', 'coordinator', 'run_task.sh');
const TASKS_DIR = path.resolve(__dirname, '..', 'tasks');
const EXAMPLES_DIR = path.resolve(__dirname, '..', 'examples');
const COORDINATOR_LIB = path.resolve(__dirname, '..', 'coordinator', 'lib');
const RUBRIC_PATH = path.resolve(__dirname, '..', 'schemas', 'judge_rubric.json');
const PROMPTS_DIR = path.resolve(__dirname, '..', 'prompts');
const RDLOOP_CONFIG_PATH = path.resolve(__dirname, '..', 'rdloop.config.json');
const CLIAPI_PROVIDERS_PATH = path.resolve(__dirname, '..', 'config', 'cliapi_providers.json');
const WORKTREES_DIR = path.resolve(__dirname, '..', 'worktrees');

// Env for coordinator so cursor-agent/codex are found (GUI may run with minimal PATH)
function getCoordinatorEnv() {
  const base = process.env.PATH || '';
  const prepend = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), 'bin')
  ].filter(p => p && fs.existsSync(p));
  const seen = new Set(base.split(path.delimiter).filter(Boolean));
  const added = prepend.filter(p => !seen.has(p));
  added.forEach(p => seen.add(p));
  const newPath = [...added, base].join(path.delimiter);
  return { ...process.env, PATH: newPath };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: validate taskId — alphanumeric, underscore, hyphen only (C0-2)
const VALID_TASK_ID = /^[A-Za-z0-9_-]+$/;
function isValidTaskId(taskId) {
  return typeof taskId === 'string' && VALID_TASK_ID.test(taskId);
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

// E1-1: Normalize updated_at to second-level UTC Z (K1-5)
function normalizeUpdatedAt(ts) {
  if (ts == null || ts === '') return ts;
  const s = String(ts).trim();
  if (!s) return ts;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s)) return s;
  const msMatch = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d+Z$/);
  if (msMatch) return msMatch[1] + 'Z';
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  } catch {}
  return ts;
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

// D1-1: Atomic write helper — temp → flush → fsync → rename (K1-3)
function atomicWriteJSON(filepath, data) {
  const dir = path.dirname(filepath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filepath + '.tmp.' + crypto.randomBytes(6).toString('hex');
  const fd = fs.openSync(tmp, 'w');
  try {
    const content = JSON.stringify(data, null, 2) + '\n';
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

// GET /api/tasks — cursor-based pagination (5.1)
app.get('/api/tasks', (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
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
        updated_at: normalizeUpdatedAt(status?.updated_at) || '',
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

// Task instance routes: allow taskId with slashes (e.g. requirements_doc/test/run_001)
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
  if (status) {
    if (status.state) status.state = normalizeState(status.state);
    if (status.updated_at) status.updated_at = normalizeUpdatedAt(status.updated_at);
  }
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

// B2-1: Resolve live log path — stdout.log/stderr.log → run.log → old naming fallback
function resolveLiveLogPath(taskDir, logName) {
  const guiDir = path.join(taskDir, 'gui');
  const roleByLog = { 'coordinator.log': 'coordinator', 'coder.log': 'coder', 'judge.log': 'judge' };
  const role = roleByLog[logName];
  if (logName === 'run.log') {
    const p = path.join(guiDir, 'run.log');
    return fs.existsSync(p) ? p : null;
  }
  if (role === 'coordinator') {
    const candidates = [
      path.join(guiDir, 'run.log'),
      path.join(guiDir, 'coordinator.log')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  if (role === 'coder' || role === 'judge') {
    let attempts = [];
    try {
      attempts = fs.readdirSync(taskDir)
        .filter(d => /^attempt_\d+$/.test(d))
        .sort()
        .reverse();
    } catch {}
    for (const attDir of attempts) {
      const roleDir = path.join(taskDir, attDir, role);
      const runLog = path.join(roleDir, 'run.log');
      const stdoutLog = path.join(roleDir, 'stdout.log');
      const stderrLog = path.join(roleDir, 'stderr.log');
      if (fs.existsSync(runLog)) return runLog;
      const parts = [];
      if (fs.existsSync(stdoutLog)) { const c = readFile(stdoutLog); if (c) parts.push(c); }
      if (fs.existsSync(stderrLog)) { const c = readFile(stderrLog); if (c) parts.push(c); }
      if (parts.length) return { synthetic: parts.join('\n--- stderr ---\n') };
      const oldNames = role === 'coder'
        ? [path.join(roleDir, 'cursor_stdout.log'), path.join(roleDir, 'cursor_stderr.log')]
        : [path.join(roleDir, 'codex_stderr.log')];
      for (const p of oldNames) {
        if (fs.existsSync(p)) return p;
      }
      // Judge adapters (e.g. antigravity) often write only verdict.json; use it as live "log" for the Judge tab
      if (role === 'judge') {
        const verdictPath = path.join(roleDir, 'verdict.json');
        if (fs.existsSync(verdictPath)) {
          try {
            const verdict = readJSON(verdictPath);
            return { synthetic: JSON.stringify(verdict, null, 2) };
          } catch {}
        }
      }
    }
    const guiRoleLog = path.join(guiDir, logName);
    if (fs.existsSync(guiRoleLog)) return guiRoleLog;
    return null;
  }
  return null;
}

// GET /api/task/:taskId/log/:logName — live log with etag/304 (K4-1), B2-1 unified path (always latest attempt for coder/judge)
app.get('/api/task/:taskId/log/:logName', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const logName = req.params.logName;
  const allowedLogs = ['run.log', 'coordinator.log', 'coder.log', 'judge.log'];
  if (!allowedLogs.includes(logName)) {
    return res.status(400).json({ error: 'Unknown log name' });
  }
  const taskDir = path.join(OUT_DIR, taskId);
  const resolved = resolveLiveLogPath(taskDir, logName);
  const roleByLog = { 'coordinator.log': 'coordinator', 'coder.log': 'coder', 'judge.log': 'judge' };
  const role = roleByLog[logName] || logName.replace('.log', '');
  if (!resolved) {
    const msg = `No logs found for role=${role}`;
    const etag = crypto.createHash('sha256').update(msg).digest('hex').slice(0, 16);
    if (req.headers['if-none-match'] === `"${etag}"`) return res.status(304).end();
    res.set('ETag', `"${etag}"`);
    return res.type('text/plain').send(msg);
  }
  let logPath = typeof resolved === 'string' ? resolved : null;
  let content = null;
  if (typeof resolved === 'object' && resolved.synthetic) {
    content = resolved.synthetic;
  } else if (logPath) {
    content = readFile(logPath, req.query.tail ? parseInt(req.query.tail, 10) : undefined);
  }
  if (content == null || content === '') {
    const msg = `No logs found for role=${role}`;
    const etag = crypto.createHash('sha256').update(msg).digest('hex').slice(0, 16);
    if (req.headers['if-none-match'] === `"${etag}"`) return res.status(304).end();
    res.set('ETag', `"${etag}"`);
    return res.type('text/plain').send(msg);
  }
  const etag = logPath ? computeFileEtag(logPath) : crypto.createHash('sha256').update(String(content)).digest('hex').slice(0, 16);
  if (req.headers['if-none-match'] === `"${etag}"`) return res.status(304).end();
  res.set('ETag', `"${etag}"`);
  res.type('text/plain').send(content);
});

// GET /api/task/:taskId/attempt/:n — attempt detail (B3: fixed field set)
app.get('/api/task/:taskId/attempt/:n', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const n = parseInt(req.params.n, 10);
  const pad = String(n).padStart(3, '0');
  const attDir = path.join(OUT_DIR, taskId, `attempt_${pad}`);

  if (!fs.existsSync(attDir)) {
    return res.status(404).json({ error: 'Attempt not found' });
  }

  // B3-1: Fixed field set — paths (null if absent), rc, verdict_summary
  const coderDir = path.join(attDir, 'coder');
  const judgeDir = path.join(attDir, 'judge');

  function existsOrNull(p) {
    return fs.existsSync(p) ? p.replace(OUT_DIR + path.sep, '') : null;
  }

  const paths = {
    prompt: existsOrNull(path.join(coderDir, 'prompt.txt')),
    stdout: existsOrNull(path.join(coderDir, 'stdout.log')),
    stderr: existsOrNull(path.join(coderDir, 'stderr.log')),
    run_log: existsOrNull(path.join(coderDir, 'run.log')),
    rc: existsOrNull(path.join(coderDir, 'rc.txt')),
    verdict: existsOrNull(path.join(judgeDir, 'verdict.json')),
    extract_err: existsOrNull(path.join(judgeDir, 'extract_err.log'))
  };

  // rc: read numeric rc from coder/rc.txt (or judge/rc.txt fallback)
  let rc = null;
  const rcRaw = readFile(path.join(coderDir, 'rc.txt'))?.trim() || readFile(path.join(attDir, 'test', 'rc.txt'))?.trim();
  if (rcRaw !== null && rcRaw !== undefined) {
    const parsed = parseInt(rcRaw, 10);
    if (!isNaN(parsed)) rc = parsed;
  }

  // updated_at: from status.json or attempt dir mtime
  let updated_at = null;
  const status = readJSON(path.join(OUT_DIR, taskId, 'status.json'));
  if (status?.updated_at) {
    updated_at = status.updated_at;
  } else {
    try {
      const stat = fs.statSync(attDir);
      updated_at = stat.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z');
    } catch {}
  }

  // verdict_summary: from verdict.json
  const verdict = readJSON(path.join(judgeDir, 'verdict.json'));
  const verdictSummary = {
    final_score_0_100: verdict?.final_score_0_100 ?? null,
    gated: verdict?.gated ?? null,
    pause_reason_code: status?.pause_reason_code ?? null,
    top_issues: Array.isArray(verdict?.top_issues) ? verdict.top_issues.slice(0, 2) : []
  };

  // Legacy fields for backward compat
  const evidence = readJSON(path.join(attDir, 'evidence.json'));
  const metrics = readJSON(path.join(attDir, 'metrics.json'));
  const testLog = readFile(path.join(attDir, 'test', 'stdout.log'), 400);
  const diffStat = readFile(path.join(attDir, 'git', 'diff.stat'));
  const instruction = readFile(path.join(coderDir, 'instruction.txt')) || readFile(path.join(attDir, 'coder', 'instruction.txt'));
  const env = readJSON(path.join(attDir, 'env.json'));

  // Coder/Judge input and output for attempt detail (full display)
  const coderOutput = readFile(path.join(coderDir, 'run.log'));
  const taskJson = readJSON(path.join(OUT_DIR, taskId, 'task.json'));
  const taskType = taskJson?.task_type || '';
  let judgePromptPath = path.join(PROMPTS_DIR, 'judge.prompt.md');
  if (taskType && fs.existsSync(path.join(PROMPTS_DIR, `judge.prompt.${taskType}.md`))) {
    judgePromptPath = path.join(PROMPTS_DIR, `judge.prompt.${taskType}.md`);
  }
  const judgePromptText = fs.existsSync(judgePromptPath) ? readFile(judgePromptPath) : null;

  res.json({
    // B3-1: Fixed field set
    task_id: taskId,
    attempt: n,
    role: 'coder',
    paths,
    rc,
    updated_at,
    verdict_summary: verdictSummary,
    task_type: taskType,
    // Legacy fields for backward compat (B3-2 frontend uses fixed fields above)
    verdict,
    evidence,
    metrics,
    test_rc: rcRaw || null,
    test_log: testLog,
    diff_stat: diffStat,
    instruction,
    env,
    // Coder/Judge input and output for attempt detail panels
    coder_output: coderOutput,
    judge_prompt_text: judgePromptText
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
app.post('/api/task/:taskId/run', requireWritable, validateTaskId, (req, res) => {
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
    cwd: path.resolve(__dirname, '..'),
    env: getCoordinatorEnv()
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
const DELETED_RECORDS_DIR = path.join(OUT_DIR, '_deleted');

// Helper: safe filename segment for state (no path traversal)
function stateToFileSegment(state) {
  if (state == null || state === '') return 'UNKNOWN';
  const s = String(state).replace(/[^A-Za-z0-9_-]/g, '_');
  return s || 'UNKNOWN';
}

// Helper: record a task as "deleted from sidebar" — append to manifest and by_state (categorized)
function recordDeletedFromSidebar(taskId, status) {
  try {
    const isNewDir = !fs.existsSync(DELETED_RECORDS_DIR);
    if (isNewDir) {
      fs.mkdirSync(DELETED_RECORDS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DELETED_RECORDS_DIR, 'README.md'),
        '# Deleted-from-sidebar records\n\nTasks removed from the GUI sidebar (×) are recorded here.\n\n- `manifest.jsonl` — one JSON object per line: task_id, deleted_at, state, last_decision, message, current_attempt, updated_at.\n- `by_state/` — same records grouped by state (e.g. READY_FOR_REVIEW.jsonl, FAILED.jsonl).\n'
      );
    }
    const state = normalizeState(status?.state || 'UNKNOWN');
    const deletedAt = new Date().toISOString();
    const record = {
      task_id: taskId,
      deleted_at: deletedAt,
      state,
      last_decision: status?.last_decision ?? '',
      message: (status?.message ?? '').slice(0, 500),
      current_attempt: status?.current_attempt ?? 0,
      updated_at: normalizeUpdatedAt(status?.updated_at) || ''
    };
    const line = JSON.stringify(record) + '\n';
    const manifestPath = path.join(DELETED_RECORDS_DIR, 'manifest.jsonl');
    fs.appendFileSync(manifestPath, line);
    const byStateDir = path.join(DELETED_RECORDS_DIR, 'by_state');
    if (!fs.existsSync(byStateDir)) fs.mkdirSync(byStateDir, { recursive: true });
    const stateFile = path.join(byStateDir, stateToFileSegment(state) + '.jsonl');
    fs.appendFileSync(stateFile, line);
  } catch (err) {
    console.error('recordDeletedFromSidebar:', err.message);
  }
}

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
      task_count: taskCount,
      read_only: READ_ONLY,
      allow_partial_run: ALLOW_PARTIAL_RUN
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
  if (status.updated_at) status.updated_at = normalizeUpdatedAt(status.updated_at);
  res.json(status);
});

// POST /api/tasks/:taskId/record-hidden — record task as removed from sidebar (for _deleted folder)
app.post('/api/tasks/:taskId/record-hidden', validateTaskId, (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);
  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const status = readJSON(path.join(taskDir, 'status.json'));
  recordDeletedFromSidebar(taskId, status || {});
  res.json({ ok: true });
});

// POST /api/tasks/:taskId/runtime_overrides — D1: atomic write + max_attempts range [current_attempt, 50] (K7-1: READ_ONLY blocks)
app.post('/api/tasks/:taskId/runtime_overrides', requireWritable, validateTaskId, (req, res) => {
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

  // D1-2: max_attempts validation range [current_attempt, 50]
  if (overrides.max_attempts !== undefined) {
    const ma = overrides.max_attempts;
    if (!Number.isInteger(ma) || ma > 50) {
      return res.status(400).json({ error: 'max_attempts must be integer ≤ 50' });
    }
    // Read current_attempt from status.json
    const status = readJSON(path.join(taskDir, 'status.json'));
    const currentAttempt = status?.current_attempt ?? 0;
    if (ma < currentAttempt) {
      return res.status(400).json({
        error: `max_attempts must be >= current_attempt (${currentAttempt})`,
        current_attempt: currentAttempt
      });
    }
  }

  // D1-1: Read old value for audit history; E4-3: idempotency — same request_id already written → 200 + dedup, no write
  const overridesPath = path.join(taskDir, 'runtime_overrides.json');
  const oldPayload = readJSON(overridesPath);
  if (oldPayload && oldPayload.request_id === request_id) {
    auditLog({
      actor: 'http',
      source: 'http',
      action: 'runtime_overrides',
      task_id: taskId,
      request_id,
      dedup: true
    });
    return res.status(200).json({ ok: true, request_id, deduplicated: true });
  }

  const payload = {
    overrides,
    request_id,
    written_at: new Date().toISOString()
  };

  // D1-1: Atomic write — temp → flush → fsync → rename (K1-3). E4-4: on failure return WRITE_FAILED, audit, do not modify status.
  try {
    atomicWriteJSON(overridesPath, payload);
  } catch (writeErr) {
    auditLog({
      actor: 'gui',
      source: 'http',
      action: 'runtime_overrides',
      task_id: taskId,
      request_id,
      error: 'WRITE_FAILED',
      message: writeErr.message
    });
    return res.status(500).json({
      error: 'WRITE_FAILED',
      message: 'Failed to write runtime_overrides. Status was not modified.',
      request_id
    });
  }

  // Audit with old/new for rollback support (A5-0)
  auditLog({
    actor: 'gui',
    source: 'http',
    action: 'runtime_overrides',
    task_id: taskId,
    request_id,
    old: oldPayload?.overrides ?? null,
    new: overrides
  });

  // Append to runtime_overrides_history.jsonl for rollback (A5-0)
  try {
    if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const histLine = JSON.stringify({
      ts: new Date().toISOString(),
      task_id: taskId,
      request_id,
      old: oldPayload?.overrides ?? null,
      new: overrides
    }) + '\n';
    fs.appendFileSync(path.join(AUDIT_DIR, 'runtime_overrides_history.jsonl'), histLine);
  } catch { /* best effort */ }

  res.json({ ok: true, request_id });
});

// POST /api/tasks/:taskId/user_input — append to user_input.jsonl + audit (K7-1: READ_ONLY blocks)
app.post('/api/tasks/:taskId/user_input', requireWritable, validateTaskId, (req, res) => {
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
  const line = JSON.stringify(entry) + '\n';
  const fd = fs.openSync(inputFile, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

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

// ================================================================
// A4: GET /api/rubric/:task_type — rubric dimensions/weights/gates
// ================================================================
app.get('/api/rubric/:task_type', (req, res) => {
  const taskType = req.params.task_type;
  const rubric = readJSON(RUBRIC_PATH);
  if (!rubric) {
    return res.status(500).json({ error: 'Failed to load judge_rubric.json' });
  }
  // Resolve alias (e.g. engineering_implementation → engineering_impl)
  const aliasMap = rubric.alias_map || {};
  const resolved = aliasMap[taskType] || taskType;
  const typeData = rubric.task_types?.[resolved];
  if (!typeData) {
    return res.status(404).json({
      error: `Unknown task_type: ${taskType}`,
      available: Object.keys(rubric.task_types || {})
    });
  }
  // B4-3a: support dimensions as array of { dim_key, weight, is_hard_gate } or legacy [names] + weights + hard_gates
  let dimensions = typeData.dimensions || [];
  let weights = typeData.weights || {};
  let hard_gates = typeData.hard_gates || [];
  if (dimensions.length && typeof dimensions[0] === 'object' && dimensions[0] != null && 'dim_key' in dimensions[0]) {
    dimensions = dimensions.map(d => d.dim_key);
    weights = Object.fromEntries((typeData.dimensions || []).map(d => [d.dim_key, d.weight]));
    hard_gates = (typeData.dimensions || []).filter(d => d.is_hard_gate).map(d => d.dim_key);
  }
  res.json({
    task_type: resolved,
    dimensions,
    weights,
    hard_gates,
    gate_threshold: typeData.gate_threshold ?? typeData.hard_gate_threshold ?? 2.0,
    penalty_rules: typeData.penalty_rules || []
  });
});

// ================================================================
// A5: GET /api/adapters — adapter list + healthcheck (C1-1)
// ================================================================

// A5-1: Detect known adapters from coordinator/lib/call_* scripts
function detectAdapters() {
  const adapters = [];
  let files = [];
  try {
    files = fs.readdirSync(COORDINATOR_LIB).filter(f => f.startsWith('call_'));
  } catch {
    return adapters;
  }

  for (const file of files) {
    // Parse name: call_coder_cursor.sh → type=coder, name=cursor-agent
    const match = file.match(/^call_(coder|judge)_(.+)\.sh$/);
    if (!match) continue;
    const role = match[1]; // 'coder' or 'judge'
    const rawName = match[2]; // e.g. 'cursor', 'mock', 'codex', 'mock_timeout'

    const scriptPath = path.join(COORDINATOR_LIB, file);

    // Map raw name to adapter name
    const nameMap = {
      'cursor': 'cursor-agent',
      'mock': 'mock',
      'mock_timeout': 'mock-timeout',
      'codex': 'codex-cli',
      'claude': 'claude-cli',
      'claude_bridge': 'claude-cli',
      'antigravity': 'antigravity-cli',
      'openai': 'openai-api',
      'moonshot': 'moonshot-api',
      'openrouter': 'openrouter-api'
    };
    const adapterName = nameMap[rawName] || rawName;

    // A5-1: healthcheck
    const health = adapterHealthcheck(adapterName, role, scriptPath);
    const supportLevel = health.support_level || (health.status === 'OK' ? 'SUPPORTED' : 'UNSUPPORTED');
    adapters.push({
      name: adapterName,
      type: role,
      script: file,
      status: health.status,
      reason: health.reason,
      supports_ssh_headless: health.supports_ssh_headless,
      support_level: supportLevel
    });
  }

  return adapters;
}

function adapterHealthcheck(name, role, scriptPath) {
  // Check if script file exists and is executable
  if (!fs.existsSync(scriptPath)) {
    return { status: 'UNAVAILABLE', reason: 'script not found', supports_ssh_headless: false, support_level: 'UNSUPPORTED' };
  }

  const platform = os.platform();

  // Mock adapters are always available
  if (name.startsWith('mock')) {
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'SUPPORTED' };
  }

  // cursor-agent: via cliapi (cursorcliapi 8000), same API key as other adapters
  if (name === 'cursor-agent') {
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'SUPPORTED' };
  }

  // codex-cli: demo/PARTIAL per requirement (C1-1 / K8-5)
  if (name === 'codex-cli') {
    const exists = commandExists('codex');
    if (!exists) {
      return { status: 'UNAVAILABLE', reason: 'missing binary: codex', supports_ssh_headless: true, support_level: 'PARTIAL' };
    }
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'PARTIAL' };
  }

  // claude-cli: demo/PARTIAL per requirement (C1-1 / K8-5)
  if (name === 'claude-cli') {
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'PARTIAL' };
  }

  // antigravity-cli: via CLIProxyAPI 8317; script exists and uses OPENCLAW_API_KEY/openclawaousers
  if (name === 'antigravity-cli') {
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'SUPPORTED' };
  }

  // openai-api: check key — SUPPORTED for K8-5
  if (name === 'openai-api') {
    if (!process.env.OPENAI_API_KEY) {
      return { status: 'UNAVAILABLE', reason: 'missing key: OPENAI_API_KEY', supports_ssh_headless: true, support_level: 'SUPPORTED' };
    }
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'SUPPORTED' };
  }

  // moonshot-api: check key
  if (name === 'moonshot-api') {
    if (!process.env.MOONSHOT_API_KEY) {
      return { status: 'UNAVAILABLE', reason: 'missing key: MOONSHOT_API_KEY', supports_ssh_headless: true, support_level: 'SUPPORTED' };
    }
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'SUPPORTED' };
  }

  // openrouter-api: check key
  if (name === 'openrouter-api') {
    if (!process.env.OPENROUTER_API_KEY) {
      return { status: 'UNAVAILABLE', reason: 'missing key: OPENROUTER_API_KEY', supports_ssh_headless: true, support_level: 'SUPPORTED' };
    }
    return { status: 'OK', reason: null, supports_ssh_headless: true, support_level: 'SUPPORTED' };
  }

  return { status: 'UNKNOWN', reason: 'unrecognized adapter', supports_ssh_headless: false, support_level: 'UNSUPPORTED' };
}

function commandExists(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// C1-1: ALLOW_PARTIAL_RUN — when false, PARTIAL adapters must not be selectable as default or for Run
const ALLOW_PARTIAL_RUN = process.env.ALLOW_PARTIAL_RUN === 'true';

// K7-1: READ_ONLY — when true, all write operations return 403
const READ_ONLY = process.env.READ_ONLY === 'true';
function requireWritable(req, res, next) {
  if (READ_ONLY) {
    return res.status(403).json({ error: 'READ_ONLY mode: writes are disabled' });
  }
  next();
}

app.get('/api/adapters', (req, res) => {
  try {
    const adapters = detectAdapters();
    res.json({ adapters, allow_partial_run: ALLOW_PARTIAL_RUN });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cliapi: provider -> models (for second-level model selector). API key: openclawaousers.
app.get('/api/cliapi-providers', (req, res) => {
  try {
    if (!fs.existsSync(CLIAPI_PROVIDERS_PATH)) {
      return res.json({ api_key_profile: 'openclawaousers', providers: {} });
    }
    const data = readJSON(CLIAPI_PROVIDERS_PATH);
    res.json({
      api_key_profile: data.api_key_profile || 'openclawaousers',
      providers: data.providers || {}
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A6-1: GET/PUT /api/config — default coder/judge from rdloop.config.json (C1-2)
function readRdloopConfig() {
  try {
    if (fs.existsSync(RDLOOP_CONFIG_PATH)) {
      const data = readJSON(RDLOOP_CONFIG_PATH);
      return data || {};
    }
  } catch {}
  return {};
}

app.get('/api/config', (req, res) => {
  try {
    const cfg = readRdloopConfig();
    res.json({
      default_coder: cfg.default_coder || null,
      default_judge: cfg.default_judge || null,
      default_coder_model: cfg.default_coder_model || null,
      default_judge_model: cfg.default_judge_model || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config', requireWritable, (req, res) => {
  try {
    const { default_coder, default_judge, default_coder_model, default_judge_model } = req.body || {};
    const cfg = readRdloopConfig();
    if (default_coder !== undefined) cfg.default_coder = default_coder;
    if (default_judge !== undefined) cfg.default_judge = default_judge;
    if (default_coder_model !== undefined) cfg.default_coder_model = default_coder_model;
    if (default_judge_model !== undefined) cfg.default_judge_model = default_judge_model;
    atomicWriteJSON(RDLOOP_CONFIG_PATH, cfg);
    res.json({
      ok: true,
      default_coder: cfg.default_coder || null,
      default_judge: cfg.default_judge || null,
      default_coder_model: cfg.default_coder_model || null,
      default_judge_model: cfg.default_judge_model || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// A2: TaskSpec CRUD — /api/task_specs (E2)
// ================================================================

// Helper: find task spec dirs (tasks/ then examples/)
function getTaskSpecDirs() {
  return [TASKS_DIR, EXAMPLES_DIR].filter(d => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
}

function findTaskSpec(taskId) {
  for (const dir of getTaskSpecDirs()) {
    const p = path.join(dir, `${taskId}.json`);
    if (fs.existsSync(p)) return { filepath: p, dir };
  }
  return null;
}

function validateTaskSpecId(id) {
  return VALID_TASK_ID.test(id);
}

// A3-1/A3-2: Validate task spec data — JSON already parsed; optional schema-style checks
function validateTaskSpecData(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') {
    return { valid: false, errors: ['spec must be an object'] };
  }
  if (spec.task_id !== undefined && !validateTaskSpecId(String(spec.task_id))) {
    errors.push('task_id: invalid format (alphanumeric, underscore, hyphen only)');
  }
  if (spec.max_attempts !== undefined && (typeof spec.max_attempts !== 'number' || spec.max_attempts < 1 || spec.max_attempts > 50)) {
    errors.push('max_attempts: must be number between 1 and 50');
  }
  if (spec.task_type && !['requirements_doc', 'engineering_impl', 'douyin_script', 'storyboard', 'paid_mini_drama', ''].includes(spec.task_type)) {
    errors.push('task_type: invalid enum value');
  }
  if (spec.scoring_mode && !['rubric_analytic', 'holistic_impression', ''].includes(spec.scoring_mode)) {
    errors.push('scoring_mode: invalid enum value');
  }
  return { valid: errors.length === 0, errors };
}

// GET /api/task_specs — list all task specs from tasks/ and examples/ (A1-1)
app.get('/api/task_specs', (req, res) => {
  try {
    const specs = [];
    for (const dir of getTaskSpecDirs()) {
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }
      for (const file of files) {
        const taskId = file.replace(/\.json$/, '');
        if (!validateTaskSpecId(taskId)) continue;
        const filePath = path.join(dir, file);
        const data = readJSON(filePath);
        if (!data) continue;
        let updated_at = null;
        try {
          const stat = fs.statSync(filePath);
          updated_at = stat.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z');
        } catch {}
        specs.push({
          task_id: taskId,
          file_path: filePath,
          updated_at: normalizeUpdatedAt(updated_at),
          task_type: data.task_type || null,
          scoring_mode: data.scoring_mode || null,
          coder: data.coder || null,
          judge: data.judge || null,
          goal: data.goal || null,
          source_dir: path.basename(dir)
        });
      }
    }
    res.json({ specs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/task_specs/:taskId — read a task spec
app.get('/api/task_specs/:taskId', (req, res) => {
  const taskId = req.params.taskId;
  if (!validateTaskSpecId(taskId)) {
    return res.status(400).json({ error: 'Invalid task_id format' });
  }
  const found = findTaskSpec(taskId);
  if (!found) {
    return res.status(404).json({ error: 'Task spec not found' });
  }
  const data = readJSON(found.filepath);
  if (!data) {
    return res.status(500).json({ error: 'Failed to read task spec' });
  }
  res.json({ task_id: taskId, spec: data, source_dir: path.basename(found.dir) });
});

// POST /api/task_specs — create a new task spec (A2-2), A3 validation
app.post('/api/task_specs', requireWritable, (req, res) => {
  const { task_id, spec, target_dir } = req.body || {};
  if (!task_id || !validateTaskSpecId(task_id)) {
    return res.status(400).json({ error: 'Invalid or missing task_id' });
  }
  if (!spec || typeof spec !== 'object') {
    return res.status(400).json({ error: 'spec object is required' });
  }
  const validation = validateTaskSpecData(spec);
  if (!validation.valid) {
    return res.status(400).json({ error: 'Validation failed', errors: validation.errors });
  }

  // Normalize task_type alias
  if (spec.task_type === 'engineering_implementation') {
    spec.task_type = 'engineering_impl';
  }

  // Choose save directory: tasks/ preferred, fallback to examples/
  let saveDir;
  if (target_dir === 'examples') {
    saveDir = EXAMPLES_DIR;
  } else {
    saveDir = TASKS_DIR;
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  }

  const filepath = path.join(saveDir, `${task_id}.json`);
  // C0-2: path traversal check
  if (!filepath.startsWith(saveDir + path.sep) && filepath !== path.join(saveDir, `${task_id}.json`)) {
    return res.status(400).json({ error: 'Path traversal detected' });
  }

  if (fs.existsSync(filepath)) {
    return res.status(409).json({ error: `Task spec '${task_id}' already exists` });
  }

  const data = { ...spec, task_id, created_at: spec.created_at || new Date().toISOString() };

  try {
    atomicWriteJSON(filepath, data);
  } catch (err) {
    return res.status(500).json({ error: `Failed to write task spec: ${err.message}` });
  }

  auditLog({ action: 'task_spec_create', task_id, source_dir: path.basename(saveDir) });
  res.json({ ok: true, task_id, source_dir: path.basename(saveDir) });
});

// PUT /api/task_specs/:taskId — update an existing task spec (A2-5), A3 validation
app.put('/api/task_specs/:taskId', requireWritable, (req, res) => {
  const taskId = req.params.taskId;
  if (!validateTaskSpecId(taskId)) {
    return res.status(400).json({ error: 'Invalid task_id format' });
  }
  const { spec } = req.body || {};
  if (!spec || typeof spec !== 'object') {
    return res.status(400).json({ error: 'spec object is required' });
  }
  const validation = validateTaskSpecData(spec);
  if (!validation.valid) {
    return res.status(400).json({ error: 'Validation failed', errors: validation.errors });
  }

  // Normalize task_type alias
  if (spec.task_type === 'engineering_implementation') {
    spec.task_type = 'engineering_impl';
  }

  const found = findTaskSpec(taskId);
  if (!found) {
    return res.status(404).json({ error: 'Task spec not found' });
  }

  const data = { ...spec, task_id: taskId };
  try {
    atomicWriteJSON(found.filepath, data);
  } catch (err) {
    return res.status(500).json({ error: `Failed to write task spec: ${err.message}` });
  }

  auditLog({ action: 'task_spec_update', task_id: taskId, source_dir: path.basename(found.dir) });
  res.json({ ok: true, task_id: taskId });
});

// DELETE /api/task_specs/:taskId — soft-delete to trash/ (A2-4)
app.delete('/api/task_specs/:taskId', requireWritable, (req, res) => {
  const taskId = req.params.taskId;
  if (!validateTaskSpecId(taskId)) {
    return res.status(400).json({ error: 'Invalid task_id format' });
  }

  const found = findTaskSpec(taskId);
  if (!found) {
    return res.status(404).json({ error: 'Task spec not found' });
  }

  // Soft-delete to trash/ within the same parent directory
  const trashDir = path.join(found.dir, 'trash');
  if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const trashName = `${taskId}_${ts}.json`;
  const trashPath = path.join(trashDir, trashName);

  try {
    fs.renameSync(found.filepath, trashPath);
  } catch (err) {
    return res.status(500).json({ error: `Failed to move to trash: ${err.message}` });
  }

  auditLog({ action: 'task_spec_delete', task_id: taskId, trash_path: trashPath });
  res.json({ ok: true, task_id: taskId, trash_path: trashPath });
});

// POST /api/task_specs/:taskId/run — new instance: unique task_id per run (spec_id + timestamp) so sidebar shows each run
app.post('/api/task_specs/:taskId/run', requireWritable, (req, res) => {
  const specTaskId = req.params.taskId;
  if (!validateTaskSpecId(specTaskId)) {
    return res.status(400).json({ error: 'Invalid task_id format' });
  }
  const found = findTaskSpec(specTaskId);
  if (!found) {
    return res.status(404).json({ error: 'Task spec not found' });
  }
  const spec = readJSON(found.filepath);
  if (!spec) {
    return res.status(500).json({ error: 'Failed to read task spec' });
  }
  // Unique run task_id so each Run appears as a new row in sidebar and does not overwrite previous run
  const now = new Date();
  const stamp = now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') + '_' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const runTaskId = `${specTaskId}_${stamp}`;
  if (!VALID_TASK_ID.test(runTaskId)) {
    return res.status(400).json({ error: 'Generated run task_id invalid (chars)' });
  }

  const taskDir = path.join(OUT_DIR, runTaskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const taskJsonPath = path.join(taskDir, 'task.json');
  const taskPayload = { ...spec, task_id: runTaskId };
  try {
    atomicWriteJSON(taskJsonPath, taskPayload);
  } catch (err) {
    return res.status(500).json({ error: `Failed to write task.json: ${err.message}` });
  }
  const guiDir = path.join(taskDir, 'gui');
  fs.mkdirSync(guiDir, { recursive: true });
  const logFile = path.join(guiDir, 'run.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn('bash', [COORDINATOR, '--continue', runTaskId], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: path.resolve(__dirname, '..'),
    env: getCoordinatorEnv()
  });
  fs.writeFileSync(path.join(guiDir, 'runner.pid'), String(child.pid));
  child.unref();
  res.json({ ok: true, pid: child.pid, task_id: runTaskId });
});

// POST /api/task_specs/:taskId/copy — copy task spec with auto-rename (A2-3)
app.post('/api/task_specs/:taskId/copy', requireWritable, (req, res) => {
  const srcTaskId = req.params.taskId;
  if (!validateTaskSpecId(srcTaskId)) {
    return res.status(400).json({ error: 'Invalid task_id format' });
  }

  const found = findTaskSpec(srcTaskId);
  if (!found) {
    return res.status(404).json({ error: 'Task spec not found' });
  }

  const srcData = readJSON(found.filepath);
  if (!srcData) {
    return res.status(500).json({ error: 'Failed to read source task spec' });
  }

  // Auto-rename: hello_world → hello_world_copy → hello_world_copy_2 → ...
  let newId = `${srcTaskId}_copy`;
  let counter = 2;
  while (findTaskSpec(newId)) {
    newId = `${srcTaskId}_copy_${counter++}`;
  }

  const saveDir = found.dir;
  const newPath = path.join(saveDir, `${newId}.json`);
  const newData = {
    ...srcData,
    task_id: newId,
    created_at: new Date().toISOString()
  };

  try {
    atomicWriteJSON(newPath, newData);
  } catch (err) {
    return res.status(500).json({ error: `Failed to copy task spec: ${err.message}` });
  }

  auditLog({ action: 'task_spec_copy', src_task_id: srcTaskId, new_task_id: newId });
  res.json({ ok: true, task_id: newId, source_dir: path.basename(saveDir) });
});

// ============================================================
// D1/D2: Prompt directory management
// ============================================================

// Validate prompt file name: only [A-Za-z0-9_.-]+.md, no path separators
const VALID_PROMPT_NAME = /^[A-Za-z0-9_.\-]+\.md$/;
function validatePromptName(name) {
  return VALID_PROMPT_NAME.test(name) && !name.includes('..') && !name.includes('/') && !name.includes('\\');
}

// Atomic write for plain text files (D1/D2 — temp → fsync → rename)
function atomicWriteText(filepath, content) {
  const dir = path.dirname(filepath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filepath + '.tmp.' + crypto.randomBytes(6).toString('hex');
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

// GET /api/prompts — list all .md files in prompts/ (D1)
app.get('/api/prompts', (req, res) => {
  try {
    let files = [];
    try { files = fs.readdirSync(PROMPTS_DIR); } catch { /* dir not found */ }
    const prompts = files
      .filter(f => f.endsWith('.md') && validatePromptName(f))
      .map(f => {
        const fp = path.join(PROMPTS_DIR, f);
        let size = 0, updated_at = null;
        try {
          const stat = fs.statSync(fp);
          size = stat.size;
          updated_at = stat.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z');
        } catch {}
        return { name: f, size, updated_at };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ prompts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prompts/:name — read a prompt file (D1)
app.get('/api/prompts/:name', (req, res) => {
  const { name } = req.params;
  if (!validatePromptName(name)) {
    return res.status(400).json({ error: 'Invalid prompt file name' });
  }
  const filepath = path.resolve(PROMPTS_DIR, name);
  // Path traversal check (D2)
  if (!filepath.startsWith(PROMPTS_DIR + path.sep) && filepath !== PROMPTS_DIR) {
    return res.status(400).json({ error: 'Path traversal denied' });
  }
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Prompt not found' });
  }
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    let updated_at = null;
    try { updated_at = fs.statSync(filepath).mtime.toISOString().replace(/\.\d{3}Z$/, 'Z'); } catch {}
    res.json({ name, content, updated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/prompts/:name — save a prompt file (D1/D2). K7-1: READ_ONLY blocks; K7-2: overwrite confirmed by client.
app.put('/api/prompts/:name', requireWritable, (req, res) => {
  const { name } = req.params;
  if (!validatePromptName(name)) {
    return res.status(400).json({ error: 'Invalid prompt file name' });
  }
  const filepath = path.resolve(PROMPTS_DIR, name);
  // Path traversal check (D2)
  if (!filepath.startsWith(PROMPTS_DIR + path.sep) && filepath !== PROMPTS_DIR) {
    return res.status(400).json({ error: 'Path traversal denied' });
  }
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  // Backup existing file with timestamp (D1 optional versioning)
  let backup_path = null;
  if (fs.existsSync(filepath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    backup_path = filepath + '.bak.' + ts;
    try { fs.copyFileSync(filepath, backup_path); } catch { backup_path = null; }
  }
  try {
    atomicWriteText(filepath, content);
    auditLog({ action: 'prompt_save', name, size: content.length, backup: backup_path });
    let updated_at = null;
    try { updated_at = fs.statSync(filepath).mtime.toISOString().replace(/\.\d{3}Z$/, 'Z'); } catch {}
    res.json({ ok: true, name, updated_at, backup: backup_path ? path.basename(backup_path) : null });
  } catch (err) {
    auditLog({ action: 'prompt_save_failed', name, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`rdloop GUI running at http://localhost:${PORT}`);
  console.log(`OUT_DIR: ${OUT_DIR}`);
});
