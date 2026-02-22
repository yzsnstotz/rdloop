// rdloop GUI — Frontend Application
// B1: Live Panel with tab persistence, etag/304 no-flash refresh
// A2: TaskSpec CRUD (new/copy/delete/edit)
// A4: task_type selector + rubric_thresholds config
// A5: Adapter healthcheck selector
// B3: Attempt API fixed field set
// E2: XSS prevention — all dynamic DOM insertion uses escapeHtml

let currentTaskId = null;
let currentAttempt = null;

// B1-1: activeTab persisted in sessionStorage
let activeTab = sessionStorage.getItem('rdloop_activeTab') || 'coordinator';

// B1-4: AutoScroll persisted in localStorage
let autoScroll = localStorage.getItem('rdloop_autoScroll') !== 'false';

// B1-2: etag per logName for If-None-Match
let liveLogEtag = {};

// Tab → logName mapping
const TAB_LOG_MAP = {
  coordinator: 'coordinator.log',
  coder: 'coder.log',
  judge: 'judge.log'
};

// ================================================================
// E2: C0-1: XSS prevention — escapeHtml applied to ALL dynamic content
// ================================================================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

// Decode JSON-style Unicode escapes (\uXXXX) so coder_output and evidence display correctly
function decodeUnicodeEscapes(str) {
  if (str == null || typeof str !== 'string') return '';
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Badge helper (state display only — no user content)
function badge(state) {
  const cls = {
    'RUNNING': 'badge-running', 'PAUSED': 'badge-paused',
    'READY_FOR_REVIEW': 'badge-ready', 'FAILED': 'badge-failed'
  }[state] || '';
  return `<span class="badge ${cls}">${escapeHtml(state || 'UNKNOWN')}</span>`;
}

// Fetch helper
async function api(path, opts) {
  const res = await fetch(`/api${path}`, opts);
  return res.json();
}

// K7-1: READ_ONLY from /api/health; disable write buttons and show banner
let readOnlyMode = false;
async function loadHealth() {
  try {
    const d = await api('/health');
    readOnlyMode = d.read_only === true;
  } catch { readOnlyMode = false; }
  const banner = document.getElementById('read-only-banner');
  if (readOnlyMode) {
    if (!banner) {
      const el = document.createElement('div');
      el.id = 'read-only-banner';
      el.style.cssText = 'padding:8px 16px;background:#d2992233;border-bottom:1px solid #d29922;color:#d29922;font-size:13px;text-align:center';
      el.textContent = 'Read-only mode: writes are disabled.';
      document.body.prepend(el);
    }
    document.querySelectorAll('.write-action').forEach(b => { b.disabled = true; });
  } else {
    if (banner) banner.remove();
    document.querySelectorAll('.write-action').forEach(b => { b.disabled = false; });
  }
}

// K7-1: Re-apply read-only disabled state to all .write-action buttons (call after dynamic content that adds write buttons)
function updateReadOnlyBanner() {
  document.querySelectorAll('.write-action').forEach(b => { b.disabled = readOnlyMode; });
}

// Permanently hidden task IDs (frontend). × removes from sidebar; no "Show all" to restore.
function getHiddenTasks() {
  try {
    const raw = localStorage.getItem('rdloop_hiddenTasks');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function setHiddenTasks(ids) {
  localStorage.setItem('rdloop_hiddenTasks', JSON.stringify(ids));
}
async function hideTask(taskId, e) {
  if (e) e.stopPropagation();
  try {
    await fetch(`/api/tasks/${encodeURIComponent(taskId)}/record-hidden`, { method: 'POST' });
  } catch (_) { /* best effort */ }
  const ids = getHiddenTasks();
  if (!ids.includes(taskId)) ids.push(taskId);
  setHiddenTasks(ids);
  loadTasks();
}

// Load task list (sidebar) — running tasks from out/; filter hidden
// Request enough items so completed tasks are not pushed off by default limit (6)
async function loadTasks() {
  const data = await api('/tasks?limit=100');
  const list = document.getElementById('task-list');
  const allItems = data.items || data.tasks || [];
  const hidden = getHiddenTasks();
  const items = allItems.filter(t => !hidden.includes(t.task_id));
  const hiddenCount = allItems.length - items.length;

  if (items.length === 0) {
    let msg = 'No tasks found.<br>Run examples/run_hello.sh first.';
    if (allItems.length > 0) {
      msg = escapeHtml(String(allItems.length)) + ' task(s) in total; all have been removed from the list.';
    }
    list.innerHTML = `<div style="padding:16px;color:#8b949e">${msg}</div>`;
    return;
  }
  list.innerHTML = `
    ${hiddenCount > 0 ? `<div style="padding:8px 12px 4px;font-size:11px;color:#8b949e">${escapeHtml(String(hiddenCount))} removed from list</div>` : ''}
    ${items.map(t => `
    <div class="task-item ${t.task_id === currentTaskId ? 'active' : ''}"
         onclick="selectTask('${escapeHtml(t.task_id)}')">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:4px">
        <div style="min-width:0;flex:1">
          <div class="task-id">${escapeHtml(t.task_id)}</div>
          <div class="task-meta">
            ${badge(t.state)}
            attempt ${escapeHtml(String(t.current_attempt || 0))} · ${escapeHtml(t.last_decision || '-')}
          </div>
        </div>
        <button type="button" class="btn write-action" style="flex-shrink:0;padding:2px 6px;font-size:12px;line-height:1;opacity:0.7" onclick="hideTask('${escapeHtml(t.task_id)}', event)" title="Hide from list">×</button>
      </div>
    </div>
  `).join('')}
  `;
}

// B1-2/B1-3/B1-4: Fetch log for a specific tab (always latest content for live panel).
async function fetchTabLog(taskId, logName, force) {
  const logContainer = document.getElementById('live-log-content');
  const lastRefreshed = document.getElementById('live-log-ts');
  if (!logContainer || taskId !== currentTaskId) return;

  const headers = {};
  // B1-2: send If-None-Match unless forcing full fetch
  if (!force && liveLogEtag[logName]) {
    headers['If-None-Match'] = `"${liveLogEtag[logName]}"`;
  }

  let res;
  try {
    res = await fetch(`/api/task/${taskId}/log/${logName}`, { headers });
  } catch {
    return; // network error, silently skip
  }

  // B1-3: 304 → only update timestamp, NO DOM replacement
  if (res.status === 304) {
    if (lastRefreshed) lastRefreshed.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;
    return;
  }

  if (!res.ok) {
    // C2-3: fixed "no logs" message when file absent
    logContainer.textContent = `No logs found for role=${activeTab}`;
    if (lastRefreshed) lastRefreshed.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;
    return;
  }

  // Update etag from response
  const etag = res.headers.get('ETag');
  if (etag) {
    liveLogEtag[logName] = etag.replace(/^"|"$/g, '');
  }

  const text = await res.text();

  // B1-4: save scroll position before updating content
  const scrollEl = document.getElementById('live-log-scroll');
  let wasAtBottom = true;
  let savedScrollTop = 0;
  if (scrollEl) {
    savedScrollTop = scrollEl.scrollTop;
    wasAtBottom = (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight) < 40;
  }

  // Update content (only the log container, not the full page — B1-3)
  logContainer.textContent = text;

  // B1-4: restore scroll position
  if (scrollEl) {
    if (autoScroll && wasAtBottom) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    } else {
      scrollEl.scrollTop = savedScrollTop;
    }
  }

  if (lastRefreshed) lastRefreshed.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`;
}

// B1-1: Switch tab — persist + load log
function switchTab(tab) {
  activeTab = tab;
  sessionStorage.setItem('rdloop_activeTab', tab);

  // Update tab button active state without re-rendering tabs
  ['coordinator', 'coder', 'judge'].forEach(t => {
    const btn = document.getElementById(`tab-${t}`);
    if (btn) btn.className = `tab-btn${t === tab ? ' active' : ''}`;
  });

  // Force-load this tab (clear etag to force fresh fetch)
  const logName = TAB_LOG_MAP[tab];
  if (logName && currentTaskId) {
    const logContainer = document.getElementById('live-log-content');
    if (logContainer) logContainer.textContent = 'Loading...';
    fetchTabLog(currentTaskId, logName, true);
  }
}

// B1-4: AutoScroll toggle
function toggleAutoScroll(val) {
  autoScroll = val;
  localStorage.setItem('rdloop_autoScroll', val ? 'true' : 'false');
}

// B1 timer: refresh only current tab's log (not full selectTask)
function refreshLiveLog() {
  if (!currentTaskId) return;
  const logName = TAB_LOG_MAP[activeTab];
  if (logName) fetchTabLog(currentTaskId, logName, false);
}

// Lightweight meta update — does NOT reset tab/scroll (B1-1)
async function refreshCurrentTaskMeta() {
  if (!currentTaskId) return;
  try {
    const data = await api(`/task/${currentTaskId}`);
    updateTaskMeta(data);
  } catch { /* silently skip */ }
}

// Update only the info-grid elements by ID — no innerHTML full-replace
function updateTaskMeta(data) {
  const s = data.status || {};

  const headingBadge = document.getElementById('task-heading-badge');
  if (headingBadge) headingBadge.innerHTML = badge(s.state);

  const metaState = document.getElementById('meta-state');
  if (metaState) metaState.innerHTML = badge(s.state);

  const metaAttempt = document.getElementById('meta-attempt');
  if (metaAttempt) metaAttempt.textContent = `${s.current_attempt || 0} / ${s.max_attempts || s.effective_max_attempts || '-'}`;

  const metaDecision = document.getElementById('meta-decision');
  if (metaDecision) metaDecision.textContent = s.last_decision || '-';

  const metaMsg = document.getElementById('meta-message');
  if (metaMsg) metaMsg.textContent = s.message || '-';
}

// Select and load task (full render only on task change)
async function selectTask(taskId) {
  const needsFullRender = (taskId !== currentTaskId);
  currentTaskId = taskId;
  currentAttempt = null;

  // Reset etags on task change
  if (needsFullRender) liveLogEtag = {};

  const data = await api(`/task/${taskId}`);

  if (needsFullRender) {
    renderTask(data);
  } else {
    updateTaskMeta(data);
  }

  loadTasks(); // refresh active state in sidebar
}

// Full task render — called once per task switch
function renderTask(data) {
  const { task, status, final_summary, attempts, timeline } = data;
  const s = status || {};
  const content = document.getElementById('content');

  content.innerHTML = `
    <h2 id="task-heading">${escapeHtml(s.task_id || currentTaskId)} <span id="task-heading-badge">${badge(s.state)}</span></h2>

    <div class="info-grid">
      <div class="info-card">
        <div class="label">State</div>
        <div class="value" id="meta-state">${badge(s.state)}</div>
      </div>
      <div class="info-card">
        <div class="label">Attempt</div>
        <div class="value" id="meta-attempt">${escapeHtml(String(s.current_attempt || 0))} / ${escapeHtml(String(s.max_attempts || s.effective_max_attempts || '-'))}</div>
      </div>
      <div class="info-card">
        <div class="label">Last Decision</div>
        <div class="value" id="meta-decision">${escapeHtml(s.last_decision || '-')}</div>
      </div>
      <div class="info-card">
        <div class="label">Message</div>
        <div class="value" id="meta-message" style="font-size:13px">${escapeHtml(s.message || '-')}</div>
      </div>
    </div>

    ${s.questions_for_user && s.questions_for_user.length > 0 ? `
      <div style="background:#d2992233;border:1px solid #d29922;border-radius:8px;padding:12px;margin-bottom:16px">
        <strong>Questions for user:</strong>
        <ul style="margin-top:8px;padding-left:20px">
          ${s.questions_for_user.map(q => `<li>${escapeHtml(q)}</li>`).join('')}
        </ul>
      </div>
    ` : ''}

    <div class="controls">
      <button class="btn btn-danger write-action" ${(s.state !== 'RUNNING') ? 'disabled' : ''} onclick="doControl('PAUSE')" title="Takes effect at next checkpoint when coordinator is running">Pause</button>
      <button class="btn btn-primary write-action" ${(s.state === 'RUNNING') ? 'disabled' : ''} onclick="doResume()" title="Resume and start coordinator">Resume</button>
      <button class="btn btn-primary write-action" ${(s.state === 'RUNNING') ? 'disabled' : ''} onclick="doRunNext()" title="Set RUN_NEXT and start coordinator (when PAUSED)">Run Next</button>
      <button class="btn btn-warn write-action" onclick="doForceRun()" title="Start coordinator ignoring lock (only if task is stuck)">Force Run</button>
      <button class="btn write-action" onclick="openUserInputModal()" title="E5/E5-2: Insert user input (written to user_input.jsonl; coordinator consumes on next run)">Insert user input</button>
    </div>

    <!-- B1: Live Log Panel with tab persistence -->
    <div class="live-panel">
      <div class="live-panel-header">
        <div class="tab-bar">
          <button id="tab-coordinator" class="tab-btn${activeTab === 'coordinator' ? ' active' : ''}" onclick="switchTab('coordinator')">Coordinator</button>
          <button id="tab-coder" class="tab-btn${activeTab === 'coder' ? ' active' : ''}" onclick="switchTab('coder')">Coder</button>
          <button id="tab-judge" class="tab-btn${activeTab === 'judge' ? ' active' : ''}" onclick="switchTab('judge')">Judge</button>
        </div>
        <div class="live-panel-controls">
          <button type="button" class="btn" style="font-size:11px;padding:2px 8px" onclick="if(currentTaskId){ fetchTabLog(currentTaskId, TAB_LOG_MAP[activeTab], true); }" title="Refresh current tab log">Refresh</button>
          <label style="font-size:12px;color:#8b949e;cursor:pointer">
            <input type="checkbox" id="autoscroll-toggle" ${autoScroll ? 'checked' : ''} onchange="toggleAutoScroll(this.checked)">
            AutoScroll
          </label>
          <span id="live-log-ts" style="font-size:11px;color:#8b949e;margin-left:8px"></span>
        </div>
      </div>
      <div id="live-log-scroll" class="live-log-scroll">
        <pre id="live-log-content" class="live-log-content">Loading...</pre>
      </div>
    </div>

    <h3>Attempts</h3>
    <div class="attempt-list" id="attempt-list">
      ${(attempts || []).map(a => `
        <div class="attempt-item" onclick="loadAttempt('${escapeHtml(currentTaskId)}', ${parseInt(a.name.replace('attempt_', ''))})">
          <strong>${escapeHtml(a.name)}</strong>
          — test rc: ${escapeHtml(String(a.test_rc ?? '?'))}
          — judge: ${escapeHtml(a.judge_decision || '?')}
          ${(task && (task.task_type === 'engineering_impl' || task.task_type === 'engineering_implementation') && a.diff_stat) ? `<br><small style="color:#8b949e">${escapeHtml(a.diff_stat.substring(0, 100))}</small>` : ''}
        </div>
      `).join('') || '<div style="color:#8b949e">No attempts yet</div>'}
    </div>

    <div id="attempt-detail"></div>

    <h3>Timeline (${escapeHtml(String((timeline || []).length))} events)</h3>
    <div class="timeline">
      ${(timeline || []).slice().reverse().slice(0, 50).map(e => `
        <div class="timeline-item">
          <span class="ts">${escapeHtml(e.ts ? e.ts.substring(11, 19) : '')}</span>
          <span class="type">${escapeHtml(e.type)}</span>
          <span class="summary">${escapeHtml(e.summary || '')}</span>
        </div>
      `).join('')}
    </div>
  `;
  content.className = '';

  // K7-1: apply read-only state to write-action buttons in task panel
  updateReadOnlyBanner();

  // Immediately load the active tab's log
  const logName = TAB_LOG_MAP[activeTab];
  if (logName) fetchTabLog(currentTaskId, logName, true);
}

// B3-2: Load attempt detail — uses fixed field set from API. Live panel always shows latest attempt logs (not tied to selected attempt).
async function loadAttempt(taskId, n) {
  currentAttempt = n;
  const data = await api(`/task/${taskId}/attempt/${n}`);
  const detail = document.getElementById('attempt-detail');

  // B3-2: Use fixed fields from API (task_id, attempt, role, paths, rc, updated_at, verdict_summary)
  const vs = data.verdict_summary || {};
  const paths = data.paths || {};

  detail.innerHTML = `
    <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin:16px 0">
      <h3>Attempt ${escapeHtml(String(n))} Detail
        <small style="color:#8b949e;font-size:13px;margin-left:8px">role: ${escapeHtml(data.role || 'coder')}</small>
      </h3>

      ${vs.final_score_0_100 !== null && vs.final_score_0_100 !== undefined ? `
        <div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px;margin-bottom:12px">
          <strong>Verdict Summary</strong>
          <div style="margin-top:6px;font-size:13px">
            Score: <strong>${escapeHtml(String(vs.final_score_0_100))}/100</strong>
            · Gated: <strong>${escapeHtml(String(vs.gated ?? '-'))}</strong>
            ${vs.pause_reason_code ? ` · Reason: <strong>${escapeHtml(vs.pause_reason_code)}</strong>` : ''}
          </div>
          ${vs.top_issues && vs.top_issues.length > 0 ? `
            <div style="margin-top:6px;font-size:12px;color:#8b949e">
              Top issues: ${vs.top_issues.map(i => escapeHtml(i)).join(' · ')}
            </div>
          ` : ''}
        </div>
      ` : ''}

      ${Object.values(paths).some(v => v !== null) ? `
        <div style="margin-bottom:12px;font-size:12px;color:#8b949e">
          <strong>Paths:</strong>
          ${Object.entries(paths).filter(([, v]) => v !== null).map(([k, v]) =>
            `<div>${escapeHtml(k)}: <code>${escapeHtml(v)}</code></div>`
          ).join('')}
        </div>
      ` : ''}

      <div style="margin-bottom:8px;font-size:12px;color:#8b949e">
        RC: ${escapeHtml(String(data.rc ?? '?'))} · Updated: ${escapeHtml(data.updated_at || '-')}
      </div>

      <h3>Coder input (instruction)</h3>
      <textarea id="instruction-edit">${escapeHtml(data.instruction || '(none)')}</textarea>
      <button class="btn write-action" onclick="saveInstruction(${escapeHtml(String(n))})" style="margin-top:8px">Save Instruction</button>

      <h3>Coder output</h3>
      <pre class="attempt-block">${escapeHtml(decodeUnicodeEscapes(data.coder_output) || '(no coder output)')}</pre>

      <h3>Judge input (prompt + evidence)</h3>
      <p style="font-size:12px;color:#8b949e">Prompt given to judge:</p>
      <pre class="attempt-block">${escapeHtml(data.judge_prompt_text || '(no prompt file)')}</pre>
      <p style="font-size:12px;color:#8b949e;margin-top:8px">Evidence JSON appended to prompt:</p>
      <pre class="attempt-block">${escapeHtml(data.evidence ? decodeUnicodeEscapes(JSON.stringify(data.evidence, null, 2)) : '(no evidence)')}</pre>

      <h3>Judge output (verdict)</h3>
      <pre class="attempt-block">${escapeHtml(data.verdict ? JSON.stringify(data.verdict, null, 2) : '(no verdict)')}</pre>

      ${(data.task_type === 'engineering_impl' || data.task_type === 'engineering_implementation') ? `
      <h3>Test Result (rc: ${escapeHtml(String(data.test_rc || data.rc || '?'))})</h3>
      <pre class="attempt-block">${escapeHtml(data.test_log || '(no log)')}</pre>

      <h3>Diff Stat</h3>
      <pre class="attempt-block">${escapeHtml(data.diff_stat || '(no diff)')}</pre>
      ` : ''}

      <h3>Metrics</h3>
      <pre class="attempt-block">${escapeHtml(data.metrics ? JSON.stringify(data.metrics, null, 2) : '(no metrics)')}</pre>
    </div>
  `;
  updateReadOnlyBanner();
}

// Control actions — B1-1: use refreshCurrentTaskMeta instead of selectTask to preserve tab
async function doControl(action, payload) {
  if (!currentTaskId) return;
  await api(`/task/${currentTaskId}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload: payload || {} })
  });
  // B1-1: only refresh meta, do NOT trigger full re-render / tab reset
  setTimeout(refreshCurrentTaskMeta, 500);
}

