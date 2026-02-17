// rdloop GUI — Frontend Application
let currentTaskId = null;
let currentAttempt = null;

// Live log polling state (offsets for tail-from-offset API; activeTab preserved across refresh)
let liveLogState = {
  taskId: null,
  coordinatorOffset: 0,
  coderOffset: 0,
  judgeOffset: 0,
  lastAttempt: null,
  activeTab: 'coordinator'
};
let liveLogPollTimer = null;

function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
function escapeAttr(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
         data-task-id="${escapeAttr(t.task_id)}" onclick="selectTask(this.dataset.taskId)">
      <div class="task-id">${escapeHtml(t.task_id)}</div>
      <div class="task-meta">
        ${badge(t.state)}
        attempt ${t.current_attempt} · ${t.last_decision || '-'}
      </div>
    </div>
  `).join('');
}

// Select and load task (preserveAttempt: when true, keep expanded attempt detail on refresh)
async function selectTask(taskId, preserveAttempt) {
  const isSameTask = taskId === currentTaskId;
  currentTaskId = taskId;
  if (!preserveAttempt || !isSameTask) currentAttempt = null;
  const data = await api(`/task/${taskId}`);
  const canPatch = preserveAttempt && isSameTask && document.getElementById('task-badge');
  if (canPatch) {
    updateTaskParts(data);
  } else {
    renderTask(data);
    if (isSameTask && currentAttempt != null) loadAttempt(currentTaskId, currentAttempt);
  }
  loadTasks(); // refresh active state
}

// Update only changing parts (no full re-render) to avoid flash while reading attempt detail
function updateTaskParts(data) {
  const { status, attempts, timeline } = data;
  const s = status || {};
  const badgeEl = document.getElementById('task-badge');
  if (badgeEl) badgeEl.innerHTML = badge(s.state);
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set('info-state', s.state || '-');
  set('info-attempt', `${s.current_attempt || 0} / ${s.max_attempts || '-'}`);
  set('info-decision', s.last_decision || '-');
  set('info-message', s.message || '-');
  const qBlock = document.getElementById('questions-block');
  if (qBlock) {
    if (s.questions_for_user && s.questions_for_user.length > 0) {
      qBlock.innerHTML = `<strong>Questions for user:</strong><ul style="margin-top:8px;padding-left:20px">${s.questions_for_user.map(q => `<li>${escapeHtml(q)}</li>`).join('')}</ul>`;
      qBlock.style.display = '';
    } else {
      qBlock.style.display = 'none';
    }
  }
  const listEl = document.getElementById('attempt-list');
  if (listEl && attempts) {
    listEl.innerHTML = attempts.map(a => {
      const an = parseInt(a.name.replace('attempt_',''), 10);
      return `<div class="attempt-item ${currentAttempt === an ? 'expanded' : ''}" data-task-id="${escapeAttr(currentTaskId)}" data-attempt-num="${an}" onclick="loadAttempt(this.dataset.taskId, parseInt(this.dataset.attemptNum, 10))"><strong>${escapeHtml(a.name)}</strong> — coder rc: ${a.coder_rc ?? '?'} — test rc: ${a.test_rc ?? '?'} — judge: ${a.judge_decision || '?'}${a.diff_stat ? `<br><small style="color:#8b949e">${escapeHtml(a.diff_stat.substring(0, 100))}</small>` : ''}</div>`;
    }).join('') || '<div style="color:#8b949e">No attempts yet</div>';
  }
  const btnRunNext = document.getElementById('btn-run-next');
  if (btnRunNext) {
    const ca = s.current_attempt || 0, ma = s.max_attempts || 0;
    btnRunNext.disabled = ca >= ma;
    btnRunNext.title = ca >= ma ? 'No more attempts' : '';
  }
  if (typeof liveLogState !== 'undefined' && liveLogState && liveLogState.taskId === currentTaskId) {
    liveLogState.lastAttempt = Math.max(1, s.current_attempt || 0);
  }
  const timelineCountEl = document.getElementById('timeline-count');
  if (timelineCountEl) timelineCountEl.textContent = timeline.length;
  const timelineEl = document.getElementById('timeline-inner');
  if (timelineEl && timeline) {
    timelineEl.innerHTML = timeline.slice().reverse().slice(0, 50).map(e => `
      <div class="timeline-item"><span class="ts">${e.ts ? e.ts.substring(11, 19) : ''}</span><span class="type">${e.type}</span><span class="summary">${e.summary || ''}</span></div>
    `).join('');
  }
}

// Render task detail
function renderTask(data) {
  const { task, status, final_summary, attempts, timeline } = data;
  const s = status || {};
  const content = document.getElementById('content');

  content.innerHTML = `
    <h2>${s.task_id || currentTaskId} <span id="task-badge">${badge(s.state)}</span></h2>

    <div class="info-grid">
      <div class="info-card">
        <div class="label">State</div>
        <div class="value" id="info-state">${s.state || '-'}</div>
      </div>
      <div class="info-card">
        <div class="label">Attempt</div>
        <div class="value" id="info-attempt">${s.current_attempt || 0} / ${s.max_attempts || '-'}</div>
      </div>
      <div class="info-card">
        <div class="label">Last Decision</div>
        <div class="value" id="info-decision">${s.last_decision || '-'}</div>
      </div>
      <div class="info-card">
        <div class="label">Message</div>
        <div class="value" id="info-message" style="font-size:13px">${escapeHtml(s.message || '-')}</div>
      </div>
    </div>

    <div id="questions-block" style="background:#d2992233;border:1px solid #d29922;border-radius:8px;padding:12px;margin-bottom:16px;${s.questions_for_user && s.questions_for_user.length > 0 ? '' : 'display:none'}">
      ${s.questions_for_user && s.questions_for_user.length > 0 ? `<strong>Questions for user:</strong><ul style="margin-top:8px;padding-left:20px">${s.questions_for_user.map(q => `<li>${escapeHtml(q)}</li>`).join('')}</ul>` : ''}
    </div>

    <div class="controls">
      <button class="btn btn-danger" onclick="doControl('PAUSE')">Pause</button>
      <button class="btn btn-primary" onclick="doControl('RESUME')">Resume</button>
      <button class="btn btn-primary" id="btn-run-next" ${(s.current_attempt || 0) >= (s.max_attempts || 0) ? 'disabled title="No more attempts"' : ''} onclick="doRunNext()">Run Next</button>
      <button class="btn btn-warn" onclick="doForceRun()">Force Run</button>
    </div>

    <h3>Live output</h3>
    <div class="live-log-panel">
      <div class="live-log-tabs">
        <button type="button" class="live-log-tab active" data-tab="coordinator">Coordinator</button>
        <button type="button" class="live-log-tab" data-tab="coder">Coder</button>
        <button type="button" class="live-log-tab" data-tab="judge">Judge</button>
      </div>
      <div class="live-log-body">
        <pre id="live-log-coordinator" class="live-log-pre"></pre>
        <pre id="live-log-coder" class="live-log-pre hidden"></pre>
        <pre id="live-log-judge" class="live-log-pre hidden"></pre>
      </div>
      <div class="live-log-meta"><span id="live-log-meta-text">Coordinator: </span><code>out/<span id="live-log-task-id">-</span>/gui/run.log</code> <span class="live-log-coord-hint">(only when you run from this GUI; CLI runs do not write here)</span> · Coder/Judge: current attempt. Refreshes every 1.5s.</div>
    </div>

    <h3>Attempts</h3>
    <div class="attempt-list" id="attempt-list">
      ${attempts.map(a => {
        const an = parseInt(a.name.replace('attempt_',''), 10);
        return `
        <div class="attempt-item ${currentAttempt === an ? 'expanded' : ''}" data-task-id="${escapeAttr(currentTaskId)}" data-attempt-num="${an}" onclick="loadAttempt(this.dataset.taskId, parseInt(this.dataset.attemptNum, 10))">
          <strong>${escapeHtml(a.name)}</strong>
          — coder rc: ${a.coder_rc ?? '?'} — test rc: ${a.test_rc ?? '?'} — judge: ${a.judge_decision || '?'}
          ${a.diff_stat ? `<br><small style="color:#8b949e">${escapeHtml(a.diff_stat.substring(0, 100))}</small>` : ''}
        </div>
      `; }).join('') || '<div style="color:#8b949e">No attempts yet</div>'}
    </div>

    <div id="attempt-detail"></div>

    <h3>Timeline (<span id="timeline-count">${timeline.length}</span> events)</h3>
    <div class="timeline" id="timeline-outer">
      <div id="timeline-inner">
      ${timeline.slice().reverse().slice(0, 50).map(e => `
        <div class="timeline-item">
          <span class="ts">${e.ts ? e.ts.substring(11, 19) : ''}</span>
          <span class="type">${e.type}</span>
          <span class="summary">${e.summary || ''}</span>
        </div>
      `).join('')}
      </div>
    </div>
  `;
  content.className = '';

  const taskIdEl = document.getElementById('live-log-task-id');
  if (taskIdEl) taskIdEl.textContent = currentTaskId || '-';
  initLiveLogPanel(currentTaskId, s.current_attempt || 0);
  bindLiveLogTabs();
}

function bindLiveLogTabs() {
  document.querySelectorAll('.live-log-tab').forEach(btn => {
    btn.onclick = function () {
      const tab = this.dataset.tab;
      if (liveLogState) liveLogState.activeTab = tab;
      document.querySelectorAll('.live-log-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.live-log-pre').forEach(p => p.classList.add('hidden'));
      this.classList.add('active');
      const pre = document.getElementById('live-log-' + tab);
      if (pre) pre.classList.remove('hidden');
    };
  });
  // Restore previously selected tab (e.g. after full re-render from control action)
  const tab = (liveLogState && liveLogState.activeTab) || 'coordinator';
  if (tab !== 'coordinator') {
    const btn = document.querySelector('.live-log-tab[data-tab="' + tab + '"]');
    const pre = document.getElementById('live-log-' + tab);
    if (btn && pre) {
      document.querySelectorAll('.live-log-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.live-log-pre').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      pre.classList.remove('hidden');
    }
  }
}

function initLiveLogPanel(taskId, currentAttempt) {
  if (liveLogPollTimer) clearInterval(liveLogPollTimer);
  liveLogPollTimer = null;
  if (!taskId) return;
  const prevTab = (liveLogState && liveLogState.activeTab) || 'coordinator';
  liveLogState = {
    taskId,
    coordinatorOffset: 0,
    coderOffset: 0,
    judgeOffset: 0,
    lastAttempt: Math.max(0, currentAttempt || 0),
    activeTab: prevTab
  };
  liveLogPollTimer = setInterval(pollLiveLogs, 1500);
  pollLiveLogs();
}

async function pollLiveLogs() {
  if (!currentTaskId || currentTaskId !== liveLogState.taskId) return;
  const taskId = liveLogState.taskId;

  try {
    const taskRes = await api('/task/' + taskId);
    const currentAttempt = Math.max(1, taskRes.status?.current_attempt || 0);
    if (currentAttempt > liveLogState.lastAttempt) {
      liveLogState.coderOffset = 0;
      liveLogState.judgeOffset = 0;
      liveLogState.lastAttempt = currentAttempt;
    }

    const coordRes = await fetch('/api/task/' + taskId + '/logs/coordinator?offset=' + liveLogState.coordinatorOffset).then(r => r.json());
    if (coordRes.content) {
      const el = document.getElementById('live-log-coordinator');
      if (el) { el.textContent += coordRes.content; el.scrollTop = el.scrollHeight; }
    }
    liveLogState.coordinatorOffset = coordRes.nextOffset ?? liveLogState.coordinatorOffset;

    const coderRes = await fetch('/api/task/' + taskId + '/logs/attempt/' + currentAttempt + '/coder?offset=' + liveLogState.coderOffset).then(r => r.json());
    if (coderRes.content) {
      const el = document.getElementById('live-log-coder');
      if (el) { el.textContent += coderRes.content; el.scrollTop = el.scrollHeight; }
    }
    liveLogState.coderOffset = coderRes.nextOffset ?? liveLogState.coderOffset;

    const judgeRes = await fetch('/api/task/' + taskId + '/logs/attempt/' + currentAttempt + '/judge?offset=' + liveLogState.judgeOffset).then(r => r.json());
    if (judgeRes.content) {
      const el = document.getElementById('live-log-judge');
      if (el) { el.textContent += judgeRes.content; el.scrollTop = el.scrollHeight; }
    }
    liveLogState.judgeOffset = judgeRes.nextOffset ?? liveLogState.judgeOffset;
  } catch (_) {}
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
      <textarea id="instruction-edit">${escapeHtml(data.instruction || '(none)')}</textarea>
      <button class="btn" onclick="saveInstruction(${n})" style="margin-top:8px">Save Instruction</button>

      <h3>Coder (rc: ${data.coder_rc ?? '?'})</h3>
      <pre>${escapeHtml(data.coder_run_log || '(no coder run log)')}</pre>

      <h3>Test Result (rc: ${data.test_rc || '?'})</h3>
      <pre>${escapeHtml(data.test_log || '(no log)')}</pre>

      <h3>Diff Stat</h3>
      <pre>${escapeHtml(data.diff_stat || '(no diff)')}</pre>

      <h3>Judge (rc: ${data.judge_rc ?? '?'})</h3>
      <pre>${escapeHtml(data.judge_run_log || '(no judge run log)')}</pre>

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
  setTimeout(() => selectTask(currentTaskId, true), 500);
}

async function doRunNext() {
  if (!currentTaskId) return;
  await doControl('RUN_NEXT');
  await api(`/task/${currentTaskId}/run`, { method: 'POST' });
  setTimeout(() => selectTask(currentTaskId, true), 1000);
}

async function doForceRun() {
  if (!currentTaskId) return;
  await api(`/task/${currentTaskId}/run?force=1`, { method: 'POST' });
  setTimeout(() => selectTask(currentTaskId, true), 1000);
}

async function saveInstruction(n) {
  if (!currentTaskId) return;
  const text = document.getElementById('instruction-edit').value;
  await doControl('EDIT_INSTRUCTION', { attempt: n, instruction_text: text });
}

// Auto-refresh task list every 2 seconds
setInterval(loadTasks, 2000);

// Auto-refresh current task every 3 seconds (preserve expanded attempt detail)
setInterval(() => {
  if (currentTaskId) selectTask(currentTaskId, true);
}, 3000);

// Initial load
loadTasks();
