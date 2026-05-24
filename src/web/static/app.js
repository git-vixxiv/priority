/* Priority Engine — browser UI */
'use strict';

const FIBS = [1, 2, 3, 5, 8, 13, 20, 40, 100];

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  tasks:            [],
  criticalPath:     [],
  cpDuration:       0,
  lastAnalyzed:     null,
  editingId:        null,   // null = new task
  scores: { Value_Score: 3, Time_Criticality: 3, RR_OE_Score: 3, Job_Size: 3 },
};

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Request failed');
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

const GET    = (p)    => api('GET',    p);
const POST   = (p, b) => api('POST',   p, b);
const PATCH  = (p, b) => api('PATCH',  p, b);
const DELETE = (p)    => api('DELETE', p);

// ── Load & render ─────────────────────────────────────────────────────────────
async function loadTasks() {
  try {
    state.tasks = await GET('/api/tasks');
    render();
  } catch (e) {
    toast('Could not load tasks: ' + e.message, 'error');
  }
}

function render() {
  renderHeader();
  renderAnalysisBanner();
  renderTaskList();
}

function renderHeader() {
  const active    = state.tasks.filter(t => !['Completed','Deferred'].includes(t.Status)).length;
  const completed = state.tasks.filter(t => t.Status === 'Completed').length;
  const el = $('header-stats');
  el.innerHTML = `
    <div class="stat"><span class="stat-value">${active}</span> active</div>
    <div class="stat"><span class="stat-value">${completed}</span> completed</div>
    ${state.lastAnalyzed ? `<div class="stat">analyzed <span class="stat-value">${state.lastAnalyzed}</span></div>` : ''}
  `;
}