// Run Next: set RUN_NEXT (so --continue will advance from PAUSED) then start coordinator
async function doRunNext() {
  if (!currentTaskId) return;
  await doControl('RUN_NEXT');
  const result = await api(`/task/${currentTaskId}/run`, { method: 'POST' }).catch(e => ({ error: e?.message || String(e) }));
  if (result && result.error) {
    if (String(result.error).includes('already running') || String(result.hint || '').includes('lock')) {
      alert('Task is already running. Pause first if you want to stop it.');
      return;
    }
    alert(result.error);
    return;
  }
  setTimeout(refreshCurrentTaskMeta, 1000);
}

// Resume: set RESUME then start coordinator (one click = resume + run)
async function doResume() {
  if (!currentTaskId) return;
  await doControl('RESUME');
  const result = await api(`/task/${currentTaskId}/run`, { method: 'POST' }).catch(e => ({ error: e?.message || String(e) }));
  if (result && result.error) {
    if (String(result.error).includes('already running') || String(result.hint || '').includes('lock')) {
      alert('Task is already running.');
      return;
    }
    alert(result.error);
    return;
  }
  setTimeout(refreshCurrentTaskMeta, 1000);
}

// Force Run: start coordinator ignoring lock (use only when task is stuck)
async function doForceRun() {
  if (!currentTaskId) return;
  if (!confirm('Force Run ignores the running lock. Use only if the task is stuck. Continue?')) return;
  await api(`/task/${currentTaskId}/run?force=1`, { method: 'POST' });
  setTimeout(refreshCurrentTaskMeta, 1000);
}

