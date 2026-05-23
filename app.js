'use strict';

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

const state = {
  tasks:       [],
  cp:          [],
  cpDur:       0,
  lastAnalyzed: null,
  editingId:   null,
  scores:      { Value_Score: 3, Time_Criticality: 3, RR_OE_Score: 3, Job_Size: 3 },
};

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
  document.getElementById('header-stats').innerHTML = [
    '<div class="stat"><span class="stat-value">' + active + '</span> active</div>',
    '<div class="stat"><span class="stat-value">' + completed + '</span> completed</div>',
    state.lastAnalyzed ? '<div class="stat">analyzed <span class="stat-value">' + state.lastAnalyzed + '</span></div>' : ''
  ].join('');
}

function renderBanner() {
  const el = document.getElementById('analysis-banner');
  if (!state.cp.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = '<strong>&#9889; Analysis complete</strong> Critical path: ' +
    state.cp.map(function(id) { return '<span class="cp-tag">' + esc(id) + '</span>'; }).join(' &rarr; ') +
    ' <span style="color:#4338ca">(' + state.cpDur + ' days total)</span>' +
    ' <span style="color:#6366f1;font-size:12px"> &mdash; any delay here delays everything downstream</span>';
}

function renderTaskList() {
  var list  = document.getElementById('task-list');
  var empty = document.getElementById('empty-state');

  if (!state.tasks.length) {
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.classList.remove('hidden');

  var rank = 0;
  list.innerHTML = state.tasks.map(function(task) {
    var isDone = task.Status === 'Completed' || task.Status === 'Deferred';
    if (!isDone) rank++;

    var adj  = parseFloat(task.Adjusted_WSJF || task.Base_WSJF || 0);
    var base = parseFloat(task.Base_WSJF || 0);
    var lift = adj - base;
    var dominoTag = lift > 0.5
      ? '<span class="domino-tag" title="Adjusted up by ' + lift.toFixed(2) + ' because it unblocks downstream tasks">&uarr;' + lift.toFixed(1) + ' domino</span>'
      : '';

    var flags = [
      task._on_critical_path ? '<span class="flag flag-cp">&#9733; critical path</span>' : '',
      task._decompose_flag   ? '<span class="flag flag-decomp">&darr; decompose</span>'  : '',
      task._bottleneck_flag  ? '<span class="flag flag-bn">&#9888; bottleneck</span>'    : '',
    ].filter(Boolean).join('');

    var note = task.Notes
      ? '<div class="task-note">' + esc(task.Notes.slice(0, 100)) + (task.Notes.length > 100 ? '&hellip;' : '') + '</div>'
      : '';

    var rankHtml = isDone
      ? '<span class="task-rank no-rank">&mdash;</span>'
      : '<span class="task-rank">' + rank + '</span>';

    var actionBtn = task.Status !== 'Completed'
      ? '<button class="icon-btn" title="Mark complete" onclick="markDone(\'' + esc(task.Task_ID) + '\')">&check;</button>'
      : '<button class="icon-btn" title="Reopen" onclick="reopen(\'' + esc(task.Task_ID) + '\')">&crarr;</button>';

    var catBadge = task.Category ? '<span class="badge cat-badge">' + esc(task.Category) + '</span>' : '';
    var statusBadge = '<span class="badge ' + statusClass(task.Status) + '">' + esc(task.Status) + '</span>';
    var predSpan = task.Predecessor_IDs ? '<span style="font-size:11px;color:#9ca3af">after: ' + esc(task.Predecessor_IDs) + '</span>' : '';

    return '<div class="task-card ' + (isDone ? task.Status.toLowerCase().replace(' ', '-') : '') + '"' +
      ' data-id="' + esc(task.Task_ID) + '" onclick="openEdit(\'' + esc(task.Task_ID) + '\')">\n' +
      rankHtml + '\n' +
      '<div class="task-main">\n' +
      '<div class="task-name-row">' +
      '<span class="task-name' + (isDone ? ' strike' : '') + '" title="' + esc(task.Task_Name) + '">' + esc(task.Task_Name) + '</span>' +
      catBadge + statusBadge + flags +
      '</div>\n' +
      '<div class="task-meta">' +
      '<span class="wsjf-chip ' + wsjfClass(adj) + '">' + adj.toFixed(2) + '</span>' +
      dominoTag +
      '<span class="task-score-row">V=' + (task.Value_Score||'?') + ' T=' + (task.Time_Criticality||'?') + ' R=' + (task.RR_OE_Score||'?') + ' / J=' + (task.Job_Size||'?') + '</span>' +
      predSpan +
      '</div>\n' +
      note +
      '</div>\n' +
      '<div class="task-actions" onclick="event.stopPropagation()">' + actionBtn + '</div>\n' +
      '</div>';
  }).join('');
}

function openNew() {
  state.editingId = null;
  state.scores    = { Value_Score: 3, Time_Criticality: 3, RR_OE_Score: 3, Job_Size: 3 };

  document.getElementById('modal-title').textContent  = 'New Task';
  document.getElementById('btn-delete').style.display = 'none';
  document.getElementById('status-field').style.display = 'none';

  document.getElementById('f-name').value         = '';
  document.getElementById('f-category').value     = '';
  document.getElementById('f-status').value       = 'Backlog';
  document.getElementById('f-predecessors').value = '';
  document.getElementById('f-duration').value     = '';
  document.getElementById('f-notes').value        = '';

  renderFibGroups();
  updateWsjfPreview();
  document.getElementById('modal').classList.remove('hidden');
  setTimeout(function() { document.getElementById('f-name').focus(); }, 60);
}

function openEdit(id) {
  var task = state.tasks.find(function(t) { return t.Task_ID === id; });
  if (!task) return;

  state.editingId = id;
  state.scores = {
    Value_Score:      parseInt(task.Value_Score)      || 3,
    Time_Criticality: parseInt(task.Time_Criticality) || 3,
    RR_OE_Score:      parseInt(task.RR_OE_Score)      || 3,
    Job_Size:         parseInt(task.Job_Size)          || 3,
  };

  document.getElementById('modal-title').textContent    = 'Edit Task';
  document.getElementById('btn-delete').style.display   = 'inline-flex';
  document.getElementById('status-field').style.display = '';

  document.getElementById('f-name').value         = task.Task_Name        || '';
  document.getElementById('f-category').value     = task.Category         || '';
  document.getElementById('f-status').value       = task.Status           || 'Backlog';
  document.getElementById('f-predecessors').value = task.Predecessor_IDs  || '';
  document.getElementById('f-duration').value     = task.Duration_Days    || '';
  document.getElementById('f-notes').value        = task.Notes            || '';

  renderFibGroups();
  updateWsjfPreview();
  document.getElementById('modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
  state.editingId = null;
}

function renderFibGroups() {
  ['Value_Score', 'Time_Criticality', 'RR_OE_Score', 'Job_Size'].forEach(function(field) {
    var el = document.getElementById('fib-' + field);
    if (!el) return;
    el.innerHTML = FIBS.map(function(n) {
      return '<button type="button" class="fib-btn' + (state.scores[field] === n ? ' active' : '') +
        '" onclick="selectFib(\'' + field + '\',' + n + ')">' + n + '</button>';
    }).join('');
  });
}

function selectFib(field, value) {
  state.scores[field] = value;
  renderFibGroups();
  updateWsjfPreview();
}

function updateWsjfPreview() {
  var v = state.scores.Value_Score, t = state.scores.Time_Criticality,
      r = state.scores.RR_OE_Score,  j = state.scores.Job_Size;
  document.getElementById('wsjf-preview').textContent = j > 0 ? ((v + t + r) / j).toFixed(2) : '—';
}

function saveTask() {
  var name = document.getElementById('f-name').value.trim();
  if (!name) { document.getElementById('f-name').focus(); toast('Task name is required', 'error'); return; }

  var payload = {
    Task_Name:        name,
    Category:         document.getElementById('f-category').value,
    Status:           document.getElementById('f-status').value || 'Backlog',
    Value_Score:      state.scores.Value_Score,
    Time_Criticality: state.scores.Time_Criticality,
    RR_OE_Score:      state.scores.RR_OE_Score,
    Job_Size:         state.scores.Job_Size,
    Predecessor_IDs:  document.getElementById('f-predecessors').value.trim(),
    Duration_Days:    parseInt(document.getElementById('f-duration').value) || '',
    Notes:            document.getElementById('f-notes').value.trim(),
  };

  var v = payload.Value_Score, tc = payload.Time_Criticality,
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

function analyze() {
  var tasks = DB.load();
  if (!tasks.length) { toast('No tasks to analyze', 'error'); return; }

  var btn = document.getElementById('btn-analyze');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing…';

  setTimeout(function() {
    try {
      var result = runAnalysis(tasks);
      DB.saveAll(result.ranked);

      state.tasks       = result.ranked;
      state.cp          = result.cp;
      state.cpDur       = result.cpDur;
      state.lastAnalyzed = new Date().toLocaleTimeString();

      render();

      var activeCount = result.ranked.filter(function(t) { return t.Status !== 'Completed' && t.Status !== 'Deferred'; }).length;
      toast('Analysis complete — ' + activeCount + ' tasks ranked', 'info');
    } catch (e) {
      toast('Analysis failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '⚡ Analyze';
    }
  }, 30);
}

function showReport() {
  var tasks = DB.load();
  if (!tasks.length) { toast('No tasks yet', 'error'); return; }

  var ranked = tasks, cp = state.cp, cpDur = state.cpDur;
  if (!state.lastAnalyzed) {
    var res = runAnalysis(tasks);
    ranked = res.ranked; cp = res.cp; cpDur = res.cpDur;
  }

  var active    = ranked.filter(function(t) { return t.Status !== 'Completed' && t.Status !== 'Deferred'; });
  var completed = tasks.filter(function(t) { return t.Status === 'Completed'; });
  var d = today();

  var lines = [
    '# Priority Report — ' + d, '',
    'Active: ' + active.length + ' | Completed: ' + completed.length,
    cp.length ? 'Critical path: ' + cp.join(' → ') + ' (' + cpDur + ' days)' : '',
    '', '| # | ID | Adj.WSJF | Status | Task |', '|---|---|---|---|---|',
  ];

  active.forEach(function(t, i) {
    var cp_mark = t._on_critical_path ? ' ★' : '';
    lines.push('| ' + (i+1) + ' | ' + t.Task_ID + ' | ' + (t.Adjusted_WSJF || '?') + ' | ' + t.Status + ' | ' + t.Task_Name + cp_mark + ' |');
  });

  if (completed.length) {
    lines.push('', '## Completed', '');
    completed.forEach(function(t) { lines.push('- ~~' + t.Task_Name + '~~ `' + t.Task_ID + '`'); });
  }

  lines.push('', '---', '*Generated ' + d + ' · Priority Engine*');

  document.getElementById('report-content').textContent = lines.filter(function(l) { return l !== ''; }).join('\n') || '(empty)';
  document.getElementById('report-modal').classList.remove('hidden');
}

function copyReport() {
  navigator.clipboard.writeText(document.getElementById('report-content').textContent).then(
    function() { toast('Copied to clipboard'); },
    function() { toast('Copy failed — try selecting and copying manually', 'error'); }
  );
}

function exportData() {
  var tasks = DB.load();
  if (!tasks.length) { toast('Nothing to export', 'error'); return; }
  var blob = new Blob([JSON.stringify(tasks, null, 2)], { type: 'application/json' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href = url;
  a.download = 'priority-' + today() + '.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported ' + tasks.length + ' tasks');
}

function importData() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      try {
        var tasks = JSON.parse(ev.target.result);
        if (!Array.isArray(tasks)) throw new Error('File must contain a JSON array');
        if (!confirm('Import ' + tasks.length + ' tasks? This will replace your current data.')) return;
        DB.save(tasks);
        loadAndRender();
        toast('Imported ' + tasks.length + ' tasks');
      } catch (err) {
        toast('Import failed: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function seedData() {
  if (DB.load().length && !confirm('Load demo data? This will replace your current tasks.')) return;

  var demos = [
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
  demos.forEach(function(d, i) {
    var id = 'T-' + String(i + 1).padStart(3, '0');
    var v = d.Value_Score, tc = d.Time_Criticality, r = d.RR_OE_Score, j = d.Job_Size;
    var all = DB.load();
    all.push(Object.assign({}, d, {
      Task_ID:       id,
      Base_WSJF:     Math.round((v + tc + r) / j * 100) / 100,
      Adjusted_WSJF: Math.round((v + tc + r) / j * 100) / 100,
      Last_Updated:  today(),
    }));
    DB.save(all);
  });

  loadAndRender();
  toast('Loaded 8 demo tasks — click ⚡ Analyze to rank them', 'info');
}

function esc(s)  { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function today() { return new Date().toISOString().slice(0, 10); }

function statusClass(s) {
  return { 'Backlog':'status-backlog', 'In Progress':'status-in-progress',
    'Blocked':'status-blocked', 'Completed':'status-completed', 'Deferred':'status-deferred' }[s] || 'status-backlog';
}

function wsjfClass(v) {
  return v >= 10 ? 'wsjf-high' : v >= 5 ? 'wsjf-medium' : 'wsjf-low';
}

function toast(msg, type) {
  if (!type) type = 'success';
  var el = document.createElement('div');
  el.className  = 'toast toast-' + type;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(function() { el.remove(); }, 3800);
}

function init() {
  document.getElementById('btn-new').onclick     = openNew;
  document.getElementById('btn-analyze').onclick = analyze;
  document.getElementById('btn-report').onclick  = showReport;
  document.getElementById('btn-export').onclick  = exportData;
  document.getElementById('btn-import').onclick  = importData;

  document.getElementById('btn-new-empty').onclick = openNew;
  document.getElementById('btn-seed').onclick      = seedData;

  document.getElementById('modal-close').onclick = closeModal;
  document.getElementById('btn-cancel').onclick  = closeModal;
  document.getElementById('btn-save').onclick    = saveTask;
  document.getElementById('btn-delete').onclick  = deleteTask;
  document.getElementById('modal').addEventListener('click', function(e) { if (e.target === document.getElementById('modal')) closeModal(); });

  document.getElementById('report-close').onclick    = function() { document.getElementById('report-modal').classList.add('hidden'); };
  document.getElementById('btn-copy-report').onclick = copyReport;
  document.getElementById('report-modal').addEventListener('click', function(e) {
    if (e.target === document.getElementById('report-modal')) document.getElementById('report-modal').classList.add('hidden');
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      document.getElementById('modal').classList.add('hidden');
      document.getElementById('report-modal').classList.add('hidden');
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (!document.getElementById('modal').classList.contains('hidden')) saveTask();
    }
  });

  var style = document.createElement('style');
  style.textContent = '.domino-tag{font-size:11px;color:#7c3aed;font-weight:600;padding:1px 6px;background:#ede9fe;border-radius:10px}';
  document.head.appendChild(style);

  loadAndRender();
}

document.addEventListener('DOMContentLoaded', init);
