const config = require('./config');

const BASE_URL = config.RDLOOP_GUI_BASE_URL;

async function apiFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

module.exports = {
  getHealth() {
    return apiFetch('/api/health');
  },

  getTasks(limit = 6, cursor = null) {
    let qs = `?limit=${limit}`;
    if (cursor) qs += `&cursor=${encodeURIComponent(cursor)}`;
    return apiFetch(`/api/tasks${qs}`);
  },

  getTaskStatus(taskId) {
    return apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/status`);
  },

  postRuntimeOverrides(taskId, overrides, requestId) {
    return apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/runtime_overrides`, {
      method: 'POST',
      body: JSON.stringify({ overrides, request_id: requestId })
    });
  },

  postUserInput(taskId, text, requestId) {
    return apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/user_input`, {
      method: 'POST',
      body: JSON.stringify({ text, request_id: requestId })
    });
  }
};