async function saveInstruction(n) {
  if (!currentTaskId) return;
  const text = document.getElementById('instruction-edit').value;
  await doControl('EDIT_INSTRUCTION', { attempt: n, instruction_text: text });
}

// E5/E5-2: GUI "Insert user input" window — writes to user_input.jsonl (fixed schema); coordinator consumes and writes last_user_input_ts_consumed
function openUserInputModal() {
  if (!currentTaskId) return;
  const old = document.getElementById('user-input-modal');
  if (old) old.remove();
  const requestId = 'gui-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  const modalHtml = `
    <div id="user-input-modal" class="modal-overlay" onclick="if(event.target===this)closeUserInputModal()">
      <div class="modal-box" style="max-width:520px">
        <h3 style="margin-top:0">Insert user input</h3>
        <p style="font-size:12px;color:#8b949e;margin-bottom:12px">Text will be appended to <code>user_input.jsonl</code>. Coordinator consumes it on the next run and writes <code>last_user_input_ts_consumed</code>.</p>
        <label class="form-label">Your input (text)</label>
        <textarea id="user-input-text" class="form-input" rows="4" placeholder="Answer or instruction for the task..."></textarea>
        <div id="user-input-msg" style="font-size:12px;margin-top:8px;color:#f85149"></div>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-primary write-action" onclick="submitUserInput()">Submit</button>
          <button class="btn" onclick="closeUserInputModal()">Cancel</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  updateReadOnlyBanner();
  document.getElementById('user-input-text').focus();
}

function closeUserInputModal() {
  const modal = document.getElementById('user-input-modal');
  if (modal) modal.remove();
}

