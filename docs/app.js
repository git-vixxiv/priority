'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// ALGORITHMS  (WSJF · DAG · CPM — all run in the browser)
// ─────────────────────────────────────────────────────────────────────────────

function buildGraph(tasks) {
  var g = {};
  tasks.forEach(function(t) { if (t.Task_ID) g[t.Task_ID] = []; });
  tasks.forEach(function(task) {
    (task.Predecessor_IDs || '').split(',')
      .map(function(s) { return s.trim(); }).filter(Boolean)
      .forEach(function(pred) {
        if (!g[pred]) g[pred] = [];
        if (g[pred].indexOf(task.Task_ID) === -1) g[pred].push(task.Task_ID);
      });
  });
  return g;
}

function topoSort(graph) {
  var inDeg = {};
  Object.keys(graph).forEach(function(n) { inDeg[n] = inDeg[n] || 0; });
  Object.values(graph).forEach(function(succs) {
    succs.forEach(function(s) { inDeg[s] = (inDeg[s] || 0) + 1; });
  });
  var queue = Object.keys(inDeg).filter(function(n) { return !inDeg[n]; });
  var result = [];
  while (queue.length) {
    var n = queue.shift();
    result.push(n);
    (graph[n] || []).forEach(function(s) { if (--inDeg[s] === 0) queue.push(s); });
  }
  return result;
}

function calcAdjWSJF(taskId, base, graph, idx) {
  var visited = {};
  var queue = (graph[taskId] || []).slice();
  var total = 0;
  while (queue.length) {
    var cur = queue.shift();
    if (visited[cur]) continue;
    visited[cur] = true;
    total += parseFloat((idx[cur] && idx[cur].Base_WSJF) || 0);
    (graph[cur] || []).forEach(function(s) { if (!visited[s]) queue.push(s); });
  }
  return Math.round((base + 0.5 * total) * 100) / 100;
}

function critPath(graph, idx) {
  var order = topoSort(graph);
  if (!order.length) return { path: [], dur: 0 };

  var rev = {};
  Object.keys(graph).forEach(function(n) {
    (graph[n] || []).forEach(function(s) {
      if (!rev[s]) rev[s] = [];
      rev[s].push(n);
    });
  });

  var ef = {};
  order.forEach(function(n) {
    var dur   = Math.max(1, parseInt((idx[n] && idx[n].Duration_Days) || 1) || 1);
    var preds = rev[n] || [];
    var es    = preds.length ? Math.max.apply(null, preds.map(function(p) { return ef[p] || 0; })) : 0;
    ef[n] = es + dur;
  });

  var nodes = Object.keys(ef);
  if (!nodes.length) return { path: [], dur: 0 };

  var end = nodes.reduce(function(a, b) { return ef[a] > ef[b] ? a : b; });
  var totalDur = ef[end];
  var path = [];
  while (end && path.indexOf(end) === -1) {
    path.unshift(end);
    var preds = rev[end] || [];
    end = preds.length ? preds.reduce(function(a, b) { return (ef[a] || 0) > (ef[b] || 0) ? a : b; }) : null;
  }
  return { path: path, dur: totalDur };
}

// Returns IDs of nodes involved in dependency cycles (nodes absent from topo order).
function detectCycles(graph) {
  var order = topoSort(graph);
  var inOrder = {};
  order.forEach(function(n) { inOrder[n] = true; });
  return Object.keys(graph).filter(function(n) { return !inOrder[n]; });
}

function runAnalysis(allTasks) {
  var tasks = allTasks.map(function(t) { return Object.assign({}, t); });
  var graph = buildGraph(tasks);
  var idx   = {};
  tasks.forEach(function(t) { idx[t.Task_ID] = t; });

  tasks.forEach(function(t) {
    var v = +t.Value_Score, tc = +t.Time_Criticality, r = +t.RR_OE_Score, j = +t.Job_Size;
    if (v && tc && r && j) t.Base_WSJF = Math.round((v + tc + r) / j * 100) / 100;
  });

  tasks.forEach(function(t) {
    t.Adjusted_WSJF = calcAdjWSJF(t.Task_ID, parseFloat(t.Base_WSJF) || 0, graph, idx);
  });

  tasks.forEach(function(t) {
    t._on_critical_path = false;
    t._decompose_flag   = +t.Job_Size >= 13;
    t._bottleneck_flag  = (graph[t.Task_ID] || []).length >= 3 && +t.RR_OE_Score < 5;
  });

  var cp = critPath(graph, idx);
  cp.path.forEach(function(id) { if (idx[id]) idx[id]._on_critical_path = true; });

  var DONE      = ['Completed', 'Deferred'];
  var OBSERVING = ['Awaiting'];   // known, tracked, but no action possible yet

  var active = tasks
    .filter(function(t) { return DONE.indexOf(t.Status) === -1 && OBSERVING.indexOf(t.Status) === -1; })
    .sort(function(a, b) { return (b.Adjusted_WSJF || 0) - (a.Adjusted_WSJF || 0); });
  active.forEach(function(t, i) { t.Priority_Rank = i + 1; });

  var observing = tasks.filter(function(t) { return OBSERVING.indexOf(t.Status) !== -1; });
  var done      = tasks.filter(function(t) { return DONE.indexOf(t.Status) !== -1; });

  var cycleIds = detectCycles(graph);
  return { ranked: active.concat(observing).concat(done), cp: cp.path, cpDur: cp.dur, cycleIds: cycleIds };
}

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE  (localStorage)
// ─────────────────────────────────────────────────────────────────────────────

