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

// Helper: read events.jsonl
function readEvents(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    return content.trim().split('\n').filter(l => l).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// Helper: read file from byte offset (for live log streaming). Returns { content, nextOffset }.
function readFileFromOffset(filepath, offset) {
  let fd;
  try {
    if (!fs.existsSync(filepath)) return { content: '', nextOffset: 0 };
    const stat = fs.statSync(filepath);
    const size = stat.size;
    const nextOffset = size;
    if (offset < 0) offset = 0;
    if (offset >= size) return { content: '', nextOffset };
    fd = fs.openSync(filepath, 'r');
    const len = size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    return { content: buf.toString('utf8'), nextOffset };
  } catch (e) {
    return { content: '', nextOffset: offset || 0 };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// GET /api/tasks — list all tasks
app.get('/api/tasks', (req, res) => {
  try {
    const dirs = fs.readdirSync(OUT_DIR).filter(d => {
      const p = path.join(OUT_DIR, d);
      return fs.statSync(p).isDirectory() && !d.startsWith('.');
    });

    const tasks = dirs.map(taskId => {
      const status = readJSON(path.join(OUT_DIR, taskId, 'status.json'));
      return {
        task_id: taskId,
        state: status?.state || 'UNKNOWN',
        current_attempt: status?.current_attempt || 0,
        last_decision: status?.last_decision || '',
        message: status?.message || '',
        updated_at: status?.updated_at || ''
      };
    });

    res.json({ tasks });
  } catch (err) {
    res.json({ tasks: [], error: err.message });
  }
});

// GET /api/task/:taskId — full task detail
app.get('/api/task/:taskId', (req, res) => {
  const taskId = req.params.taskId;
  const taskDir = path.join(OUT_DIR, taskId);

  if (!fs.existsSync(taskDir)) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const taskJson = readJSON(path.join(taskDir, 'task.json'));
  const status = readJSON(path.join(taskDir, 'status.json'));
  const finalSummary = readJSON(path.join(taskDir, 'final_summary.json'));
  const events = readEvents(path.join(taskDir, 'events.jsonl'));

  // Scan attempts
  const attempts = [];
  try {
    const entries = fs.readdirSync(taskDir).filter(d => d.startsWith('attempt_')).sort();
    for (const dir of entries) {
      const attDir = path.join(taskDir, dir);
      const testRc = readFile(path.join(attDir, 'test', 'rc.txt'));
      const coderRc = readFile(path.join(attDir, 'coder', 'rc.txt'));
      const diffStat = readFile(path.join(attDir, 'git', 'diff.stat'));
      const verdict = readJSON(path.join(attDir, 'judge', 'verdict.json'));
      attempts.push({
        name: dir,
        coder_rc: coderRc ? coderRc.trim() : null,
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

// GET /api/task/:taskId/attempt/:n — attempt detail
app.get('/api/task/:taskId/attempt/:n', (req, res) => {
  const taskId = req.params.taskId;
  const n = parseInt(req.params.n, 10);
  const pad = String(n).padStart(3, '0');
  const attDir = path.join(OUT_DIR, taskId, `attempt_${pad}`);

  if (!fs.existsSync(attDir)) {
    return res.status(404).json({ error: 'Attempt not found' });
  }

  const judgeDir = path.join(attDir, 'judge');
  let judge_run_log = '';
  const cursorStderr = readFile(path.join(judgeDir, 'cursor_stderr.log'), 2000);
  const codexStderr = readFile(path.join(judgeDir, 'codex_stderr.log'), 2000);
  if (cursorStderr && cursorStderr.trim()) judge_run_log += cursorStderr.trim() + '\n';
  if (codexStderr && codexStderr.trim()) judge_run_log += (judge_run_log ? '\n' : '') + codexStderr.trim() + '\n';
  const verdictTmp = readFile(path.join(judgeDir, 'verdict.tmp.json'), 8000);
  if (verdictTmp && verdictTmp.trim()) judge_run_log += (judge_run_log ? '\n--- LLM stdout ---\n' : '') + verdictTmp.trim();

  res.json({
    evidence: readJSON(path.join(attDir, 'evidence.json')),
    verdict: readJSON(path.join(attDir, 'judge', 'verdict.json')),
    metrics: readJSON(path.join(attDir, 'metrics.json')),
    test_rc: readFile(path.join(attDir, 'test', 'rc.txt'))?.trim() || null,
    test_log: readFile(path.join(attDir, 'test', 'stdout.log'), 400),
    diff_stat: readFile(path.join(attDir, 'git', 'diff.stat')),
    instruction: readFile(path.join(attDir, 'coder', 'instruction.txt')),
    coder_rc: readFile(path.join(attDir, 'coder', 'rc.txt'))?.trim() || null,
    coder_run_log: readFile(path.join(attDir, 'coder', 'run.log'), 2000),
    judge_rc: readFile(path.join(judgeDir, 'rc.txt'))?.trim() || null,
    judge_run_log: judge_run_log || null,
    env: readJSON(path.join(attDir, 'env.json'))
  });
});

// POST /api/task/:taskId/control — write control.json
app.post('/api/task/:taskId/control', (req, res) => {
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

// GET /api/task/:taskId/logs/coordinator?offset=N — tail coordinator run.log from byte offset
app.get('/api/task/:taskId/logs/coordinator', (req, res) => {
  const taskId = req.params.taskId;
  const offset = parseInt(req.query.offset, 10) || 0;
  const logFile = path.join(OUT_DIR, taskId, 'gui', 'run.log');
  const result = readFileFromOffset(logFile, offset);
  res.json(result);
});

// GET /api/task/:taskId/logs/attempt/:n/coder?offset=N — tail coder run.log for attempt n
app.get('/api/task/:taskId/logs/attempt/:n/coder', (req, res) => {
  const taskId = req.params.taskId;
  const n = req.params.n;
  const pad = String(n).padStart(3, '0');
  const offset = parseInt(req.query.offset, 10) || 0;
  const logFile = path.join(OUT_DIR, taskId, `attempt_${pad}`, 'coder', 'run.log');
  const result = readFileFromOffset(logFile, offset);
  res.json(result);
});

// GET /api/task/:taskId/logs/attempt/:n/judge?offset=N — tail judge log (cursor_stderr.log or codex_stderr.log)
app.get('/api/task/:taskId/logs/attempt/:n/judge', (req, res) => {
  const taskId = req.params.taskId;
  const n = req.params.n;
  const pad = String(n).padStart(3, '0');
  const offset = parseInt(req.query.offset, 10) || 0;
  const judgeDir = path.join(OUT_DIR, taskId, `attempt_${pad}`, 'judge');
  const cursorLog = path.join(judgeDir, 'cursor_stderr.log');
  const codexLog = path.join(judgeDir, 'codex_stderr.log');
  const logFile = fs.existsSync(cursorLog) ? cursorLog : codexLog;
  const result = readFileFromOffset(logFile, offset);
  res.json(result);
});

// POST /api/task/:taskId/run — trigger coordinator
app.post('/api/task/:taskId/run', (req, res) => {
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

app.listen(PORT, () => {
  console.log(`rdloop GUI running at http://localhost:${PORT}`);
  console.log(`OUT_DIR: ${OUT_DIR}`);
});