async function submitUserInput() {
  if (!currentTaskId) return;
  const textEl = document.getElementById('user-input-text');
  const msgEl = document.getElementById('user-input-msg');
  const text = (textEl && textEl.value || '').trim();
  if (!text) {
    if (msgEl) msgEl.textContent = 'Please enter some text.';
    return;
  }
  if (msgEl) msgEl.textContent = '';
  const requestId = 'gui-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  try {
    const res = await fetch(`/api/tasks/${encodeURIComponent(currentTaskId)}/user_input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, request_id: requestId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (msgEl) msgEl.textContent = data.error || 'Request failed';
      return;
    }
    closeUserInputModal();
    refreshCurrentTaskMeta();
  } catch (e) {
    if (msgEl) msgEl.textContent = e.message || 'Request failed';
  }
}

// ================================================================
// A2: Task Spec CRUD — list, new, edit, copy, delete
// A4: task_type + rubric_thresholds
// A5: adapter selector
// ================================================================

let cachedAdapters = null;
let cachedCliapiProviders = {};
// C1-1: when false, PARTIAL adapters must not be selectable as default or for Run
let cachedAllowPartialRun = false;
let cachedRubric = {};

// A1-2: Selected spec for detail view (task_id or null)
let selectedSpecTaskId = null;

// Load task specs list (A1-2: task_id, task_type, scoring_mode, updated_at; click → detail)
async function loadTaskSpecs() {
  const data = await api('/task_specs');
  const specs = data.specs || [];
  const container = document.getElementById('task-specs-list');
  if (!container) return;

  if (specs.length === 0) {
    container.innerHTML = '<div style="padding:8px;color:#8b949e;font-size:12px">No task specs found.</div>';
    return;
  }

  container.innerHTML = specs.map(s => `
    <div class="task-item ${s.task_id === selectedSpecTaskId ? 'active' : ''}" style="padding:8px 12px;cursor:pointer"
         onclick="showSpecDetail('${escapeHtml(s.task_id)}')">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div class="task-id" style="font-size:12px">${escapeHtml(s.task_id)}</div>
          <div style="font-size:11px;color:#8b949e">
            ${escapeHtml(s.task_type || 'no type')} · ${escapeHtml(s.scoring_mode || '')} · ${escapeHtml(s.updated_at ? s.updated_at.slice(0, 19) + 'Z' : '')}
          </div>
        </div>
        <div style="display:flex;gap:4px" onclick="event.stopPropagation()">
          <button class="btn write-action" style="padding:3px 8px;font-size:11px"
            onclick="openEditSpecModal('${escapeHtml(s.task_id)}')">Edit</button>
          <button class="btn write-action" style="padding:3px 8px;font-size:11px"
            onclick="copySpec('${escapeHtml(s.task_id)}')">Copy</button>
          <button class="btn btn-danger write-action" style="padding:3px 8px;font-size:11px"
            onclick="deleteSpec('${escapeHtml(s.task_id)}')">Del</button>
        </div>
      </div>
    </div>
  `).join('');
  updateReadOnlyBanner();
}

// A1-3: Show task spec detail in main content (full JSON + key fields + Run task)
async function showSpecDetail(taskId) {
  selectedSpecTaskId = taskId;
  loadTaskSpecs();
  const content = document.getElementById('content');
  content.innerHTML = '<div style="padding:16px;color:#8b949e">Loading...</div>';
  try {
    const data = await api(`/task_specs/${encodeURIComponent(taskId)}`);
    const spec = data.spec || {};
    const keys = ['task_id', 'goal', 'task_type', 'scoring_mode', 'rubric_thresholds', 'coder', 'judge', 'coder_model', 'judge_model'];
    const keyFields = keys.map(k => {
      const v = spec[k];
      const str = v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      return `<div style="margin-bottom:6px"><strong>${escapeHtml(k)}</strong>: ${escapeHtml(str)}</div>`;
    }).join('');
    content.innerHTML = `
      <h2>${escapeHtml(taskId)} <span style="font-size:14px;color:#8b949e">Task Spec</span></h2>
      <div style="margin-bottom:16px">
        <strong>Key fields</strong>
        <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px;margin-top:8px;font-size:12px">
          ${keyFields}
        </div>
      </div>
      <div style="margin-bottom:16px">
        <button class="btn btn-primary" onclick="runTaskFromSpec('${escapeHtml(taskId)}')">Run task</button>
        <span id="spec-run-msg" style="margin-left:8px;font-size:12px;color:#8b949e"></span>
      </div>
      <div style="margin-bottom:8px"><strong>Full JSON</strong></div>
      <pre class="code-editor" style="background:#0d1117;padding:12px;border-radius:8px;overflow:auto;max-height:400px;font-size:12px">${escapeHtml(JSON.stringify(spec, null, 2))}</pre>
    `;
  } catch (e) {
    content.innerHTML = `<div style="padding:16px;color:#f85149">Failed to load spec: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

async function runTaskFromSpec(taskId) {
  const msgEl = document.getElementById('spec-run-msg');
  if (msgEl) msgEl.textContent = 'Starting...';
  try {
    const result = await fetch(`/api/task_specs/${encodeURIComponent(taskId)}/run`, { method: 'POST' });
    const data = await result.json();
    if (!result.ok) {
      if (msgEl) msgEl.textContent = data.error || 'Failed';
      return;
    }
    if (msgEl) msgEl.textContent = 'Started (pid: ' + (data.pid || '') + '). Select task in sidebar to watch.';
    loadTasks();
  } catch (e) {
    if (msgEl) msgEl.textContent = 'Error: ' + (e.message || String(e));
  }
}

// A5: Load adapters and cliapi providers; A6: apply saved defaults when present
async function loadAdapters() {
  try {
    const data = await api('/adapters');
    cachedAdapters = data.adapters || [];
    cachedAllowPartialRun = data.allow_partial_run === true;
  } catch {
    cachedAdapters = [];
    cachedAllowPartialRun = false;
  }
  try {
    const cliapi = await api('/cliapi-providers');
    cachedCliapiProviders = cliapi.providers || {};
  } catch {
    cachedCliapiProviders = {};
  }
}

// A6-1: Save current adapter selection as default (rdloop.config.json)
async function saveAdaptersAsDefault() {
  const coderEl = document.getElementById('adapter-coder');
  const judgeEl = document.getElementById('adapter-judge');
  const coderModelEl = document.getElementById('adapter-coder-model');
  const judgeModelEl = document.getElementById('adapter-judge-model');
  const default_coder = coderEl ? coderEl.value : null;
  const default_judge = judgeEl ? judgeEl.value : null;
  const default_coder_model = coderModelEl && coderModelEl.value ? coderModelEl.value : null;
  const default_judge_model = judgeModelEl && judgeModelEl.value ? judgeModelEl.value : null;
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        default_coder: default_coder || null,
        default_judge: default_judge || null,
        default_coder_model: default_coder_model || null,
        default_judge_model: default_judge_model || null
      })
    });
    const data = await res.json();
    if (!res.ok) {
      alert('Failed to save default: ' + (data.error || ''));
      return;
    }
    const notice = document.getElementById('task-specs-notice');
    if (notice) notice.textContent = 'Default adapters saved.';
    setTimeout(() => { if (notice) notice.textContent = ''; }, 3000);
  } catch (e) {
    alert('Failed to save default: ' + (e.message || ''));
  }
}

// A4: Load rubric for a task_type and cache
async function loadRubric(taskType) {
  if (!taskType || cachedRubric[taskType]) return cachedRubric[taskType] || null;
  try {
    const data = await api(`/rubric/${encodeURIComponent(taskType)}`);
    if (data.dimensions) {
      cachedRubric[taskType] = data;
    }
    return cachedRubric[taskType] || null;
  } catch {
    return null;
  }
}

// A5: Build adapter selector — show all detected adapters except mock* and unavailable.
// Always include codex-cli and claude-cli as options (user-configured). C1-1: when !cachedAllowPartialRun, exclude other PARTIAL adapters.
function buildAdapterSelectorOnly(role, selectedName) {
  const isMock = (name) => ['mock', 'mock-timeout', 'mock_need_input'].includes(name);
  const alwaysInclude = (name) => name === 'codex-cli' || name === 'claude-cli';
  let adapters = (cachedAdapters || []).filter(a => {
    if (a.type !== role) return false;
    if (isMock(a.name)) return false;
    if (a.status !== 'OK' && !alwaysInclude(a.name)) return false;
    if (!cachedAllowPartialRun && a.support_level === 'PARTIAL' && !alwaysInclude(a.name)) return false;
    return true;
  });
  if (adapters.length === 0) {
    return `<select id="adapter-${role}" class="form-select" onchange="refreshModelSelector('${role}')"><option value="">Loading...</option></select>`;
  }
  const options = adapters.map(a => {
    const disabled = a.status !== 'OK' ? 'disabled' : '';
    const label = `${a.name} [${a.status}]${a.reason ? ' — ' + a.reason : ''}`;
    const sel = a.name === selectedName ? 'selected' : '';
    return `<option value="${escapeHtml(a.name)}" ${disabled} ${sel}>${escapeHtml(label)}</option>`;
  }).join('');
  return `<select id="adapter-${role}" class="form-select" onchange="refreshModelSelector('${role}')">${options}</select>`;
}