var DB = {
  KEY: 'priority_v1',

  load: function() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); }
    catch(e) { return []; }
  },

  save: function(tasks) {
    localStorage.setItem(this.KEY, JSON.stringify(tasks));
  },

  nextId: function(tasks) {
    var nums = tasks.map(function(t) { return parseInt((t.Task_ID || '').replace('T-', '')) || 0; });
    return 'T-' + String(Math.max.apply(null, [0].concat(nums)) + 1).padStart(3, '0');
  },

  add: function(task) {
    var tasks = this.load();
    task.Task_ID      = this.nextId(tasks);
    task.Last_Updated = today();
    tasks.push(task);
    this.save(tasks);
    return task;
  },

  update: function(id, patch) {
    var tasks = this.load();
    var i = -1;
    tasks.forEach(function(t, idx) { if (t.Task_ID === id) i = idx; });
    if (i === -1) return null;
    tasks[i] = Object.assign({}, tasks[i], patch, { Last_Updated: today() });
    this.save(tasks);
    return tasks[i];
  },

  remove: function(id) {
    this.save(this.load().filter(function(t) { return t.Task_ID !== id; }));
  },

  saveAll: function(tasks) { this.save(tasks); },
};

// ─────────────────────────────────────────────────────────────────────────────
// WIZARD DATA
// ─────────────────────────────────────────────────────────────────────────────

var TYPE_FRAMING = {
  opportunity: {
    q:    'How much value does completing this create?',
    hint: 'Think about positive impact — revenue, growth, efficiency, or personal satisfaction.',
    choices: [
      { dot: 'green',  label: 'Minor',       desc: 'Nice to have, but won\'t make much difference',         fib: 2  },
      { dot: 'yellow', label: 'Moderate',    desc: 'A noticeable positive effect',                          fib: 5  },
      { dot: 'orange', label: 'Significant', desc: 'Meaningful impact on your goals or situation',          fib: 8  },
      { dot: 'red',    label: 'Major',       desc: 'This is really important — high value if delivered',    fib: 13 },
      { dot: 'black',  label: 'Critical',    desc: 'Not doing this has serious consequences',               fib: 20 },
    ]
  },
  legal: {
    q:    'What happens if you don\'t act on this?',
    hint: 'Legal matters are about the downside of inaction — score by risk, not reward. If multiple matters conflict, score each independently; the system will sequence them.',
    choices: [
      { dot: 'green',  label: 'Minor exposure',    desc: 'Small risk, manageable if delayed',                         fib: 2  },
      { dot: 'yellow', label: 'Moderate risk',     desc: 'Real consequences, but not catastrophic',                   fib: 5  },
      { dot: 'orange', label: 'Significant risk',  desc: 'Meaningful harm to your case, standing, or finances',       fib: 8  },
      { dot: 'red',    label: 'Serious exposure',  desc: 'Major adverse outcome is likely without action',            fib: 13 },
      { dot: 'black',  label: 'Existential',       desc: 'Missing this could end the matter, cause default, or waive rights', fib: 20 },
    ]
  },
  health: {
    q:    'How important is this to your health or wellbeing?',
    hint: 'Health tasks often feel deferrable but compound over time — be honest about the real stakes.',
    choices: [
      { dot: 'green',  label: 'Routine maintenance', desc: 'Good to do, no urgency',                          fib: 2  },
      { dot: 'yellow', label: 'Beneficial',          desc: 'Meaningful improvement to wellbeing',             fib: 5  },
      { dot: 'orange', label: 'Important',           desc: 'Should not be delayed much longer',               fib: 8  },
      { dot: 'red',    label: 'Significant concern', desc: 'Delaying is creating real risk',                  fib: 13 },
      { dot: 'black',  label: 'Urgent',              desc: 'Needs to happen as soon as possible',             fib: 20 },
    ]
  },
  admin: {
    q:    'What\'s the consequence of skipping or delaying this?',
    hint: 'Administrative tasks often have hard deadlines with real penalties.',
    choices: [
      { dot: 'green',  label: 'Minimal',       desc: 'Low stakes, easy to catch up later',          fib: 2  },
      { dot: 'yellow', label: 'Inconvenient',  desc: 'Annoying but fixable',                        fib: 5  },
      { dot: 'orange', label: 'Problematic',   desc: 'Causes real hassle or cost',                  fib: 8  },
      { dot: 'red',    label: 'Serious',       desc: 'Penalties, lapses, or compliance issues',     fib: 13 },
      { dot: 'black',  label: 'Critical',      desc: 'Business or legal exposure if missed',        fib: 20 },
    ]
  },
  personal: {
    q:    'How much does this matter to you?',
    hint: 'Personal priorities are valid — score by how much it would actually mean to get this done.',
    choices: [
      { dot: 'green',  label: 'Nice to do',         desc: 'Pleasant but not pressing',                              fib: 2  },
      { dot: 'yellow', label: 'Meaningful',         desc: 'Would make a real difference in my life',                fib: 5  },
      { dot: 'orange', label: 'Important',          desc: 'This matters a lot to me',                               fib: 8  },
      { dot: 'red',    label: 'Really important',   desc: 'A priority that keeps getting pushed and shouldn\'t',    fib: 13 },
      { dot: 'black',  label: 'Critical to me',     desc: 'Not doing this is seriously affecting quality of life',  fib: 20 },
    ]
  },
};

