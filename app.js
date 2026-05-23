'use strict';

// ────────────────────────────────────────────────────────────────────────────────
// ALGORITHMS  (WSJF · DAG · CPM — all run in the browser)
// ────────────────────────────────────────────────────────────────────────────────

const FIBS = [1, 2, 3, 5, 8, 13, 20, 40, 100];

function buildGraph(tasks) {
  const g = {};
  tasks.forEach(t => { if (t.Task_ID) g[t.Task_ID] = []; });
  tasks.forEach(task => {
    (task.Predecessor_IDs || '').split(',')
      .map(s => s.trim()).filter(Boolean)
      .forEach(pred => {
        if (!g[pred]) g[pred] = [];
        if (!g[pred].includes(task.Task_ID)) g[pred].push(task.Task_ID);
      });
  });
  return g;
}

function topoSort(graph) {
  const inDeg = {};
  Object.keys(graph).forEach(n => { inDeg[n] = inDeg[n] || 0; });
  Object.values(graph).forEach(succs =>
    succs.forEach(s => { inDeg[s] = (inDeg[s] || 0) + 1; }));
  const queue = Object.keys(inDeg).filter(n => !inDeg[n]);
  const result = [];
  while (queue.length) {
    const n = queue.shift();
    result.push(n);
    (graph[n] || []).forEach(s => { if (--inDeg[s] === 0) queue.push(s); });
  }
  return result;
}

function calcAdjWSJF(taskId, base, graph, idx) {
  const visited = new Set();
  const queue = [...(graph[taskId] || [])];
  let total = 0;
  while (queue.length) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    total += parseFloat(idx[cur]?.Base_WSJF || 0);
    (graph[cur] || []).forEach(s => { if (!visited.has(s)) queue.push(s); });
  }
  return Math.round((base + 0.5 * total) * 100) / 100;
}

function critPath(graph, idx) {
  const order = topoSort(graph);
  if (!order.length) return { path: [], dur: 0 };

  const rev = {};
  Object.keys(graph).forEach(n =>
    (graph[n] || []).forEach(s => { (rev[s] = rev[s] || []).push(n); }));

  const ef = {};
  order.forEach(n => {
    const dur  = Math.max(1, parseInt(idx[n]?.Duration_Days) || 1);
    const preds = rev[n] || [];
    const es   = preds.length ? Math.max(...preds.map(p => ef[p] || 0)) : 0;
    ef[n] = es + dur;
  });

  const nodes = Object.keys(ef);
  if (!nodes.length) return { path: [], dur: 0 };

  let end = nodes.reduce((a, b) => ef[a] > ef[b] ? a : b);
  const totalDur = ef[end];
  const path = [];
  while (end && !path.includes(end)) {
    path.unshift(end);
    const preds = rev[end] || [];
    end = preds.length ? preds.reduce((a, b) => (ef[a] || 0) > (ef[b] || 0) ? a : b) : null;
  }
  return { path, dur: totalDur };
}

function runAnalysis(allTasks) {
  const tasks = allTasks.map(t => ({ ...t }));
  const graph = buildGraph(tasks);
  const idx   = Object.fromEntries(tasks.map(t => [t.Task_ID, t]));

  tasks.forEach(t => {
    const v = +t.Value_Score, tc = +t.Time_Criticality, r = +t.RR_OE_Score, j = +t.Job_Size;
    if (v && tc && r && j) t.Base_WSJF = Math.round((v + tc + r) / j * 100) / 100;
  });

  tasks.forEach(t => {
    t.Adjusted_WSJF = calcAdjWSJF(t.Task_ID, parseFloat(t.Base_WSJF) || 0, graph, idx);
  });

  tasks.forEach(t => {
    t._on_critical_path = false;
    t._decompose_flag   = +t.Job_Size >= 13;
    t._bottleneck_flag  = (graph[t.Task_ID] || []).length >= 3 && +t.RR_OE_Score < 5;
  });

  const { path: cp, dur: cpDur } = critPath(graph, idx);
  cp.forEach(id => { if (idx[id]) idx[id]._on_critical_path = true; });

  const active = tasks
    .filter(t => !['Completed', 'Deferred'].includes(t.Status))
    .sort((a, b) => (b.Adjusted_WSJF || 0) - (a.Adjusted_WSJF || 0));
  active.forEach((t, i) => { t.Priority_Rank = i + 1; });

  const done = tasks.filter(t => ['Completed', 'Deferred'].includes(t.Status));
  return { ranked: [...active, ...done], cp, cpDur };
}