// Cliapi: provider + optional model (second-level) selector. selectedModel = model id or ''
function buildAdapterSelector(role, selectedProvider, selectedModel) {
  const providerHtml = buildAdapterSelectorOnly(role, selectedProvider || '');
  const models = (cachedCliapiProviders[selectedProvider] && cachedCliapiProviders[selectedProvider].models) || [];
  const showModel = models.length > 0;
  let modelOptions = '<option value="">— default —</option>';
  if (showModel) {
    modelOptions = models.map(m => {
      const sel = (selectedModel && m.id === selectedModel) ? 'selected' : '';
      return `<option value="${escapeHtml(m.id)}" ${sel}>${escapeHtml(m.alias || m.id)}</option>`;
    }).join('');
  }
  const modelWrapStyle = showModel ? '' : 'display:none';
  return `
    <div class="adapter-row-${role}" style="display:flex;flex-direction:column;gap:6px">
      ${providerHtml}
      <div id="${role}-model-wrap" class="model-wrap" style="${modelWrapStyle};margin-top:4px">
        <label class="form-label" style="font-size:11px;color:#8b949e">Model (cliapi)</label>
        <select id="adapter-${role}-model" class="form-select" style="font-size:12px">${modelOptions}</select>
      </div>
    </div>`;
}

// When provider changes: show/hide model dropdown and repopulate options
function refreshModelSelector(role) {
  const provEl = document.getElementById(`adapter-${role}`);
  const wrapEl = document.getElementById(`${role}-model-wrap`);
  const modelEl = document.getElementById(`adapter-${role}-model`);
  if (!provEl || !wrapEl || !modelEl) return;
  const provider = provEl.value || '';
  const models = (cachedCliapiProviders[provider] && cachedCliapiProviders[provider].models) || [];
  if (models.length === 0) {
    wrapEl.style.display = 'none';
    modelEl.innerHTML = '<option value="">— default —</option>';
    return;
  }
  wrapEl.style.display = 'block';
  const currentVal = modelEl.value;
  modelEl.innerHTML = models.map(m => {
    const sel = m.id === currentVal ? 'selected' : (!currentVal && models[0] ? (m === models[0] ? 'selected' : '') : '');
    return `<option value="${escapeHtml(m.id)}" ${sel}>${escapeHtml(m.alias || m.id)}</option>`;
  }).join('');
  if (!currentVal && models[0]) modelEl.value = models[0].id;
}