function renderAnalysisBanner() {
  const el = $('analysis-banner');
  if (!state.criticalPath.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `
    <strong>⚡ Analysis complete</strong>
    Critical path: ${state.criticalPath.map(id => `<span class="cp-tag">${id}</span>`).join(' → ')}
    <span style="color:#4338ca">(${state.cpDuration} days)</span>
    <span style="color:#6366f1;font-size:12px">— Any delay on this path delays everything downstream</span>
  `;
}

function renderTaskList() {
  const list  = $('task-list');
  const empty = $('empty-state');

  if (!state.tasks.length) {
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.classList.remove('hidden');

  let rank = 0;
  list.innerHTML = state.tasks.map(task => {
    const isDone = ['Completed','Deferred'].includes(task.Status);
    if (!isDone) rank++;
    const rankDisplay = isDone
      ? `<span class="task-rank no-rank">—</span>`
      : `<span class="task-rank">${rank}</span>`;

    const adj  = parseFloat(task.Adjusted_WSJF || task.Base_WSJF || 0);
    const base = parseFloat(task.Base_WSJF || 0);
    const domino = adj > base + 0.5 ? ` <span style="font-size:11px;color:#7c3aed" title="Domino effect: adjusted up by ${(adj-base).toFixed(2)} because it unblocks downstream tasks">↑${(adj - base).toFixed(1)}</span>` : '';

    const flags = [
      task._on_critical_path  ? `<span class="flag flag-cp">★ critical path</span>` : '',
      task._decompose_flag     ? `<span class="flag flag-decomp">↓ decompose</span>` : '',
      task._bottleneck_flag    ? `<span class="flag flag-bn">⚠ bottleneck</span>` : '',
    ].filter(Boolean).join('');

    const noteSnippet = task.Notes
      ? `<div class="task-note">${esc(task.Notes.slice(0, 90))}${task.Notes.length > 90 ? '…' : ''}</div>`
      : '';

    const extBlocker = task.External_Blockers
      ? `<div class="task-note task-ext-blocker">👤 ${esc(task.External_Blockers.slice(0, 80))}${task.External_Blockers.length > 80 ? '…' : ''}</div>`
      : '';

    const stakesChip = task.Stakes_Description
      ? `<span class="stakes-chip" title="${esc(task.Stakes_Description)}">$ stakes</span>`
      : '';

    return `
      <div class="task-card ${isDone ? task.Status.toLowerCase() : ''}"
           data-id="${task.Task_ID}" onclick="openEdit('${task.Task_ID}')">
        ${rankDisplay}
        <div class="task-main">
          <div class="task-name-row">
            <span class="task-name${isDone ? ' strike' : ''}" title="${esc(task.Task_Name)}">${esc(task.Task_Name)}</span>
            ${task.Category ? `<span class="badge cat-badge">${esc(task.Category)}</span>` : ''}
            <span class="badge ${statusClass(task.Status)}">${task.Status}</span>
            ${flags}
          </div>
          <div class="task-meta">
            <span class="wsjf-chip ${wsjfClass(adj)}">${adj.toFixed(2)}${domino}</span>
            <span class="task-score-row">
              V=${task.Value_Score || '?'} T=${task.Time_Criticality || '?'} R=${task.RR_OE_Score || '?'} / J=${task.Job_Size || '?'}
            </span>
            ${task.Predecessor_IDs ? `<span style="font-size:11px;color:#9ca3af">blocks on: ${esc(task.Predecessor_IDs)}</span>` : ''}
            ${stakesChip}
          </div>
          ${noteSnippet}
          ${extBlocker}
        </div>
        <div class="task-actions" onclick="event.stopPropagation()">
          ${task.Status !== 'Completed'
            ? `<button class="icon-btn" title="Mark complete" onclick="markDone('${task.Task_ID}')">✓</button>`
            : `<button class="icon-btn" title="Reopen" onclick="reopen('${task.Task_ID}')">↩</button>`
          }
        </div>
      </div>`;
  }).join('');
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openNew() {
  state.editingId = null;
  state.scores    = { Value_Score: 3, Time_Criticality: 3, RR_OE_Score: 3, Job_Size: 3 };
  $('modal-title').textContent = 'New Task';
  $('btn-delete').style.display = 'none';
  $('status-field').style.display = 'none';

  // Clear form
  $('f-name').value              = '';
  $('f-category').value          = '';
  $('f-status').value            = 'Backlog';
  $('f-predecessors').value      = '';
  $('f-duration').value          = '';
  $('f-notes').value             = '';
  $('f-stakes').value            = '';
  $('f-external-blockers').value = '';
  $('f-dep-hints').value         = '';

  renderFibGroups();
  updateWsjfPreview();
  $('modal').classList.remove('hidden');
  setTimeout(() => $('f-name').focus(), 50);
}

function openEdit(taskId) {
  const task = state.tasks.find(t => t.Task_ID === taskId);
  if (!task) return;

  state.editingId = taskId;
  state.scores = {
    Value_Score:      parseInt(task.Value_Score)      || 3,
    Time_Criticality: parseInt(task.Time_Criticality) || 3,
    RR_OE_Score:      parseInt(task.RR_OE_Score)      || 3,
    Job_Size:         parseInt(task.Job_Size)          || 3,
  };

  $('modal-title').textContent  = 'Edit Task';
  $('btn-delete').style.display = 'inline-flex';
  $('status-field').style.display = '';

  $('f-name').value              = task.Task_Name       || '';
  $('f-category').value          = task.Category        || '';
  $('f-status').value            = task.Status          || 'Backlog';
  $('f-predecessors').value      = task.Predecessor_IDs || '';
  $('f-duration').value          = task.Duration_Days   || '';
  $('f-notes').value             = task.Notes           || '';
  $('f-stakes').value            = task.Stakes_Description  || '';
  $('f-external-blockers').value = task.External_Blockers   || '';
  $('f-dep-hints').value         = task.Dependency_Hints    || '';

  renderFibGroups();
  updateWsjfPreview();
  $('modal').classList.remove('hidden');
}

function closeModal() {
  $('modal').classList.add('hidden');
  state.editingId = null;
}

function renderFibGroups() {
  ['Value_Score','Time_Criticality','RR_OE_Score','Job_Size'].forEach(field => {
    const el = $('fib-' + field);
    if (!el) return;
    el.innerHTML = FIBS.map(n => `
      <button type="button" class="fib-btn${state.scores[field] === n ? ' active' : ''}"
              onclick="selectFib('${field}', ${n})">${n}</button>
    `).join('');
  });
}

function selectFib(field, value) {
  state.scores[field] = value;
  renderFibGroups();
  updateWsjfPreview();
}

function updateWsjfPreview() {
  const { Value_Score: v, Time_Criticality: t, RR_OE_Score: r, Job_Size: j } = state.scores;
  const base = j > 0 ? ((v + t + r) / j).toFixed(2) : '—';
  $('wsjf-preview').textContent = base;
}

async function saveTask() {
  const name = $('f-name').value.trim();
  if (!name) { $('f-name').focus(); toast('Task name is required', 'error'); return; }

  const payload = {
    Task_Name:          name,
    Category:           $('f-category').value,
    Status:             $('f-status').value,
    Value_Score:        state.scores.Value_Score,
    Time_Criticality:   state.scores.Time_Criticality,
    RR_OE_Score:        state.scores.RR_OE_Score,
    Job_Size:           state.scores.Job_Size,
    Predecessor_IDs:    $('f-predecessors').value.trim(),
    Duration_Days:      parseInt($('f-duration').value) || null,
    Notes:              $('f-notes').value.trim(),
    Stakes_Description: $('f-stakes').value.trim(),
    External_Blockers:  $('f-external-blockers').value.trim(),
    Dependency_Hints:   $('f-dep-hints').value.trim(),
  };

  setSaving(true);
  try {
    if (state.editingId) {
      await PATCH(`/api/tasks/${state.editingId}`, payload);
      toast('Task updated');
    } else {
      await POST('/api/tasks', payload);
      toast('Task added');
    }
    closeModal();
    await loadTasks();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setSaving(false);
  }
}

async function deleteTask() {
  if (!state.editingId) return;
  if (!confirm('Delete this task? This cannot be undone.')) return;
  try {
    await DELETE(`/api/tasks/${state.editingId}`);
    closeModal();
    await loadTasks();
    toast('Task deleted');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Quick actions ─────────────────────────────────────────────────────────────
async function markDone(taskId) {
  try {
    await PATCH(`/api/tasks/${taskId}`, { Status: 'Completed' });
    await loadTasks();
    toast('Marked complete ✓');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function reopen(taskId) {
  try {
    await PATCH(`/api/tasks/${taskId}`, { Status: 'Backlog' });
    await loadTasks();
    toast('Task reopened');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Analyze ───────────────────────────────────────────────────────────────────
async function runAnalysis() {
  const btn = $('btn-analyze');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing…';
  try {
    const res = await POST('/api/analyze');
    state.tasks       = res.tasks || [];
    state.criticalPath = res.critical_path || [];
    state.cpDuration  = res.critical_path_duration || 0;
    state.lastAnalyzed = new Date().toLocaleTimeString();
    render();
    toast(`Analysis complete — ${state.tasks.filter(t=>!['Completed','Deferred'].includes(t.Status)).length} tasks ranked`, 'info');
  } catch (e) {
    toast('Analysis failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '⚡ Analyze';
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
async function showReport() {
  try {
    const text = await GET('/api/report');
    $('report-content').textContent = text;
    $('report-modal').classList.remove('hidden');
  } catch (e) {
    toast('Could not generate report: ' + e.message, 'error');
  }
}

function copyReport() {
  const text = $('report-content').textContent;
  navigator.clipboard.writeText(text).then(
    () => toast('Copied to clipboard'),
    () => toast('Copy failed — try selecting and copying manually', 'error'),
  );
}

// ── Seed ──────────────────────────────────────────────────────────────────────
async function seedData() {
  try {
    const res = await POST('/api/seed');
    if (res.message === 'already has data') {
      toast('Demo data already loaded. Clear first if needed.', 'info');
    } else {
      toast(`Loaded ${res.seeded} demo tasks — click ⚡ Analyze to rank them`, 'info');
      await loadTasks();
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function $  (id) { return document.getElementById(id); }
function esc(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function statusClass(s) {
  return {
    'Backlog':     'status-backlog',
    'In Progress': 'status-in-progress',
    'Blocked':     'status-blocked',
    'Completed':   'status-completed',
    'Deferred':    'status-deferred',
  }[s] || 'status-backlog';
}

function wsjfClass(v) {
  if (v >= 10) return 'wsjf-high';
  if (v >= 5)  return 'wsjf-medium';
  return 'wsjf-low';
}

function setSaving(on) {
  const btn = $('btn-save');
  btn.disabled = on;
  btn.textContent = on ? 'Saving…' : 'Save Task';
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Event wiring ──────────────────────────────────────────────────────────────
function init() {
  // Header buttons
  $('btn-new').onclick     = openNew;
  $('btn-analyze').onclick = runAnalysis;
  $('btn-report').onclick  = showReport;

  // Empty state
  $('btn-new-empty').onclick = openNew;
  $('btn-seed').onclick      = seedData;

  // Modal
  $('modal-close').onclick = closeModal;
  $('btn-cancel').onclick  = closeModal;
  $('btn-save').onclick    = saveTask;
  $('btn-delete').onclick  = deleteTask;
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });

  // Report modal
  $('report-close').onclick    = () => $('report-modal').classList.add('hidden');
  $('btn-copy-report').onclick = copyReport;
  $('report-modal').addEventListener('click', e => {
    if (e.target === $('report-modal')) $('report-modal').classList.add('hidden');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      $('modal').classList.add('hidden');
      $('report-modal').classList.add('hidden');
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (!$('modal').classList.contains('hidden')) saveTask();
    }
  });

  loadTasks();
}

document.addEventListener('DOMContentLoaded', init);