var URGENCY_CHOICES = [
  { dot: 'green',  label: 'No rush',               desc: 'No deadline, can do anytime',                     fib: 1  },
  { dot: 'yellow', label: 'This month',            desc: 'Should happen in the next few weeks',             fib: 3  },
  { dot: 'orange', label: 'Coming up — weeks away',desc: 'Hard deadline in the next 2–3 weeks',             fib: 8  },
  { dot: 'red',    label: 'This week',             desc: 'Deadline in days',                                fib: 13 },
  { dot: 'black',  label: 'Overdue / expiring now',desc: 'Already late, or expires very soon',              fib: 20 },
];

var RIPPLE_CHOICES = [
  { dot: 'green',  label: 'Standalone',
    desc: 'Completing this doesn\'t move anything else — it stands on its own',
    fib: 1  },
  { dot: 'yellow', label: 'Minor ripple',
    desc: 'Makes 1–2 other things a bit easier, but nothing is waiting on it',
    fib: 3  },
  { dot: 'orange', label: 'Clear enabler',
    desc: 'Directly unblocks multiple tasks, frees recurring time, or opens a decision others are waiting on',
    fib: 8  },
  { dot: 'red',    label: 'Multiplier',
    desc: '5+ things waiting on this — or it generates money, resources, or capacity that fund significant other work',
    fib: 13 },
  { dot: 'black',  label: 'Force multiplier',
    desc: 'Doing this one thing materially advances a large portion of your remaining priorities, or produces the resources that make everything else possible',
    fib: 20 },
];

var EFFORT_CHOICES = [
  { dot: 'green',  label: 'Quick win — under 30 min', desc: 'Can be done in one short sitting',      fib: 1  },
  { dot: 'green',  label: 'A few hours',               desc: '1–4 hours of focused work',            fib: 2  },
  { dot: 'yellow', label: 'About a day',               desc: 'Half a day to a full working day',     fib: 3  },
  { dot: 'yellow', label: 'Several days',              desc: '2–4 days of focused work',             fib: 5  },
  { dot: 'orange', label: 'About a week',              desc: 'Roughly 5 working days',               fib: 8  },
  { dot: 'red',    label: 'Several weeks',             desc: 'A month or more of sustained work',    fib: 13 },
  { dot: 'black',  label: 'Major project',             desc: 'Months of effort',                     fib: 20 },
];

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────

var state = {
  tasks:        [],
  cp:           [],
  cpDur:        0,
  lastAnalyzed: null,
  editingId:    null,
  wizardStep:   1,
  wizardType:   null,
  wizardScores: { Value_Score: null, Time_Criticality: null, RR_OE_Score: null, Job_Size: null },
};

// ─────────────────────────────────────────────────────────────────────────────
// LOAD & RENDER
// ─────────────────────────────────────────────────────────────────────────────

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
  var active    = state.tasks.filter(function(t) { return ['Completed','Deferred','Awaiting'].indexOf(t.Status) === -1; }).length;
  var awaiting  = state.tasks.filter(function(t) { return t.Status === 'Awaiting'; }).length;
  var completed = state.tasks.filter(function(t) { return t.Status === 'Completed'; }).length;
  var el = document.getElementById('header-stats');
  el.innerHTML =
    '<div class="stat"><span class="stat-value">' + active + '</span> active</div>' +
    (awaiting ? '<div class="stat"><span class="stat-value">' + awaiting + '</span> awaiting</div>' : '') +
    '<div class="stat"><span class="stat-value">' + completed + '</span> completed</div>' +
    (state.lastAnalyzed ? '<div class="stat">analyzed <span class="stat-value">' + state.lastAnalyzed + '</span></div>' : '');
}