// A4: Build rubric thresholds UI
function buildThresholdsUI(taskType, existingThresholds) {
  const rubric = cachedRubric[taskType];
  if (!rubric || !rubric.dimensions) return '';

  const dims = rubric.dimensions;
  const thresh = existingThresholds || {};

  const rows = dims.map(dim => {
    const val = thresh[dim] !== undefined ? thresh[dim] : '';
    const isGate = rubric.hard_gates && rubric.hard_gates.includes(dim);
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <label style="width:200px;font-size:12px">${escapeHtml(dim)}${isGate ? ' <span style="color:#f85149">★</span>' : ''}</label>
        <input type="number" class="form-input" style="width:70px"
          id="thresh-${escapeHtml(dim)}"
          min="0" max="5" step="0.5"
          value="${escapeHtml(String(val))}"
          placeholder="min">
      </div>
    `;
  }).join('');

  const minScore = thresh.min_score !== undefined ? thresh.min_score : '';
  return `
    <div style="margin-top:8px">
      <div style="font-size:12px;color:#8b949e;margin-bottom:6px">
        ★ = hard gate dimension (score below threshold → GATED)
      </div>
      ${rows}
      <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
        <label style="width:200px;font-size:12px"><strong>Total min_score</strong></label>
        <input type="number" class="form-input" style="width:70px"
          id="thresh-min_score" min="0" max="100" step="1"
          value="${escapeHtml(String(minScore))}" placeholder="0-100">
      </div>
    </div>
  `;
}

// Read thresholds from UI inputs
function readThresholdsFromUI(taskType) {
  const rubric = cachedRubric[taskType];
  if (!rubric || !rubric.dimensions) return undefined;
  const result = {};
  let hasAny = false;
  for (const dim of rubric.dimensions) {
    const el = document.getElementById(`thresh-${dim}`);
    if (el && el.value !== '') {
      result[dim] = parseFloat(el.value);
      hasAny = true;
    }
  }
  const minEl = document.getElementById('thresh-min_score');
  if (minEl && minEl.value !== '') {
    result.min_score = parseFloat(minEl.value);
    hasAny = true;
  }
  return hasAny ? result : undefined;
}

// ================================================================
// A2: Modal helpers
// ================================================================

function closeModal() {
  const modal = document.getElementById('spec-modal');
  if (modal) modal.remove();
}

// A4: When task_type changes in modal, update rubric thresholds UI
async function onTaskTypeChange() {
  const sel = document.getElementById('modal-task-type');
  if (!sel) return;
  const taskType = sel.value;
  const container = document.getElementById('rubric-thresholds-container');
  if (!container) return;

  if (!taskType) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = '<div style="color:#8b949e;font-size:12px">Loading rubric...</div>';
  await loadRubric(taskType);
  container.innerHTML = buildThresholdsUI(taskType, null);
}

// A2-1: Open "New Task" modal (A6: apply saved default adapters when no template selected)
async function openNewSpecModal() {
  await loadAdapters();
  let defaultCoder = null;
  let defaultJudge = null;
  let defaultCoderModel = null;
  let defaultJudgeModel = null;
  try {
    const cfg = await api('/config');
    defaultCoder = cfg.default_coder || null;
    defaultJudge = cfg.default_judge || null;
    defaultCoderModel = cfg.default_coder_model || null;
    defaultJudgeModel = cfg.default_judge_model || null;
  } catch {}

  const TEMPLATES = {
    hello_world: {
      schema_version: 'v1',
      task_id: 'my_task',
      repo_path: 'dummy_repo',
      base_ref: 'main',
      goal: 'Describe what the task should achieve',
      acceptance: 'Describe acceptance criteria',
      test_cmd: 'true',
      max_attempts: 3,
      coder: 'mock',
      judge: 'mock',
      constraints: [],
      created_at: '',
      target_type: 'external_repo',
      allowed_paths: [],
      forbidden_globs: ['**/.env', '**/secrets*', '**/*.pem'],
      coder_timeout_seconds: 600,
      judge_timeout_seconds: 300,
      test_timeout_seconds: 300
    },
    requirements_doc: {
      schema_version: 'v1',
      task_id: 'req_doc_task',
      task_type: 'requirements_doc',
      repo_path: 'dummy_repo',
      base_ref: 'main',
      goal: 'Write a product requirements document',
      acceptance: 'All dimensions score above threshold',
      test_cmd: 'true',
      max_attempts: 3,
      coder: 'mock',
      judge: 'mock',
      scoring_mode: 'rubric_analytic',
      constraints: [],
      created_at: '',
      target_type: 'external_repo',
      allowed_paths: [],
      forbidden_globs: ['**/.env']
    },
    engineering_impl: {
      schema_version: 'v1',
      task_id: 'eng_impl_task',
      task_type: 'engineering_impl',
      repo_path: 'dummy_repo',
      base_ref: 'main',
      goal: 'Implement the feature described in the requirements',
      acceptance: 'Tests pass, code review score above threshold',
      test_cmd: './run_tests.sh',
      max_attempts: 5,
      coder: 'mock',
      judge: 'mock',
      scoring_mode: 'rubric_analytic',
      constraints: [],
      created_at: '',
      target_type: 'external_repo',
      allowed_paths: [],
      forbidden_globs: ['**/.env', '**/secrets*']
    }
  };

  const modalHtml = `
    <div id="spec-modal" class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:800px;max-height:90vh;overflow-y:auto">
        <h3 style="margin-top:0">New Task Spec</h3>

        <div style="margin-bottom:12px">
          <label class="form-label">Template</label>
          <select id="modal-template" class="form-select" onchange="applyTemplate()">
            <option value="">— blank —</option>
            <option value="hello_world">hello_world</option>
            <option value="requirements_doc">requirements_doc</option>
            <option value="engineering_impl">engineering_impl</option>
          </select>
        </div>

        <div style="margin-bottom:12px">
          <label class="form-label">Task ID</label>
          <input type="text" id="modal-task-id" class="form-input" placeholder="my_new_task"
            pattern="[A-Za-z0-9_-]+" title="Alphanumeric, underscore, hyphen only">
        </div>

        <div style="margin-bottom:12px">
          <label class="form-label">Task Type (A4)</label>
          <select id="modal-task-type" class="form-select" onchange="onTaskTypeChange()">
            <option value="">— none —</option>
            <option value="requirements_doc">requirements_doc</option>
            <option value="engineering_impl">engineering_impl</option>
            <option value="douyin_script">douyin_script</option>
            <option value="storyboard">storyboard</option>
            <option value="paid_mini_drama">paid_mini_drama</option>
          </select>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div>
            <label class="form-label">Coder Adapter (A5)</label>
            <div id="coder-adapter-selector">${buildAdapterSelector('coder', defaultCoder, defaultCoderModel)}</div>
          </div>
          <div>
            <label class="form-label">Judge Adapter (A5)</label>
            <div id="judge-adapter-selector">${buildAdapterSelector('judge', defaultJudge, defaultJudgeModel)}</div>
          </div>
        </div>
        <div style="margin-bottom:12px">
          <button type="button" class="btn write-action" style="font-size:12px" onclick="saveAdaptersAsDefault()">Save as Default (A6)</button>
        </div>

        <div class="form-section" style="margin-bottom:12px;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px">
          <strong class="form-label">Repo &amp; Git</strong>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">repo_path (absolute path to git repo)</label>
            <input type="text" id="modal-repo-path" class="form-input" placeholder="/path/to/repo" style="margin-bottom:6px">
          </div>
          <div style="margin-top:6px">
            <label class="form-label" style="font-size:11px">base_ref (branch or ref)</label>
            <input type="text" id="modal-base-ref" class="form-input" placeholder="main" style="margin-bottom:6px">
          </div>
          <div style="margin-top:6px">
            <label class="form-label" style="font-size:11px">allowed_paths (JSON array, optional)</label>
            <input type="text" id="modal-allowed-paths" class="form-input" placeholder='[] or ["src/"]' style="font-family:monospace;font-size:11px">
          </div>
          <div style="margin-top:6px">
            <label class="form-label" style="font-size:11px">forbidden_globs (JSON array, optional)</label>
            <input type="text" id="modal-forbidden-globs" class="form-input" placeholder='["**/.env"]' style="font-family:monospace;font-size:11px">
          </div>
        </div>

        <div id="rubric-thresholds-container" style="margin-bottom:12px"></div>

        <div style="margin-bottom:12px">
          <label class="form-label">Task JSON (E3: syntax validated on save)</label>
          <textarea id="modal-spec-json" class="code-editor" style="height:300px;font-family:monospace;font-size:12px"></textarea>
          <div id="modal-json-error" style="color:#f85149;font-size:12px;margin-top:4px"></div>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary write-action" onclick="saveNewSpec()">Save</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  updateReadOnlyBanner();

  // Store templates for use in applyTemplate
  window._specTemplates = TEMPLATES;
}

function applyTemplate() {
  const sel = document.getElementById('modal-template');
  const tpl = window._specTemplates && sel ? window._specTemplates[sel.value] : null;
  if (!tpl) {
    document.getElementById('modal-spec-json').value = '';
    return;
  }
  // Update task-id field from template
  const taskIdEl = document.getElementById('modal-task-id');
  if (taskIdEl && !taskIdEl.value) taskIdEl.value = tpl.task_id || '';
  // Update task-type selector
  const typeEl = document.getElementById('modal-task-type');
  if (typeEl && tpl.task_type) typeEl.value = tpl.task_type;
  // Update adapter and model selectors
  const coderEl = document.getElementById('adapter-coder');
  if (coderEl && tpl.coder) coderEl.value = tpl.coder;
  const judgeEl = document.getElementById('adapter-judge');
  if (judgeEl && tpl.judge) judgeEl.value = tpl.judge;
  refreshModelSelector('coder');
  refreshModelSelector('judge');
  const coderModelEl = document.getElementById('adapter-coder-model');
  if (coderModelEl && tpl.coder_model) coderModelEl.value = tpl.coder_model;
  const judgeModelEl = document.getElementById('adapter-judge-model');
  if (judgeModelEl && tpl.judge_model) judgeModelEl.value = tpl.judge_model;
  // Put JSON in editor
  document.getElementById('modal-spec-json').value = JSON.stringify(tpl, null, 2);
  // Repo & Git fields
  const rp = document.getElementById('modal-repo-path');
  if (rp) rp.value = tpl.repo_path || '';
  const br = document.getElementById('modal-base-ref');
  if (br) br.value = tpl.base_ref || 'main';
  const ap = document.getElementById('modal-allowed-paths');
  if (ap) ap.value = Array.isArray(tpl.allowed_paths) ? JSON.stringify(tpl.allowed_paths) : (tpl.allowed_paths || '[]');
  const fg = document.getElementById('modal-forbidden-globs');
  if (fg) fg.value = Array.isArray(tpl.forbidden_globs) ? JSON.stringify(tpl.forbidden_globs) : (tpl.forbidden_globs || '[]');
  // Load rubric
  if (tpl.task_type) onTaskTypeChange();
}

// A2-2: Save new spec
async function saveNewSpec() {
  const taskId = (document.getElementById('modal-task-id').value || '').trim();
  const jsonStr = (document.getElementById('modal-spec-json').value || '').trim();
  const errEl = document.getElementById('modal-json-error');
  errEl.textContent = '';

  if (!taskId || !/^[A-Za-z0-9_-]+$/.test(taskId)) {
    errEl.textContent = 'Invalid task_id: alphanumeric, underscore, hyphen only';
    return;
  }

  // E3: JSON syntax validation
  let spec;
  if (jsonStr) {
    try {
      spec = JSON.parse(jsonStr);
    } catch (e) {
      errEl.textContent = 'JSON syntax error: ' + e.message;
      return;
    }
  } else {
    // Build from form fields
    const taskType = document.getElementById('modal-task-type')?.value || undefined;
    const coder = document.getElementById('adapter-coder')?.value || 'mock';
    const judge = document.getElementById('adapter-judge')?.value || 'mock';
    const coderModel = document.getElementById('adapter-coder-model')?.value?.trim();
    const judgeModel = document.getElementById('adapter-judge-model')?.value?.trim();
    spec = {
      schema_version: 'v1',
      task_id: taskId,
      task_type: taskType || undefined,
      repo_path: document.getElementById('modal-repo-path')?.value?.trim() || undefined,
      base_ref: document.getElementById('modal-base-ref')?.value?.trim() || 'main',
      coder,
      judge,
      ...(coderModel ? { coder_model: coderModel } : {}),
      ...(judgeModel ? { judge_model: judgeModel } : {}),
      goal: '',
      acceptance: '',
      test_cmd: 'true',
      max_attempts: 3,
      constraints: [],
      allowed_paths: [],
      forbidden_globs: ['**/.env', '**/secrets*', '**/*.pem'],
      created_at: new Date().toISOString()
    };
    const apRaw0 = document.getElementById('modal-allowed-paths')?.value?.trim();
    if (apRaw0) { try { spec.allowed_paths = JSON.parse(apRaw0); } catch {} }
    const fgRaw0 = document.getElementById('modal-forbidden-globs')?.value?.trim();
    if (fgRaw0) { try { spec.forbidden_globs = JSON.parse(fgRaw0); } catch {} }
    // A4: read thresholds
    if (taskType) {
      const thresholds = readThresholdsFromUI(taskType);
      if (thresholds) spec.rubric_thresholds = thresholds;
    }
  }

  // Override task_id, adapter, and model from form controls if JSON was provided
  spec.task_id = taskId;
  const coderVal = document.getElementById('adapter-coder')?.value;
  if (coderVal) spec.coder = coderVal;
  const judgeVal = document.getElementById('adapter-judge')?.value;
  if (judgeVal) spec.judge = judgeVal;
  const coderModelVal = document.getElementById('adapter-coder-model')?.value;
  if (coderModelVal) spec.coder_model = coderModelVal; else if (spec.coder_model !== undefined) delete spec.coder_model;
  const judgeModelVal = document.getElementById('adapter-judge-model')?.value;
  if (judgeModelVal) spec.judge_model = judgeModelVal; else if (spec.judge_model !== undefined) delete spec.judge_model;
  const taskTypeVal = document.getElementById('modal-task-type')?.value;
  if (taskTypeVal) spec.task_type = taskTypeVal;
  // Repo & Git from form
  const rp = document.getElementById('modal-repo-path')?.value?.trim();
  if (rp !== undefined && rp !== '') spec.repo_path = rp;
  const br = document.getElementById('modal-base-ref')?.value?.trim();
  if (br !== undefined && br !== '') spec.base_ref = br;
  const apRaw = document.getElementById('modal-allowed-paths')?.value?.trim();
  if (apRaw) { try { spec.allowed_paths = JSON.parse(apRaw); } catch {} }
  const fgRaw = document.getElementById('modal-forbidden-globs')?.value?.trim();
  if (fgRaw) { try { spec.forbidden_globs = JSON.parse(fgRaw); } catch {} }
  // A4: merge thresholds
  if (spec.task_type) {
    const thresholds = readThresholdsFromUI(spec.task_type);
    if (thresholds) spec.rubric_thresholds = thresholds;
  }

  try {
    const res = await fetch('/api/task_specs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, spec })
    });
    const result = await res.json();
    if (!res.ok) {
      errEl.textContent = result.error || 'Validation failed';
      if (Array.isArray(result.errors) && result.errors.length) {
        errEl.innerHTML = escapeHtml(result.error || 'Validation failed') + '<br>' + result.errors.map(e => '• ' + escapeHtml(e)).join('<br>');
      }
      return;
    }
    closeModal();
    loadTaskSpecs();
  } catch (e) {
    errEl.textContent = 'Save failed: ' + (e.message || String(e));
  }
}

// A2-5: Open edit modal for existing spec
async function openEditSpecModal(taskId) {
  await loadAdapters();

  const data = await api(`/task_specs/${encodeURIComponent(taskId)}`);
  if (data.error) {
    alert('Failed to load spec: ' + data.error);
    return;
  }
  const spec = data.spec || {};

  // Pre-load rubric if task_type known
  if (spec.task_type) await loadRubric(spec.task_type);

  const thresholdsHtml = spec.task_type
    ? buildThresholdsUI(spec.task_type, spec.rubric_thresholds)
    : '';

  const modalHtml = `
    <div id="spec-modal" class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal-box" style="max-width:800px;max-height:90vh;overflow-y:auto">
        <h3 style="margin-top:0">Edit Task Spec: ${escapeHtml(taskId)}</h3>

        <div style="margin-bottom:12px">
          <label class="form-label">Task Type (A4)</label>
          <select id="modal-task-type" class="form-select" onchange="onTaskTypeChange()">
            <option value="">— none —</option>
            <option value="requirements_doc" ${spec.task_type === 'requirements_doc' ? 'selected' : ''}>requirements_doc</option>
            <option value="engineering_impl" ${(spec.task_type === 'engineering_impl' || spec.task_type === 'engineering_implementation') ? 'selected' : ''}>engineering_impl</option>
            <option value="douyin_script" ${spec.task_type === 'douyin_script' ? 'selected' : ''}>douyin_script</option>
            <option value="storyboard" ${spec.task_type === 'storyboard' ? 'selected' : ''}>storyboard</option>
            <option value="paid_mini_drama" ${spec.task_type === 'paid_mini_drama' ? 'selected' : ''}>paid_mini_drama</option>
          </select>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div>
            <label class="form-label">Coder Adapter (A5)</label>
            <div id="coder-adapter-selector">${buildAdapterSelector('coder', spec.coder, spec.coder_model)}</div>
          </div>
          <div>
            <label class="form-label">Judge Adapter (A5)</label>
            <div id="judge-adapter-selector">${buildAdapterSelector('judge', spec.judge, spec.judge_model)}</div>
          </div>
        </div>
        <div style="margin-bottom:12px">
          <button type="button" class="btn write-action" style="font-size:12px" onclick="saveAdaptersAsDefault()">Save as Default (A6)</button>
        </div>

        <div class="form-section" style="margin-bottom:12px;padding:10px;background:#0d1117;border:1px solid #30363d;border-radius:6px">
          <strong class="form-label">Repo &amp; Git</strong>
          <div style="margin-top:8px">
            <label class="form-label" style="font-size:11px">repo_path</label>
            <input type="text" id="modal-repo-path" class="form-input" value="${escapeHtml(spec.repo_path || '')}" placeholder="/path/to/repo" style="margin-bottom:6px">
          </div>
          <div style="margin-top:6px">
            <label class="form-label" style="font-size:11px">base_ref</label>
            <input type="text" id="modal-base-ref" class="form-input" value="${escapeHtml(spec.base_ref || 'main')}" placeholder="main" style="margin-bottom:6px">
          </div>
          <div style="margin-top:6px">
            <label class="form-label" style="font-size:11px">allowed_paths (JSON array)</label>
            <input type="text" id="modal-allowed-paths" class="form-input" value="${escapeHtml(Array.isArray(spec.allowed_paths) ? JSON.stringify(spec.allowed_paths) : (spec.allowed_paths || '[]'))}" placeholder='[]' style="font-family:monospace;font-size:11px">
          </div>
          <div style="margin-top:6px">
            <label class="form-label" style="font-size:11px">forbidden_globs (JSON array)</label>
            <input type="text" id="modal-forbidden-globs" class="form-input" value="${escapeHtml(Array.isArray(spec.forbidden_globs) ? JSON.stringify(spec.forbidden_globs) : (spec.forbidden_globs || '[]'))}" placeholder='["**/.env"]' style="font-family:monospace;font-size:11px">
          </div>
        </div>

        <div id="rubric-thresholds-container" style="margin-bottom:12px">
          ${thresholdsHtml}
        </div>

        <div style="margin-bottom:12px">
          <label class="form-label">Task JSON (E3: syntax validated on save)</label>
          <textarea id="modal-spec-json" class="code-editor" style="height:350px;font-family:monospace;font-size:12px">${escapeHtml(JSON.stringify(spec, null, 2))}</textarea>
          <div id="modal-json-error" style="color:#f85149;font-size:12px;margin-top:4px"></div>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
          ${spec.task_type ? `<button class="btn write-action" style="margin-right:auto;font-size:12px" onclick="openPromptForTaskType('${escapeHtml(spec.task_type)}')">Edit judge.prompt.${escapeHtml(spec.task_type)}.md</button>` : ''}
          <button class="btn" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary write-action" onclick="saveEditSpec('${escapeHtml(taskId)}')">Save</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  updateReadOnlyBanner();
}

// A2-5: Save edited spec
async function saveEditSpec(taskId) {
  const jsonStr = (document.getElementById('modal-spec-json').value || '').trim();
  const errEl = document.getElementById('modal-json-error');
  errEl.textContent = '';

  // E3: JSON syntax validation
  let spec;
  try {
    spec = JSON.parse(jsonStr);
  } catch (e) {
    errEl.textContent = 'JSON syntax error: ' + e.message;
    return;
  }

  // Override fields from form controls (adapter + model same as saveNewSpec)
  const coderVal = document.getElementById('adapter-coder')?.value;
  if (coderVal) spec.coder = coderVal;
  const judgeVal = document.getElementById('adapter-judge')?.value;
  if (judgeVal) spec.judge = judgeVal;
  const coderModelVal = document.getElementById('adapter-coder-model')?.value;
  if (coderModelVal) spec.coder_model = coderModelVal; else if (spec.coder_model !== undefined) delete spec.coder_model;
  const judgeModelVal = document.getElementById('adapter-judge-model')?.value;
  if (judgeModelVal) spec.judge_model = judgeModelVal; else if (spec.judge_model !== undefined) delete spec.judge_model;
  const taskTypeVal = document.getElementById('modal-task-type')?.value;
  if (taskTypeVal) spec.task_type = taskTypeVal;
  spec.task_id = taskId;

  // Repo & Git from form
  const rp = document.getElementById('modal-repo-path')?.value?.trim();
  if (rp !== undefined && rp !== '') spec.repo_path = rp;
  const br = document.getElementById('modal-base-ref')?.value?.trim();
  if (br !== undefined && br !== '') spec.base_ref = br;
  const apRaw = document.getElementById('modal-allowed-paths')?.value?.trim();
  if (apRaw) { try { spec.allowed_paths = JSON.parse(apRaw); } catch {} }
  const fgRaw = document.getElementById('modal-forbidden-globs')?.value?.trim();
  if (fgRaw) { try { spec.forbidden_globs = JSON.parse(fgRaw); } catch {} }

  // A4: merge thresholds from UI
  if (spec.task_type) {
    const thresholds = readThresholdsFromUI(spec.task_type);
    if (thresholds) spec.rubric_thresholds = thresholds;
  }

  try {
    const res = await fetch(`/api/task_specs/${encodeURIComponent(taskId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec })
    });
    const result = await res.json();
    if (!res.ok) {
      errEl.textContent = result.error || 'Validation failed';
      if (Array.isArray(result.errors) && result.errors.length) {
        errEl.innerHTML = escapeHtml(result.error || 'Validation failed') + '<br>' + result.errors.map(e => '• ' + escapeHtml(e)).join('<br>');
      }
      return;
    }
    closeModal();
    loadTaskSpecs();
  } catch (e) {
    errEl.textContent = 'Save failed: ' + (e.message || String(e));
  }
}