// ────────────────────────────────────────────────────────────────────────────────
// STORAGE  (localStorage)
// ────────────────────────────────────────────────────────────────────────────────

const DB = {
  KEY: 'priority_v1',

  load() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); }
    catch { return []; }
  },

  save(tasks) {
    localStorage.setItem(this.KEY, JSON.stringify(tasks));
  },

  nextId(tasks) {
    const nums = tasks.map(t => parseInt((t.Task_ID || '').replace('T-', '')) || 0);
    return 'T-' + String(Math.max(0, ...nums) + 1).padStart(3, '0');
  },

  add(task) {
    const tasks = this.load();
    task.Task_ID      = this.nextId(tasks);
    task.Last_Updated = today();
    tasks.push(task);
    this.save(tasks);
    return task;
  },

  update(id, patch) {
    const tasks = this.load();
    const i = tasks.findIndex(t => t.Task_ID === id);
    if (i === -1) return null;
    tasks[i] = { ...tasks[i], ...patch, Last_Updated: today() };
    this.save(tasks);
    return tasks[i];
  },

  remove(id) {
    this.save(this.load().filter(t => t.Task_ID !== id));
  },

  saveAll(tasks) {
    this.save(tasks);
  },
};

// ────────────────────────────────────────────────────────────────────────────────
// STATE
// ────────────────────────────────────────────────────────────────────────────────

const state = {
  tasks:       [],
  cp:          [],
  cpDur:       0,
  lastAnalyzed: null,
  editingId:   null,
  scores:      { Value_Score: 3, Time_Criticality: 3, RR_OE_Score: 3, Job_Size: 3 },
};

// ────────────────────────────────────────────────────────────────────────────────
// LOAD & RENDER
// ────────────────────────────────────────────────────────────────────────────────

function loadAndRender() {
  state.tasks = DB.load();
  render();
}

function render() {
  renderHeader();
  renderBanner();
  renderTaskList();
}

function renderHeader() {
  const active    = state.tasks.filter(t => !['Completed', 'Deferred'].includes(t.Status)).length;
  const completed = state.tasks.filter(t => t.Status === 'Completed').length;
  $('header-stats').innerHTML = `
    <div class="stat"><span class="stat-value">${active}</span> active</div>
    <div class="stat"><span class="stat-value">${completed}</span> completed</div>
    ${state.lastAnalyzed
      ? `<div class="stat">analyzed <span class="stat-value">${state.lastAnalyzed}</span></div>`
      : ''}
  `;
}

