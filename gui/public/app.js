// rdloop GUI — Frontend Application
let currentTaskId = null;
let currentAttempt = null;

// Badge helper
function badge(state) {
  const cls = {
    'RUNNING': 'badge-running', 'PAUSED': 'badge-paused',
    'READY_FOR_REVIEW': 'badge-ready', 'FAILED': 'badge-failed'
  }[state] || '';
  return `<span class="badge ${cls}">${state || 'UNKNOWN'}</span>`;
}

// Fetch helper
async function api(path, opts) {
  const res = await fetch(`/api${path}`, opts);
  return res.json();
}

// Load task list
async function loadTasks() {
  const data = await api('/tasks');
  const list = document.getElementById('task-list');
  if (!data.tasks || data.tasks.length === 0) {
    list.innerHTML = '<div style="padding:16px;color:#8b949e">No tasks found.<br>Run examples/run_hello.sh first.</div>';
    return;
  }
  list.innerHTML = data.tasks.map(t => `
    <div class="task-item ${t.task_id === currentTaskId ? 'active' : ''}"
         onclick="selectTask('${t.task_id}')">
      <div class="task-id">${t.task_id}</div>
      <div class="task-meta">
        ${badge(t.state)}
        attempt ${t.current_attempt} · ${t.last_decision || '-'}
      </div>
    </div>
  `).join('');
}

// Select and load task
async function selectTask(taskId) {
  currentTaskId = taskId;
  currentAttempt = null;
  const data = await api(`/task/${taskId}`);
  renderTask(data);
  loadTasks(); // refresh active state
}

// Render task detail
function renderTask(data) {
  const { task, status, final_summary, attempts, timeline } = data;
  const s = status || {};
  const content = document.getElementById('content');

  content.innerHTML = `
    <h2>${s.task_id || currentTaskId} ${badge(s.state)}</h2>

    <div class="info-grid">
      <div class="info-card">
        <div class="label">State</div>
        <div class="value">${s.state || '-'}</div>
      </div>
      <div class="info-card">
        <div class="label">Attempt</div>
        <div class="value">${s.current_attempt || 0} / ${s.max_attempts || '-'}</div>
      </div>
      <div class="info-card">
        <div class="label">Last Decision</div>
        <div class="value">${s.last_decision || '-'}</div>
      </div>
      <div class="info-card">
        <div class="label">Message</div>
        <div class="value" style="font-size:13px">${s.message || '-'}</div>
      </div>
    </div>

    ${s.questions_for_user && s.questions_for_user.length > 0 ? `
      <div style="background:#d2992233;border:1px solid #d29922;border-radius:8px;padding:12px;margin-bottom:16px">
        <strong>Questions for user:</strong>
        <ul style="margin-top:8px;padding-left:20px">
          ${s.questions_for_user.map(q => `<li>${q}</li>`).join('')}
        </ul>
      </div>
    ` : ''}

    <div class="controls">
      <button class="btn btn-danger" onclick="doControl('PAUSE')">Pause</button>
      <button class="btn btn-primary" onclick="doControl('RESUME')">Resume</button>
      <button class="btn btn-primary" onclick="doRunNext()">Run Next</button>
      <button class="btn btn-warn" onclick="doForceRun()">Force Run</button>
    </div>

    <h3>Attempts</h3>
    <div class="attempt-list" id="attempt-list">
      ${attempts.map(a => `
        <div class="attempt-item" onclick="loadAttempt('${currentTaskId}', ${parseInt(a.name.replace('attempt_',''))})">
          <strong>${a.name}</strong>
          — test rc: ${a.test_rc ?? '?'}
          — judge: ${a.judge_decision || '?'}
          ${a.diff_stat ? `<br><small style="color:#8b949e">${a.diff_stat.substring(0, 100)}</small>` : ''}
        </div>
      `).join('') || '<div style="color:#8b949e">No attempts yet</div>'}
    </div>

    <div id="attempt-detail"></div>

    <h3>Timeline (${timeline.length} events)</h3>
    <div class="timeline">
      ${timeline.slice().reverse().slice(0, 50).map(e => `
        <div class="timeline-item">
          <span class="ts">${e.ts ? e.ts.substring(11, 19) : ''}</span>
          <span class="type">${e.type}</span>
          <span class="summary">${e.summary || ''}</span>
        </div>
      `).join('')}
    </div>
  `;
  content.className = '';
}

// Load attempt detail
async function loadAttempt(taskId, n) {
  currentAttempt = n;
  const data = await api(`/task/${taskId}/attempt/${n}`);
  const detail = document.getElementById('attempt-detail');

  detail.innerHTML = `
    <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin:16px 0">
      <h3>Attempt ${n} Detail</h3>

      <h3>Instruction</h3>
      <textarea id="instruction-edit">${data.instruction || '(none)'}</textarea>
      <button class="btn" onclick="saveInstruction(${n})" style="margin-top:8px">Save Instruction</button>

      <h3>Test Result (rc: ${data.test_rc || '?'})</h3>
      <pre>${data.test_log || '(no log)'}</pre>

      <h3>Diff Stat</h3>
      <pre>${data.diff_stat || '(no diff)'}</pre>

      <h3>Verdict</h3>
      <pre>${data.verdict ? JSON.stringify(data.verdict, null, 2) : '(no verdict)'}</pre>

      <h3>Metrics</h3>
      <pre>${data.metrics ? JSON.stringify(data.metrics, null, 2) : '(no metrics)'}</pre>

      <h3>Evidence</h3>
      <pre>${data.evidence ? JSON.stringify(data.evidence, null, 2) : '(no evidence)'}</pre>
    </div>
  `;
}

// Control actions
async function doControl(action, payload) {
  if (!currentTaskId) return;
  await api(`/task/${currentTaskId}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload: payload || {} })
  });
  setTimeout(() => selectTask(currentTaskId), 500);
}

async function doRunNext() {
  if (!currentTaskId) return;
  await doControl('RUN_NEXT');
  await api(`/task/${currentTaskId}/run`, { method: 'POST' });
  setTimeout(() => selectTask(currentTaskId), 1000);
}

async function doForceRun() {
  if (!currentTaskId) return;
  await api(`/task/${currentTaskId}/run?force=1`, { method: 'POST' });
  setTimeout(() => selectTask(currentTaskId), 1000);
}

async function saveInstruction(n) {
  if (!currentTaskId) return;
  const text = document.getElementById('instruction-edit').value;
  await doControl('EDIT_INSTRUCTION', { attempt: n, instruction_text: text });
}

// Auto-refresh task list every 2 seconds
setInterval(loadTasks, 2000);

// Auto-refresh current task every 3 seconds
setInterval(() => {
  if (currentTaskId) selectTask(currentTaskId);
}, 3000);

// Initial load
loadTasks();