// A2-3: Copy a task spec
async function copySpec(taskId) {
  try {
    const result = await api(`/task_specs/${encodeURIComponent(taskId)}/copy`, { method: 'POST' });
    if (result.error) {
      alert('Copy failed: ' + result.error);
      return;
    }
    loadTaskSpecs();
    // Show confirmation
    const el = document.getElementById('task-specs-notice');
    if (el) {
      el.textContent = `Copied as: ${result.task_id}`;
      setTimeout(() => { el.textContent = ''; }, 3000);
    }
  } catch (e) {
    alert('Copy failed: ' + e.message);
  }
}

// A2-4: Delete (soft-delete) a task spec
async function deleteSpec(taskId) {
  if (!confirm(`Delete task spec "${taskId}"? (Soft-delete to trash/)`)) return;
  try {
    const result = await api(`/task_specs/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    if (result.error) {
      alert('Delete failed: ' + result.error);
      return;
    }
    loadTaskSpecs();
  } catch (e) {
    alert('Delete failed: ' + e.message);
  }
}

// ================================================================
// D1/D2: Prompt management
// ================================================================

// D1: Load and display prompts list in sidebar
async function loadPrompts() {
  const list = document.getElementById('prompts-list');
  if (!list) return;
  try {
    const res = await fetch('/api/prompts');
    const data = await res.json();
    if (data.error) { list.innerHTML = `<div style="padding:6px 12px;font-size:12px;color:#f85149">${escapeHtml(data.error)}</div>`; return; }
    if (!Array.isArray(data) || data.length === 0) {
      list.innerHTML = '<div style="padding:6px 12px;font-size:12px;color:#8b949e">No prompts found</div>';
      return;
    }
    list.innerHTML = data.map(p => `
      <div class="sidebar-item" onclick="viewPrompt(${JSON.stringify(p.name)})" style="cursor:pointer">
        <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
        <span style="font-size:10px;color:#8b949e;margin-left:4px">${escapeHtml(String(Math.round((p.size||0)/1024*10)/10))}KB</span>
      </div>`).join('');
  } catch (e) {
    list.innerHTML = `<div style="padding:6px 12px;font-size:12px;color:#f85149">Load error: ${escapeHtml(e.message)}</div>`;
  }
}

// D2: View and edit a prompt in a modal
async function viewPrompt(name) {
  // Remove existing modal if any
  const old = document.getElementById('prompt-modal');
  if (old) old.remove();
  try {
    const res = await fetch(`/api/prompts/${encodeURIComponent(name)}`);
    const data = await res.json();
    if (data.error) { alert('Failed to load prompt: ' + data.error); return; }
    const modalHtml = `
      <div id="prompt-modal" class="modal-overlay" onclick="if(event.target===this)closePromptModal()">
        <div class="modal-box" style="max-width:800px;max-height:90vh;overflow-y:auto">
          <h3 style="margin-top:0">Edit Prompt: ${escapeHtml(name)}</h3>
          <textarea id="prompt-editor" class="code-editor" style="height:480px;font-family:monospace;font-size:12px;width:100%;box-sizing:border-box">${escapeHtml(data.content || '')}</textarea>
          <div id="prompt-save-notice" style="font-size:12px;color:#3fb950;margin-top:4px;min-height:16px"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
            <button class="btn" onclick="closePromptModal()">Cancel</button>
            <button class="btn btn-primary write-action" onclick="savePrompt(${JSON.stringify(escapeHtml(name))})">Save</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    updateReadOnlyBanner();
  } catch (e) {
    alert('Failed to load prompt: ' + e.message);
  }
}

function closePromptModal() {
  const el = document.getElementById('prompt-modal');
  if (el) el.remove();
}

// D2: Save prompt content via PUT. K7-2: overwrite requires second confirmation.
async function savePrompt(name) {
  const content = document.getElementById('prompt-editor')?.value;
  if (content === undefined) return;
  if (!confirm('Overwrite this prompt file? This action will be recorded in the audit log.')) return;
  const notice = document.getElementById('prompt-save-notice');
  if (notice) notice.textContent = '';
  try {
    const res = await fetch(`/api/prompts/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    const result = await res.json();
    if (!res.ok) {
      if (notice) notice.style.color = '#f85149';
      if (notice) notice.textContent = 'Save failed: ' + (result.error || res.statusText);
      return;
    }
    if (notice) { notice.style.color = '#3fb950'; notice.textContent = 'Saved.'; }
    loadPrompts();
    setTimeout(() => { if (notice) notice.textContent = ''; }, 3000);
  } catch (e) {
    if (notice) { notice.style.color = '#f85149'; notice.textContent = 'Save error: ' + e.message; }
  }
}

// D2: Open prompt for the task_type of a spec (from edit modal)
async function openPromptForTaskType(taskType) {
  if (!taskType) { alert('No task_type selected'); return; }
  const name = `judge.prompt.${taskType}.md`;
  await viewPrompt(name);
}

// Sidebar: add Prompts section
function renderPromptsSection() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  if (document.getElementById('prompts-section')) return;

  const section = document.createElement('div');
  section.id = 'prompts-section';
  section.innerHTML = `
    <div style="padding:12px 12px 4px;display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px">Prompts</div>
      <button class="btn" style="padding:2px 8px;font-size:11px" onclick="loadPrompts()">↺</button>
    </div>
    <div id="prompts-list" style="max-height:180px;overflow-y:auto;border-bottom:1px solid #30363d"></div>
    <div style="padding:4px 12px 12px;font-size:11px;color:#8b949e;font-style:italic">
      From prompts/
    </div>
  `;
  sidebar.appendChild(section);
  loadPrompts();
}

// ================================================================
// Sidebar: add Task Specs section
// ================================================================
function renderSpecsSection() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  // Check if already rendered
  if (document.getElementById('specs-section')) return;

  const section = document.createElement('div');
  section.id = 'specs-section';
  section.innerHTML = `
    <div style="padding:12px 12px 4px;display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:0.5px">Task Specs</div>
      <button class="btn write-action" style="padding:2px 8px;font-size:11px" onclick="openNewSpecModal()">+ New</button>
    </div>
    <div id="task-specs-notice" style="padding:0 12px;font-size:11px;color:#58a6ff;min-height:14px"></div>
    <div id="task-specs-list" style="max-height:220px;overflow-y:auto;border-bottom:1px solid #30363d"></div>
    <div style="padding:4px 12px 12px;font-size:11px;color:#8b949e;font-style:italic">
      Specs from tasks/ and examples/
    </div>
  `;

  sidebar.appendChild(section);
  loadTaskSpecs();
}

// ================================================================
// Auto-refresh and initialization
// ================================================================

// Auto-refresh sidebar task list every 2 seconds
setInterval(loadTasks, 2000);

// B1-2/B1-3/B1-4: Auto-refresh ONLY current tab's log every 3 seconds (NOT full selectTask)
setInterval(refreshLiveLog, 3000);

// Refresh task meta periodically (separate from log refresh)
setInterval(refreshCurrentTaskMeta, 5000);

// Initial load (K7-1: load health for read_only first so banner and button state are correct)
loadHealth().then(() => { loadTasks(); renderSpecsSection(); renderPromptsSection(); updateReadOnlyBanner(); });