function renderBanner() {
  const el = $('analysis-banner');
  if (!state.cp.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `
    <strong>⚡ Analysis complete</strong>
    Critical path: ${state.cp.map(id => `<span class="cp-tag">${esc(id)}</span>`).join(' → ')}
    <span style="color:#4338ca">(${state.cpDur} days total)</span>
    <span style="color:#6366f1;font-size:12px"> — any delay here delays everything downstream</span>
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
    const isDone = ['Completed', 'Deferred'].includes(task.Status);
    if (!isDone) rank++;

    const adj  = parseFloat(task.Adjusted_WSJF || task.Base_WSJF || 0);
    const base = parseFloat(task.Base_WSJF || 0);
    const lift = adj - base;
    const dominoTag = lift > 0.5
      ? `<span class="domino-tag" title="Adjusted up by ${lift.toFixed(2)} because it unblocks downstream tasks">↑${lift.toFixed(1)} domino</span>`
      : '';

    const flags = [
      task._on_critical_path ? `<span class="flag flag-cp">★ critical path</span>` : '',
      task._decompose_flag   ? `<span class="flag flag-decomp">↓ decompose</span>`  : '',
      task._bottleneck_flag  ? `<span class="flag flag-bn">⚠ bottleneck</span>`      : '',
    ].filter(Boolean).join('');

    const note = task.Notes
      ? `<div class="task-note">${esc(task.Notes.slice(0, 100))}${task.Notes.length > 100 ? '…' : ''}</div>`
      : '';

    return `
      <div class="task-card ${isDone ? task.Status.toLowerCase().replace(' ', '-') : ''}"
           data-id="${esc(task.Task_ID)}" onclick="openEdit('${esc(task.Task_ID)}}')">

        ${isDone
          ? `<span class="task-rank no-rank">—</span>`
          : `<span class="task-rank">${rank}</span>`}

        <div class="task-main">
          <div class="task-name-row">
            <span class="task-name${isDone ? ' strike' : ''}" title="${esc(task.Task_Name)}">${esc(task.Task_Name)}</span>
            ${task.Category ? `<span class="badge cat-badge">${esc(task.Category)}</span>` : ''}
            <span class="badge ${statusClass(task.Status)}">${esc(task.Status)}</span>
            ${flags}
          </div>
          <div class="task-meta">
            <span class="wsjf-chip ${wsjfClass(adj)}">${adj.toFixed(2)}</span>
            ${dominoTag}
            <span class="task-score-row">V=${task.Value_Score||'?'} T=${task.Time_Criticality||'?'} R=${task.RR_OE_Score||'?'} / J=${task.Job_Size||'?'}</span>
            ${task.Predecessor_IDs ? `<span style="font-size:11px;color:#9ca3af">after: ${esc(task.Predecessor_IDs)}</span>` : ''}
          </div>
          ${note}
        </div>

        <div class="task-actions" onclick="event.stopPropagation()">
          ${task.Status !== 'Completed'
            ? `<button class="icon-btn" title="Mark complete" onclick="markDone('${esc(task.Task_ID)}')">✓</button>`
            : `<button class="icon-btn" title="Reopen"        onclick="reopen('${esc(task.Task_ID)}')">↩</button>`}
        </div>
      </div>`;
  }).join('');
}

// ────────────────────────────────────────────────────────────────────────────────
// MODAL
// ────────────────────────────────────────────────────────────────────────────────

function openNew() {
  state.editingId = null;
  state.scores    = { Value_Score: 3, Time_Criticality: 3, RR_OE_Score: 3, Job_Size: 3 };

  $('modal-title').textContent  = 'New Task';
  $('btn-delete').style.display = 'none';
  $('status-field').style.display = 'none';

  $('f-name').value         = '';
  $('f-category').value     = '';
  $('f-status').value       = 'Backlog';
  $('f-predecessors').value = '';
  $('f-duration').value     = '';
  $('f-notes').value        = '';

  renderFibGroups();
  updateWsjfPreview();
  $('modal').classList.remove('hidden');
  setTimeout(() => $('f-name').focus(), 60);
}

function openEdit(id) {
  const task = state.tasks.find(t => t.Task_ID === id);
  if (!task) return;

  state.editingId = id;
  state.scores = {
    Value_Score:      parseInt(task.Value_Score)      || 3,
    Time_Criticality: parseInt(task.Time_Criticality) || 3,
    RR_OE_Score:      parseInt(task.RR_OE_Score)      || 3,
    Job_Size:         parseInt(task.Job_Size)          || 3,
  };

  $('modal-title').textContent    = 'Edit Task';
  $('btn-delete').style.display   = 'inline-flex';
  $('status-field').style.display = '';

  $('f-name').value         = task.Task_Name        || '';
  $('f-category').value     = task.Category         || '';
  $('f-status').value       = task.Status           || 'Backlog';
  $('f-predecessors').value = task.Predecessor_IDs  || '';
  $('f-duration').value     = task.Duration_Days    || '';
  $('f-notes').value        = task.Notes            || '';

  renderFibGroups();
  updateWsjfPreview();
  $('modal').classList.remove('hidden');
}

function closeModal() {
  $('modal').classList.add('hidden');
  state.editingId = null;
}

function renderFibGroups() {
  ['Value_Score', 'Time_Criticality', 'RR_OE_Score', 'Job_Size'].forEach(field => {
    const el = $('fib-' + field);
    if (!el) return;
    el.innerHTML = FIBS.map(n => `
      <button type="button"
              class="fib-btn${state.scores[field] === n ? ' active' : ''}"
              onclick="selectFib('${field}',${n})">${n}</button>
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
  $('wsjf-preview').textContent = j > 0 ? ((v + t + r) / j).toFixed(2) : '—';
}

function saveTask() {
  const name = $('f-name').value.trim();
  if (!name) { $('f-name').focus(); toast('Task name is required', 'error'); return; }

  const payload = {
    Task_Name:        name,
    Category:         $('f-category').value,
    Status:           $('f-status').value || 'Backlog',
    Value_Score:      state.scores.Value_Score,
    Time_Criticality: state.scores.Time_Criticality,
    RR_OE_Score:      state.scores.RR_OE_Score,
    Job_Size:         state.scores.Job_Size,
    Predecessor_IDs:  $('f-predecessors').value.trim(),
    Duration_Days:    parseInt($('f-duration').value) || '',
    Notes:            $('f-notes').value.trim(),
  };

  const v = payload.Value_Score, tc = payload.Time_Criticality,
        r = payload.RR_OE_Score,  j  = payload.Job_Size;
  payload.Base_WSJF     = Math.round((v + tc + r) / j * 100) / 100;
  payload.Adjusted_WSJF = payload.Base_WSJF;

  if (state.editingId) {
    DB.update(state.editingId, payload);
    toast('Task updated');
  } else {
    DB.add(payload);
    toast('Task added — click ⚡ Analyze to re-rank');
  }

  closeModal();
  loadAndRender();
}

function deleteTask() {
  if (!state.editingId) return;
  if (!confirm('Delete this task? This cannot be undone.')) return;
  DB.remove(state.editingId);
  closeModal();
  loadAndRender();
  toast('Task deleted');
}

// ────────────────────────────────────────────────────────────────────────────────
// QUICK ACTIONS
// ────────────────────────────────────────────────────────────────────────────────

function markDone(id) {
  DB.update(id, { Status: 'Completed' });
  loadAndRender();
  toast('Marked complete ✓');
}

function reopen(id) {
  DB.update(id, { Status: 'Backlog' });
  loadAndRender();
  toast('Task reopened');
}

// ────────────────────────────────────────────────────────────────────────────────
// ANALYZE
// ────────────────────────────────────────────────────────────────────────────────

function analyze() {
  const tasks = DB.load();
  if (!tasks.length) { toast('No tasks to analyze', 'error'); return; }

  const btn = $('btn-analyze');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing…';

  setTimeout(() => {
    try {
      const { ranked, cp, cpDur } = runAnalysis(tasks);
      DB.saveAll(ranked);

      state.tasks       = ranked;
      state.cp          = cp;
      state.cpDur       = cpDur;
      state.lastAnalyzed = new Date().toLocaleTimeString();

      render();

      const activeCount = ranked.filter(t => !['Completed','Deferred'].includes(t.Status)).length;
      toast(`Analysis complete — ${activeCount} tasks ranked`, 'info');
    } catch (e) {
      toast('Analysis failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '⚡ Analyze';
    }
  }, 30);
}

// ────────────────────────────────────────────────────────────────────────────────
// REPORT
// ────────────────────────────────────────────────────────────────────────────────

function showReport() {
  const tasks = DB.load();
  if (!tasks.length) { toast('No tasks yet', 'error'); return; }

  let ranked = tasks, cp = state.cp, cpDur = state.cpDur;
  if (!state.lastAnalyzed) {
    const res = runAnalysis(tasks);
    ranked = res.ranked; cp = res.cp; cpDur = res.cpDur;
  }

  const active    = ranked.filter(t => !['Completed','Deferred'].includes(t.Status));
  const completed = tasks.filter(t => t.Status === 'Completed');
  const d         = today();

  const lines = [
    `# Priority Report — ${d}`, '',
    `Active: ${active.length} | Completed: ${completed.length}`,
    cp.length ? `Critical path: ${cp.join(' → ')} (${cpDur} days)` : '',
    '', '| # | ID | Adj.WSJF | Status | Task |', '|---|---|---|---|---|',
  ];

  active.forEach((t, i) => {
    const cp_mark = t._on_critical_path ? ' ★' : '';
    lines.push(`| ${i+1} | ${t.Task_ID} | ${t.Adjusted_WSJF ?? '?'} | ${t.Status} | ${t.Task_Name}${cp_mark} |`);
  });

  if (completed.length) {
    lines.push('', '## Completed', '');
    completed.forEach(t => lines.push(`- ~~${t.Task_Name}~~ \`${t.Task_ID}\``));
  }

  lines.push('', '---', `*Generated ${d} · Priority Engine*`);

  $('report-content').textContent = lines.filter(l => l !== '').join('\n') || '(empty)';
  $('report-modal').classList.remove('hidden');
}

function copyReport() {
  navigator.clipboard.writeText($('report-content').textContent).then(
    ()  => toast('Copied to clipboard'),
    ()  => toast('Copy failed — try selecting and copying manually', 'error'),
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// IMPORT / EXPORT
// ────────────────────────────────────────────────────────────────────────────────

function exportData() {
  const tasks = DB.load();
  if (!tasks.length) { toast('Nothing to export', 'error'); return; }
  const blob = new Blob([JSON.stringify(tasks, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url, download: `priority-${today()}.json`,
  });
  a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${tasks.length} tasks`);
}

function importData() {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json' });
  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const tasks = JSON.parse(await file.text());
      if (!Array.isArray(tasks)) throw new Error('File must contain a JSON array');
      if (!confirm(`Import ${tasks.length} tasks? This will replace your current data.`)) return;
      DB.save(tasks);
      loadAndRender();
      toast(`Imported ${tasks.length} tasks`);
    } catch (err) {
      toast('Import failed: ' + err.message, 'error');
    }
  };
  input.click();
}

// ────────────────────────────────────────────────────────────────────────────────
// SEED DATA
// ────────────────────────────────────────────────────────────────────────────────

function seedData() {
  if (DB.load().length && !confirm('Load demo data? This will replace your current tasks.')) return;

  const demos = [
    { Task_Name:'Set up OAuth credentials for data pipeline', Category:'Professional',
      Value_Score:2, Time_Criticality:5, RR_OE_Score:13, Job_Size:1,
      Duration_Days:1, Status:'Backlog', Predecessor_IDs:'',
      Notes:'Blocks all downstream data work. Unlocks T-002, T-003, T-008.' },
    { Task_Name:'Build analytics dashboard for client reporting', Category:'Professional',
      Value_Score:13, Time_Criticality:8, RR_OE_Score:5, Job_Size:8,
      Duration_Days:5, Status:'Backlog', Predecessor_IDs:'T-001',
      Notes:'Client demo scheduled. Requires OAuth (T-001).' },
    { Task_Name:'Automate monthly financial reports', Category:'Professional',
      Value_Score:8, Time_Criticality:3, RR_OE_Score:5, Job_Size:5,
      Duration_Days:3, Status:'Backlog', Predecessor_IDs:'T-001',
      Notes:'Saves ~8h/month once built. Also needs OAuth.' },
    { Task_Name:'Draft Q3 strategy memo for executive team', Category:'Professional',
      Value_Score:8, Time_Criticality:13, RR_OE_Score:8, Job_Size:3,
      Duration_Days:2, Status:'Backlog', Predecessor_IDs:'',
      Notes:'Board meeting in 10 days. Hard deadline.' },
    { Task_Name:'Migrate legacy customer database schema', Category:'Professional',
      Value_Score:5, Time_Criticality:2, RR_OE_Score:8, Job_Size:13,
      Duration_Days:8, Status:'Backlog', Predecessor_IDs:'',
      Notes:'Large task — Job_Size 13 triggers decomposition flag.' },
    { Task_Name:'Schedule annual physical and bloodwork', Category:'Health',
      Value_Score:8, Time_Criticality:5, RR_OE_Score:3, Job_Size:1,
      Duration_Days:1, Status:'Backlog', Predecessor_IDs:'',
      Notes:'10-minute task that keeps getting deferred.' },
    { Task_Name:'Renew business insurance policy', Category:'Administrative',
      Value_Score:5, Time_Criticality:20, RR_OE_Score:2, Job_Size:2,
      Duration_Days:1, Status:'Backlog', Predecessor_IDs:'',
      Notes:'Policy lapses in 3 weeks. High time criticality.' },
    { Task_Name:'Complete OAuth integration for client portal', Category:'Professional',
      Value_Score:8, Time_Criticality:5, RR_OE_Score:5, Job_Size:3,
      Duration_Days:2, Status:'Blocked', Predecessor_IDs:'T-001',
      Notes:'Blocked waiting for credentials (T-001).' },
  ];

  DB.save([]);
  demos.forEach((d, i) => {
    const id = `T-${String(i + 1).padStart(3, '0')}`;
    const { Value_Score: v, Time_Criticality: tc, RR_OE_Score: r, Job_Size: j } = d;
    DB.save([...DB.load(), {
      ...d,
      Task_ID:       id,
      Base_WSJF:     Math.round((v + tc + r) / j * 100) / 100,
      Adjusted_WSJF: Math.round((v + tc + r) / j * 100) / 100,
      Last_Updated:  today(),
    }]);
  });

  loadAndRender();
  toast('Loaded 8 demo tasks — click ⚡ Analyze to rank them', 'info');
}

// ────────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ────────────────────────────────────────────────────────────────────────────────

function $  (id) { return document.getElementById(id); }
function esc(s)  { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function today() { return new Date().toISOString().slice(0, 10); }

function statusClass(s) {
  return { 'Backlog':'status-backlog', 'In Progress':'status-in-progress',
    'Blocked':'status-blocked', 'Completed':'status-completed', 'Deferred':'status-deferred' }[s] || 'status-backlog';
}

function wsjfClass(v) {
  return v >= 10 ? 'wsjf-high' : v >= 5 ? 'wsjf-medium' : 'wsjf-low';
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className  = `toast toast-${type}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

// ────────────────────────────────────────────────────────────────────────────────
// INIT & EVENT WIRING
// ────────────────────────────────────────────────────────────────────────────────

function init() {
  $('btn-new').onclick     = openNew;
  $('btn-analyze').onclick = analyze;
  $('btn-report').onclick  = showReport;
  $('btn-export').onclick  = exportData;
  $('btn-import').onclick  = importData;

  $('btn-new-empty').onclick = openNew;
  $('btn-seed').onclick      = seedData;

  $('modal-close').onclick = closeModal;
  $('btn-cancel').onclick  = closeModal;
  $('btn-save').onclick    = saveTask;
  $('btn-delete').onclick  = deleteTask;
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });

  $('report-close').onclick    = () => $('report-modal').classList.add('hidden');
  $('btn-copy-report').onclick = copyReport;
  $('report-modal').addEventListener('click', e => {
    if (e.target === $('report-modal')) $('report-modal').classList.add('hidden');
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      $('modal').classList.add('hidden');
      $('report-modal').classList.add('hidden');
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (!$('modal').classList.contains('hidden')) saveTask();
    }
  });

  const style = document.createElement('style');
  style.textContent = '.domino-tag{font-size:11px;color:#7c3aed;font-weight:600;padding:1px 6px;background:#ede9fe;border-radius:10px}';
  document.head.appendChild(style);

  loadAndRender();
}

document.addEventListener('DOMContentLoaded', init);