function renderBanner() {
  var el = document.getElementById('analysis-banner');
  if (!state.cp.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = '<strong>&#9889; Analysis complete</strong> &nbsp;Critical path: ' +
    state.cp.map(function(id) { return '<span class="cp-tag">' + esc(id) + '</span>'; }).join(' &rarr; ') +
    ' <span style="color:#4338ca">(' + state.cpDur + ' days total)</span>' +
    ' <span style="color:#6366f1;font-size:12px">&mdash; any delay here delays everything downstream</span>';
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

  var DONE = ['Completed', 'Deferred'];
  var rank = 0;

  list.innerHTML = state.tasks.map(function(task) {
    var isDone       = DONE.indexOf(task.Status) !== -1;
    var isAwaiting   = task.Status === 'Awaiting';
    var isActionable = !isDone && !isAwaiting;
    if (isActionable) rank++;

    var adj  = parseFloat(task.Adjusted_WSJF || task.Base_WSJF || 0);
    var base = parseFloat(task.Base_WSJF || 0);
    var lift = adj - base;
    var dominoHtml = lift > 0.5
      ? '<span class="domino-tag" title="Adjusted up by ' + lift.toFixed(2) + ' because it unblocks downstream tasks">&uarr;' + lift.toFixed(1) + ' domino</span>'
      : '';

    var flags = [
      task._on_critical_path ? '<span class="flag flag-cp">&#9733; critical path</span>' : '',
      task._decompose_flag   ? '<span class="flag flag-decomp">&darr; decompose</span>'  : '',
      task._bottleneck_flag  ? '<span class="flag flag-bn">&#9888; bottleneck</span>'    : '',
    ].filter(Boolean).join('');

    var noteHtml = task.Notes
      ? '<div class="task-note">' + esc(task.Notes.slice(0, 100)) + (task.Notes.length > 100 ? '&hellip;' : '') + '</div>'
      : '';

    var awaitingHtml = (isAwaiting && task.Awaiting_Description)
      ? '<div class="awaiting-desc">&#9201; Waiting for: ' + esc(task.Awaiting_Description) + '</div>'
      : '';

    var rankHtml = isActionable
      ? '<span class="task-rank">' + rank + '</span>'
      : '<span class="task-rank no-rank">&mdash;</span>';

    // Action buttons use data attributes — no inline JS, avoids injection via imported Task_IDs.
    var actionHtml;
    if (isDone) {
      actionHtml = '<button class="icon-btn" title="Reopen" data-action="reopen" data-id="' + esc(task.Task_ID) + '">&#8629;</button>';
    } else if (isAwaiting) {
      actionHtml = '<button class="icon-btn icon-btn-await" title="Mark resolved" data-action="done" data-id="' + esc(task.Task_ID) + '">&#10003;</button>';
    } else {
      actionHtml = '<button class="icon-btn" title="Mark complete" data-action="done" data-id="' + esc(task.Task_ID) + '">&#10003;</button>';
    }

    var catBadge    = task.Category ? '<span class="badge cat-badge">' + esc(task.Category) + '</span>' : '';
    var statusBadge = '<span class="badge ' + statusClass(task.Status) + '">' + esc(task.Status) + '</span>';
    var predHtml    = task.Predecessor_IDs ? '<span class="task-dep">after: ' + esc(task.Predecessor_IDs) + '</span>' : '';

    var cardClass = 'task-card';
    if (isDone)     cardClass += ' ' + task.Status.toLowerCase().replace(' ', '-');
    if (isAwaiting) cardClass += ' awaiting';

    // Card uses data-id only — click handled via event delegation in init().
    return '<div class="' + cardClass + '" data-id="' + esc(task.Task_ID) + '">' +
      rankHtml +
      '<div class="task-main">' +
        '<div class="task-name-row">' +
          '<span class="task-name' + (isDone ? ' strike' : '') + '" title="' + esc(task.Task_Name) + '">' + esc(task.Task_Name) + '</span>' +
          catBadge + statusBadge + flags +
        '</div>' +
        awaitingHtml +
        '<div class="task-meta">' +
          '<span class="wsjf-chip ' + wsjfClass(adj) + '">' + adj.toFixed(2) + '</span>' +
          dominoHtml +
          '<span class="task-score-detail">V=' + (task.Value_Score||'?') + ' T=' + (task.Time_Criticality||'?') + ' R=' + (task.RR_OE_Score||'?') + ' / J=' + (task.Job_Size||'?') + '</span>' +
          predHtml +
        '</div>' +
        noteHtml +
      '</div>' +
      '<div class="task-actions">' + actionHtml + '</div>' +
    '</div>';
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// WIZARD
// ─────────────────────────────────────────────────────────────────────────────

function showWizardStep(n) {
  for (var i = 1; i <= 6; i++) {
    var el = document.getElementById('ws-' + i);
    if (el) el.classList.add('hidden');
  }
  var cur = document.getElementById('ws-' + n);
  if (cur) cur.classList.remove('hidden');

  var pct = Math.round((n - 1) / 5 * 100);
  document.getElementById('wizard-progress-fill').style.width = pct + '%';
  document.getElementById('wizard-step-label').textContent = 'Step ' + n + ' of 6';

  document.getElementById('btn-back').style.display = n > 1 ? '' : 'none';
  document.getElementById('btn-next').textContent   = n < 6 ? 'Next →' : 'Save Task';

  state.wizardStep = n;

  if (n === 2) renderStakesChoices();
  if (n === 3) renderChoiceList('urgency-choices', URGENCY_CHOICES, 'Time_Criticality');
  if (n === 4) renderChoiceList('ripple-choices',  RIPPLE_CHOICES,  'RR_OE_Score');
  if (n === 5) renderChoiceList('effort-choices',  EFFORT_CHOICES,  'Job_Size');
  if (n === 6) renderWsjfResult();

  var body = document.querySelector('.wizard-body');
  if (body) body.scrollTop = 0;
}

function selectType(type) {
  state.wizardType = type;
  document.querySelectorAll('.type-card').forEach(function(card) {
    card.classList.toggle('active', card.dataset.type === type);
  });
}

function renderStakesChoices() {
  var framing = TYPE_FRAMING[state.wizardType || 'opportunity'];
  document.getElementById('step2-q').textContent    = framing.q;
  document.getElementById('step2-hint').textContent = framing.hint;
  renderChoiceList('stakes-choices', framing.choices, 'Value_Score');
}

function renderChoiceList(containerId, choices, scoreKey) {
  var container = document.getElementById(containerId);
  container.innerHTML = '';
  choices.forEach(function(ch) {
    var btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'choice-card' + (state.wizardScores[scoreKey] === ch.fib ? ' active' : '');
    btn.innerHTML =
      '<div class="choice-dot dot-' + ch.dot + '"></div>' +
      '<div><div class="choice-label">' + esc(ch.label) + '</div>' +
      '<div class="choice-desc">' + esc(ch.desc) + '</div></div>';
    (function(c, b) {
      b.onclick = function() {
        state.wizardScores[scoreKey] = c.fib;
        container.querySelectorAll('.choice-card').forEach(function(x) { x.classList.remove('active'); });
        b.classList.add('active');
      };
    })(ch, btn);
    container.appendChild(btn);
  });
}

function renderWsjfResult() {
  var sc  = state.wizardScores;
  var el  = document.getElementById('wsjf-result');
  var v   = sc.Value_Score, tc = sc.Time_Criticality, r = sc.RR_OE_Score, j = sc.Job_Size;
  if (!v || !tc || !r || !j) { el.classList.add('hidden'); return; }
  var base = Math.round((v + tc + r) / j * 100) / 100;
  var tier = base >= 10 ? 'HIGH' : base >= 5 ? 'MEDIUM' : 'LOW';
  el.classList.remove('hidden');
  el.innerHTML =
    '<div class="wsjf-result-row">' +
      '<span class="wsjf-result-score ' + (base >= 10 ? 'wsjf-high' : base >= 5 ? 'wsjf-medium' : 'wsjf-low') + '">' + base + '</span>' +
      '<span class="wsjf-result-label">base priority score &mdash; <strong>' + tier + '</strong></span>' +
    '</div>' +
    '<div class="wsjf-result-breakdown">Stakes&nbsp;' + v + ' &middot; Urgency&nbsp;' + tc + ' &middot; Ripple&nbsp;' + r + ' &divide; Effort&nbsp;' + j + '</div>';
}

function wizardNext() {
  var n = state.wizardStep;
  if (n === 1) {
    var name = document.getElementById('f-name').value.trim();
    if (!name)            { document.getElementById('f-name').focus(); toast('Please enter a task name', 'error'); return; }
    if (!state.wizardType){ toast('Please select what kind of task this is', 'error'); return; }
  }
  if (n === 2 && !state.wizardScores.Value_Score)      { toast('Please select an option to continue', 'error'); return; }
  if (n === 3 && !state.wizardScores.Time_Criticality) { toast('Please select an option to continue', 'error'); return; }
  if (n === 4 && !state.wizardScores.RR_OE_Score)      { toast('Please select an option to continue', 'error'); return; }
  if (n === 5 && !state.wizardScores.Job_Size)          { toast('Please select an option to continue', 'error'); return; }
  if (n === 6) { saveTask(); return; }
  showWizardStep(n + 1);
}

function wizardBack() {
  if (state.wizardStep > 1) showWizardStep(state.wizardStep - 1);
}

function onStatusChange() {
  var isAwaiting = document.getElementById('f-status').value === 'Awaiting';
  document.getElementById('awaiting-field').style.display = isAwaiting ? '' : 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// MODAL OPEN / CLOSE
// ─────────────────────────────────────────────────────────────────────────────

// Infer task type from stored tag, category name, or task name keywords.
function inferType(task) {
  if (task._type && TYPE_FRAMING[task._type]) return task._type;
  var combined = ((task.Category || '') + ' ' + (task.Task_Name || '')).toLowerCase();
  if (/legal|law|court|compliance|litigation|regulat|tax|counsel|attorney|appeal|ruling/.test(combined)) return 'legal';
  if (/health|medical|doctor|fitness|wellness|therapy|mental|physical|bloodwork/.test(combined)) return 'health';
  if (/admin|administrat|renewal|insurance|license|permit|filing|logistics/.test(combined)) return 'admin';
  if (/personal|relation|family|friend|growth|self/.test(combined)) return 'personal';
  return 'opportunity';
}

function openNew() {
  state.editingId   = null;
  state.wizardType  = null;
  state.wizardScores = { Value_Score: null, Time_Criticality: null, RR_OE_Score: null, Job_Size: null };

  document.getElementById('btn-delete').style.display      = 'none';
  document.getElementById('f-name').value                  = '';
  document.getElementById('f-category').value              = '';
  document.getElementById('f-status').value                = 'Backlog';
  document.getElementById('f-awaiting').value              = '';
  document.getElementById('f-predecessors').value          = '';
  document.getElementById('f-duration').value              = '';
  document.getElementById('f-notes').value                 = '';
  document.getElementById('awaiting-field').style.display  = 'none';
  document.querySelectorAll('.type-card').forEach(function(c) { c.classList.remove('active'); });

  showWizardStep(1);
  document.getElementById('modal').classList.remove('hidden');
  setTimeout(function() { document.getElementById('f-name').focus(); }, 60);
}

function openEdit(id) {
  var task = null;
  state.tasks.forEach(function(t) { if (t.Task_ID === id) task = t; });
  if (!task) return;

  state.editingId   = id;
  // Use null when score is missing/invalid so the wizard shows no pre-selection
  // rather than silently substituting a fabricated value.
  state.wizardScores = {
    Value_Score:      parseInt(task.Value_Score)      || null,
    Time_Criticality: parseInt(task.Time_Criticality) || null,
    RR_OE_Score:      parseInt(task.RR_OE_Score)      || null,
    Job_Size:         parseInt(task.Job_Size)          || null,
  };

  state.wizardType = inferType(task);

  document.getElementById('btn-delete').style.display      = 'inline-flex';
  document.getElementById('f-name').value                  = task.Task_Name || '';
  document.getElementById('f-category').value              = task.Category  || '';
  document.getElementById('f-status').value                = task.Status    || 'Backlog';
  document.getElementById('f-awaiting').value              = task.Awaiting_Description || '';
  document.getElementById('f-predecessors').value          = task.Predecessor_IDs || '';
  document.getElementById('f-duration').value              = task.Duration_Days   || '';
  document.getElementById('f-notes').value                 = task.Notes    || '';
  document.getElementById('awaiting-field').style.display  = task.Status === 'Awaiting' ? '' : 'none';

  document.querySelectorAll('.type-card').forEach(function(c) {
    c.classList.toggle('active', c.dataset.type === state.wizardType);
  });

  showWizardStep(1);
  document.getElementById('modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
  state.editingId = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SAVE / DELETE
// ─────────────────────────────────────────────────────────────────────────────

function saveTask() {
  var name = document.getElementById('f-name').value.trim();
  if (!name) { toast('Task name is required', 'error'); showWizardStep(1); return; }

  var sc = state.wizardScores;
  var v  = sc.Value_Score      || 3;
  var tc = sc.Time_Criticality || 3;
  var r  = sc.RR_OE_Score      || 3;
  var j  = sc.Job_Size         || 3;
  var base = Math.round((v + tc + r) / j * 100) / 100;

  var status = document.getElementById('f-status').value || 'Backlog';

  var payload = {
    Task_Name:            name,
    Category:             document.getElementById('f-category').value,
    Status:               status,
    Value_Score:          v,
    Time_Criticality:     tc,
    RR_OE_Score:          r,
    Job_Size:             j,
    Base_WSJF:            base,
    Adjusted_WSJF:        base,
    Predecessor_IDs:      document.getElementById('f-predecessors').value.trim(),
    Duration_Days:        parseInt(document.getElementById('f-duration').value) || '',
    Notes:                document.getElementById('f-notes').value.trim(),
    Awaiting_Description: status === 'Awaiting' ? document.getElementById('f-awaiting').value.trim() : '',
    _type:                state.wizardType || 'opportunity',
  };

  var wasEditing = !!state.editingId;
  if (wasEditing) {
    DB.update(state.editingId, payload);
  } else {
    DB.add(payload);
  }

  // Re-run full analysis immediately so Adjusted_WSJF reflects the dependency graph.
  var result = runAnalysis(DB.load());
  DB.saveAll(result.ranked);
  state.tasks  = result.ranked;
  state.cp     = result.cp;
  state.cpDur  = result.cpDur;

  closeModal();
  render();
  toast(wasEditing ? 'Task updated' : 'Task added');
}

function deleteTask() {
  if (!state.editingId) return;
  if (!confirm('Delete this task? This cannot be undone.')) return;
  DB.remove(state.editingId);
  closeModal();
  loadAndRender();
  toast('Task deleted');
}

// ─────────────────────────────────────────────────────────────────────────────
// QUICK ACTIONS
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// ANALYZE
// ─────────────────────────────────────────────────────────────────────────────

function analyze() {
  var tasks = DB.load();
  if (!tasks.length) { toast('No tasks to analyze', 'error'); return; }

  var btn = document.getElementById('btn-analyze');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing…';

  setTimeout(function() {
    try {
      var result = runAnalysis(tasks);
      DB.saveAll(result.ranked);
      state.tasks        = result.ranked;
      state.cp           = result.cp;
      state.cpDur        = result.cpDur;
      state.lastAnalyzed = new Date().toLocaleTimeString();
      render();

      if (result.cycleIds && result.cycleIds.length) {
        toast('Circular dependency on ' + result.cycleIds.join(', ') + ' — check Predecessor IDs', 'error');
      } else {
        var activeCount = result.ranked.filter(function(t) { return ['Completed','Deferred','Awaiting'].indexOf(t.Status) === -1; }).length;
        toast('Analysis complete — ' + activeCount + ' tasks ranked', 'info');
      }
    } catch(e) {
      toast('Analysis failed: ' + e.message, 'error');
    } finally {
      btn.disabled  = false;
      btn.innerHTML = '⚡ Analyze';
    }
  }, 30);
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT
// ─────────────────────────────────────────────────────────────────────────────

function showReport() {
  var tasks = DB.load();
  if (!tasks.length) { toast('No tasks yet', 'error'); return; }

  var ranked = tasks, cp = state.cp, cpDur = state.cpDur;
  if (!state.lastAnalyzed) {
    var res = runAnalysis(tasks);
    ranked = res.ranked; cp = res.cp; cpDur = res.cpDur;
  }

  var DONE      = ['Completed', 'Deferred'];
  var active    = ranked.filter(function(t) { return DONE.indexOf(t.Status) === -1 && t.Status !== 'Awaiting'; });
  var awaiting  = ranked.filter(function(t) { return t.Status === 'Awaiting'; });
  var completed = tasks.filter(function(t)  { return t.Status === 'Completed'; });
  var d         = today();

  var lines = [
    '# Priority Report — ' + d, '',
    'Active: ' + active.length + ' | Awaiting: ' + awaiting.length + ' | Completed: ' + completed.length,
    cp.length ? 'Critical path: ' + cp.join(' → ') + ' (' + cpDur + ' days)' : '',
    '', '| # | ID | Score | Status | Task |', '|---|---|---|---|---|',
  ];

  active.forEach(function(t, i) {
    var mark = t._on_critical_path ? ' ★' : '';
    lines.push('| ' + (i+1) + ' | ' + t.Task_ID + ' | ' + (t.Adjusted_WSJF||'?') + ' | ' + t.Status + ' | ' + t.Task_Name + mark + ' |');
  });

  if (awaiting.length) {
    lines.push('', '## Awaiting External Outcome', '');
    awaiting.forEach(function(t) {
      var desc = t.Awaiting_Description ? ' (' + t.Awaiting_Description + ')' : '';
      lines.push('- **' + t.Task_Name + '** `' + t.Task_ID + '`' + desc);
    });
  }

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

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT / EXPORT
// ─────────────────────────────────────────────────────────────────────────────

function exportData() {
  var tasks = DB.load();
  if (!tasks.length) { toast('Nothing to export', 'error'); return; }
  var blob = new Blob([JSON.stringify(tasks, null, 2)], { type: 'application/json' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href     = url;
  a.download = 'priority-' + today() + '.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported ' + tasks.length + ' tasks');
}

function importData() {
  var input   = document.createElement('input');
  input.type  = 'file';
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
      } catch(err) {
        toast('Import failed: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ─────────────────────────────────────────────────────────────────────────────
// SEED DATA
// ─────────────────────────────────────────────────────────────────────────────

function seedData() {
  if (DB.load().length && !confirm('Load demo data? This will replace your current tasks.')) return;

  var demos = [
    { Task_Name:'Set up OAuth credentials for data pipeline', Category:'Professional', _type:'opportunity',
      Value_Score:2, Time_Criticality:5, RR_OE_Score:13, Job_Size:1,
      Duration_Days:1, Status:'Backlog', Predecessor_IDs:'',
      Notes:'Blocks all downstream data work. Unlocks T-002, T-003, T-008.' },
    { Task_Name:'Build analytics dashboard for client reporting', Category:'Professional', _type:'opportunity',
      Value_Score:13, Time_Criticality:8, RR_OE_Score:5, Job_Size:8,
      Duration_Days:5, Status:'Backlog', Predecessor_IDs:'T-001',
      Notes:'Client demo scheduled. Requires OAuth (T-001).' },
    { Task_Name:'Automate monthly financial reports', Category:'Professional', _type:'opportunity',
      Value_Score:8, Time_Criticality:3, RR_OE_Score:5, Job_Size:5,
      Duration_Days:3, Status:'Backlog', Predecessor_IDs:'T-001',
      Notes:'Saves ~8h/month once built. Also needs OAuth.' },
    { Task_Name:'Draft Q3 strategy memo for executive team', Category:'Professional', _type:'opportunity',
      Value_Score:8, Time_Criticality:13, RR_OE_Score:8, Job_Size:3,
      Duration_Days:2, Status:'Backlog', Predecessor_IDs:'',
      Notes:'Board meeting in 10 days. Hard deadline.' },
    { Task_Name:'Migrate legacy customer database schema', Category:'Professional', _type:'opportunity',
      Value_Score:5, Time_Criticality:2, RR_OE_Score:8, Job_Size:13,
      Duration_Days:8, Status:'Backlog', Predecessor_IDs:'',
      Notes:'Large task — Job_Size 13 triggers decomposition flag.' },
    { Task_Name:'Schedule annual physical and bloodwork', Category:'Health', _type:'health',
      Value_Score:8, Time_Criticality:5, RR_OE_Score:3, Job_Size:1,
      Duration_Days:1, Status:'Backlog', Predecessor_IDs:'',
      Notes:'10-minute task that keeps getting deferred.' },
    { Task_Name:'Renew business insurance policy', Category:'Administrative', _type:'admin',
      Value_Score:5, Time_Criticality:20, RR_OE_Score:2, Job_Size:2,
      Duration_Days:1, Status:'Backlog', Predecessor_IDs:'',
      Notes:'Policy lapses in 3 weeks. High time criticality.' },
    { Task_Name:'Complete OAuth integration for client portal', Category:'Professional', _type:'opportunity',
      Value_Score:8, Time_Criticality:5, RR_OE_Score:5, Job_Size:3,
      Duration_Days:2, Status:'Blocked', Predecessor_IDs:'T-001',
      Notes:'Blocked waiting for credentials (T-001).' },
    { Task_Name:'8th Circuit Court of Appeals — await ruling', Category:'Legal', _type:'legal',
      Value_Score:20, Time_Criticality:1, RR_OE_Score:13, Job_Size:1,
      Duration_Days:1, Status:'Awaiting', Predecessor_IDs:'',
      Awaiting_Description:'8th Circuit ruling on appeal — no action possible until decision issues',
      Notes:'Outcome determines next steps in T-010. Monitor docket.' },
  ];

  // Build and save in one pass — no O(n²) load/save loop.
  var all = demos.map(function(d, i) {
    var id = 'T-' + String(i + 1).padStart(3, '0');
    var v = d.Value_Score, tc = d.Time_Criticality, r = d.RR_OE_Score, j = d.Job_Size;
    return Object.assign({}, d, {
      Task_ID:       id,
      Base_WSJF:     Math.round((v + tc + r) / j * 100) / 100,
      Adjusted_WSJF: Math.round((v + tc + r) / j * 100) / 100,
      Last_Updated:  today(),
    });
  });
  DB.save(all);

  loadAndRender();
  toast('Loaded demo tasks — click ⚡ Analyze to rank them', 'info');
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function today() { return new Date().toISOString().slice(0, 10); }

function statusClass(s) {
  return { 'Backlog':'status-backlog', 'In Progress':'status-in-progress',
           'Blocked':'status-blocked', 'Completed':'status-completed',
           'Deferred':'status-deferred', 'Awaiting':'status-awaiting' }[s] || 'status-backlog';
}

function wsjfClass(v) { return v >= 10 ? 'wsjf-high' : v >= 5 ? 'wsjf-medium' : 'wsjf-low'; }

function toast(msg, type) {
  var el = document.createElement('div');
  el.className   = 'toast toast-' + (type || 'success');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(function() { el.remove(); }, 3800);
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────

function init() {
  document.getElementById('btn-new').onclick     = openNew;
  document.getElementById('btn-analyze').onclick = analyze;
  document.getElementById('btn-report').onclick  = showReport;
  document.getElementById('btn-export').onclick  = exportData;
  document.getElementById('btn-import').onclick  = importData;
  document.getElementById('btn-new-empty').onclick = openNew;
  document.getElementById('btn-seed').onclick      = seedData;
  document.getElementById('modal-close').onclick   = closeModal;
  document.getElementById('btn-cancel').onclick    = closeModal;
  document.getElementById('btn-delete').onclick    = deleteTask;

  document.getElementById('modal').addEventListener('click', function(e) {
    if (e.target === document.getElementById('modal')) closeModal();
  });

  document.getElementById('report-close').onclick    = function() { document.getElementById('report-modal').classList.add('hidden'); };
  document.getElementById('btn-copy-report').onclick = copyReport;
  document.getElementById('report-modal').addEventListener('click', function(e) {
    if (e.target === document.getElementById('report-modal')) document.getElementById('report-modal').classList.add('hidden');
  });

  // Event delegation for task list — handles card clicks and action buttons
  // without inline JS, keeping Task_IDs from imported data out of executable context.
  document.getElementById('task-list').addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (btn) {
      e.stopPropagation();
      var id = btn.dataset.id;
      if (btn.dataset.action === 'done')   markDone(id);
      if (btn.dataset.action === 'reopen') reopen(id);
      return;
    }
    var card = e.target.closest('.task-card[data-id]');
    if (card) openEdit(card.dataset.id);
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      document.getElementById('modal').classList.add('hidden');
      document.getElementById('report-modal').classList.add('hidden');
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (!document.getElementById('modal').classList.contains('hidden')) wizardNext();
    }
  });

  loadAndRender();
}

document.addEventListener('DOMContentLoaded', init);
