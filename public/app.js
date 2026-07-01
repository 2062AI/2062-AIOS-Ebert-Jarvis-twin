// app.js — Dashboard frontend (Ep 15/16)
// Sidebar nav, live data polling, approve/reject, and a floating AI avatar
// that glides to a new position as you move between tabs.

// Session token from login (replaces the old chat-id header).
let TOKEN = localStorage.getItem('jarvisToken') || '';

const POLL_INTERVAL = 4000;
let pollTimer = null;
let currentTab = 'overview';

const TAB_META = {
  overview:  { title: 'Overview',  sub: 'Your AI operating system at a glance' },
  tasks:     { title: 'Tasks',     sub: 'Everything Jarvis is working on' },
  approvals: { title: 'Approvals', sub: 'Tasks waiting on your decision' },
  missions:  { title: 'Missions',  sub: 'Mission registry & status' },
  subagents: { title: 'Agent Team', sub: 'Chat with a specialist; bring Jarvis in to collaborate' },
  meetings:  { title: 'Meetings',  sub: 'Your scheduled meetings' },
  assistant: { title: 'Assistant', sub: 'Meet Ebert, your AI' },
  revenue:   { title: 'Revenue',   sub: 'Income, expenses & profit toward $5–10K/mo' },
  customers: { title: 'Customers', sub: 'Leads and clients' },
  communications: { title: 'Communications', sub: 'Outgoing & received' },
  calendar:  { title: 'Calendar',  sub: 'Events & meetings' },
  meetings:  { title: 'Meetings',  sub: 'Your scheduled meetings' },
  knowledge: { title: 'Knowledge', sub: 'What Jarvis knows, by classification tier' },
  youtube:   { title: 'YouTube',   sub: 'Live @YourChannel channel insights' },
  ember:     { title: 'Ember',     sub: 'Chief Brand Officer — brand & PR (drafts only)' },
  skills:    { title: 'Skills',    sub: 'Reusable, safety-checked instructions Ebert can load' },
  quarantine:{ title: 'Quarantine', sub: 'Uploads held by the safety gate, awaiting your call' },
  files:     { title: 'Files',     sub: 'Browse and upload to allowed folders' },
  activity:  { title: 'Activity',  sub: 'LLM usage and model routing' },
  audit:     { title: 'Audit',     sub: 'Tamper-proof action log' },
  status:    { title: 'Status',    sub: 'Budget, spend, and safety' },
};

const miniAvatar = document.getElementById('avatar-mini');

/* ---------- Navigation ---------- */
// Sidebar items + any element with data-tab (Ebert chips) switch tabs.
document.querySelectorAll('[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  currentTab = tab;

  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.getElementById(`${tab}-tab`).classList.add('active');
  document.querySelector(`.nav-item[data-tab="${tab}"]`)?.classList.add('active');

  const meta = TAB_META[tab];
  document.getElementById('page-title').textContent = meta.title;
  document.getElementById('page-sub').textContent = meta.sub;

  // Hide the floating mini-Ebert on the Assistant tab (big one shows there).
  if (miniAvatar) miniAvatar.classList.toggle('hidden', tab === 'assistant');

  if (tab === 'overview') loadOverview();
  if (tab === 'tasks') loadTasks();
  if (tab === 'approvals') loadApprovals();
  if (tab === 'status') { loadStatus(); loadProbes(); }
  if (tab === 'subagents') loadSubagentsTab();
  if (tab === 'files') loadFiles();
  if (tab === 'knowledge') loadKnowledge();
  if (tab === 'youtube') loadYouTube();
  if (tab === 'ember') loadEmber();
  if (tab === 'skills') loadSkills();
  if (tab === 'quarantine') loadQuarantine();
  if (tab === 'missions') { loadMissions(); loadSubagents(); }
  if (tab === 'meetings') loadMeetings();
  if (tab === 'revenue') loadRevenue();
  if (tab === 'customers') loadCustomers();
  if (tab === 'communications') loadComms();
  if (tab === 'calendar') loadCalendar();
  if (tab === 'activity') loadActivity();
  if (tab === 'audit') loadAudit();
  if (tab === 'assistant') { document.getElementById('chat-text')?.focus(); loadTgSession(); }
}

/* ===================== Command-center + new tabs ===================== */
function money(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }

// --- Overview command-center widgets ---
async function loadCommandCenter() {
  try {
    const [status, tasks] = await Promise.all([api('/api/status'), fetchTasks()]);
    const pending = tasks.filter(t => t.status === 'awaiting_approval').length;
    const ccA = document.getElementById('cc-approvals');
    document.getElementById('cc-approval-count').textContent = pending;
    ccA.classList.toggle('urgent', pending > 0);
    document.getElementById('cc-spend').textContent = money(status.spentTodayUsd);
    document.getElementById('cc-cap').textContent = '/ ' + money(status.capUsd);
    document.getElementById('cc-budget-fill').style.width = Math.min(100, (status.spentTodayUsd / status.capUsd) * 100) + '%';
    document.getElementById('cc-month-spend').textContent = money(status.spentThisMonthUsd || 0);
    const ks = document.getElementById('cc-kill-state');
    ks.textContent = status.killSwitchActive ? '🔴 ACTIVE' : '🟢 OFF';
    ks.className = 'cc-kill-state ' + (status.killSwitchActive ? 'on' : 'off');
    document.getElementById('cc-kill-btn').dataset.active = status.killSwitchActive ? '1' : '0';
  } catch (e) {}
  updateQuarantineBadge();
  // Missions mini + latest report
  api('/api/missions').then(ms => {
    const el = document.getElementById('overview-missions');
    const active = ms.filter(m => m.status === 'active');
    el.innerHTML = active.length ? active.map(miniMission).join('') : '<div class="empty-state">No active missions</div>';
  }).catch(() => {});
  api('/api/reports/latest').then(r => {
    const el = document.getElementById('overview-report');
    el.textContent = r.content ? r.content.slice(0, 700) : 'No reports yet — they generate at 4am/8pm.';
  }).catch(() => {});

  // Agent team overview
  api('/api/subagents').then(d => {
    const el = document.getElementById('overview-agents');
    if (!el) return;
    const now = Date.now();
    // Build activity map from recent events (last 7 days)
    const activeMap = {};
    (d.events || []).forEach(e => {
      const age = now - new Date(e.ts).getTime();
      if (age < 7 * 86400000 && e.payload?.domain) activeMap[e.payload.domain] = true;
    });
    el.innerHTML = (d.domains || []).map(agent => {
      const active = activeMap[agent.id];
      return `<button class="agent-chip${active ? ' agent-chip--active' : ''}" data-domain="${agent.id}" title="Open ${agent.label}">
        <span class="ac-emoji">${agent.emoji || '◈'}</span>
        <span class="ac-name">${escapeHtml(agent.id)}</span>
        <span class="ac-dot ${active ? 'dot-on' : 'dot-off'}"></span>
      </button>`;
    }).join('');
    el.querySelectorAll('.agent-chip').forEach(btn => {
      btn.onclick = () => { switchTab('subagents'); setTimeout(() => selectAgent(btn.dataset.domain, btn.dataset.domain), 100); };
    });
  }).catch(() => { const el = document.getElementById('overview-agents'); if (el) el.innerHTML = '<div class="empty-state">Could not load agents</div>'; });
}

// Brief button
document.getElementById('ov-brief-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('ov-brief-btn');
  btn.disabled = true; btn.textContent = '⏳ Generating…';
  try {
    const r = await api('/api/brief', { method: 'POST' });
    document.getElementById('reader-title').textContent = 'Daily Sovereign Brief';
    document.getElementById('reader-body').innerHTML = renderMarkdown(r.brief || '(no content)');
    document.getElementById('reader-overlay').hidden = false;
  } catch (e) { alert('Brief failed: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '⚡ Daily Brief'; }
});
function miniMission(m) {
  const pct = m.percentComplete || 0;
  return `<div class="mini-card"><div class="mc-top"><span class="mc-name">${escapeHtml(m.name)}</span><span class="task-status status-${m.status}">${m.status}</span></div><div class="mc-sub">${escapeHtml(m.category || '')} — ${escapeHtml(m.goal || '')}</div><div class="progress-track mini"><div class="progress-fill" style="width:${pct}%"></div></div></div>`;
}
document.getElementById('cc-kill-btn')?.addEventListener('click', async () => {
  const willActivate = document.getElementById('cc-kill-btn').dataset.active !== '1';
  if (willActivate && !confirm('Halt ALL LLM activity now?')) return;
  try { const s = await api('/api/killswitch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: willActivate }) }); updateChrome(s); loadCommandCenter(); } catch (e) { alert(e.message); }
});
document.getElementById('cc-approvals')?.addEventListener('click', () => switchTab('approvals'));
document.getElementById('ov-report-open')?.addEventListener('click', async () => {
  try { const r = await api('/api/reports/latest'); if (r.content) { document.getElementById('reader-title').textContent = r.file || 'Morning Report'; document.getElementById('reader-body').innerHTML = renderMarkdown(r.content); document.getElementById('reader-overlay').hidden = false; } } catch (e) {}
});
document.getElementById('ov-weekly-open')?.addEventListener('click', async () => {
  const btn = document.getElementById('ov-weekly-open');
  btn.textContent = 'Loading…';
  try {
    const r = await api('/api/reports/weekly');
    if (r.content) {
      document.getElementById('reader-title').textContent = r.file || 'Weekly Intelligence Report';
      document.getElementById('reader-body').innerHTML = renderMarkdown(r.content);
      document.getElementById('reader-overlay').hidden = false;
    } else {
      alert('No weekly report yet — run /weekly_review in Telegram or wait for the weekly cron.');
    }
  } catch (e) { alert('Could not load weekly report: ' + e.message); }
  finally { btn.textContent = 'Weekly Intel'; }
});

// --- Missions tab ---
async function loadMissions() {
  const el = document.getElementById('missions-list');
  try {
    const ms = await api('/api/missions');
    el.innerHTML = ms.length ? ms.map(missionCard).join('') : '<div class="empty-state">No missions yet — create one in Telegram with /propose_mission</div>';
    wireMissionCards(el);
  } catch (e) { el.innerHTML = '<div class="empty-state">Could not load missions</div>'; }
}

function missionCard(m) {
  const pct = m.percentComplete || 0;
  const can = (m.canDo || []).map(x => `<li>${escapeHtml(x)}</li>`).join('');
  const cant = (m.cannotDo || []).map(x => `<li>${escapeHtml(x)}</li>`).join('');
  const ms = (m.milestones || []).map(x =>
    `<label class="ms-item ${x.done ? 'done' : ''}"><input type="checkbox" data-mid="${m.id}" data-msid="${x.id}" ${x.done ? 'checked' : ''}><span>${escapeHtml(x.label)}</span></label>`
  ).join('');
  const links = (m.links || []).map(l => `<button class="link-chip" data-tab="${l.tab}">${escapeHtml(l.label)} →</button>`).join('');
  const taskLine = (m.tasks && m.tasks.total > 0)
    ? `<span class="mcard-tasks">Tasks: ${m.tasks.done}/${m.tasks.total} done</span>` : '';
  return `
  <div class="mission-card">
    <div class="mcard-head">
      <div class="mcard-title"><span class="mcard-name">${escapeHtml(m.name)}</span><span class="task-status status-${m.status}">${m.status}</span></div>
      <span class="mcard-pct">${pct}%</span>
    </div>
    <div class="mcard-cat">${escapeHtml(m.category || '')} ${taskLine}</div>
    <div class="mcard-goal">${escapeHtml(m.goal || '')}</div>
    <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    ${(can || cant) ? `<div class="mcard-cols">
      ${can ? `<div><div class="mcard-label">✅ Jarvis can</div><ul class="mcard-ul">${can}</ul></div>` : ''}
      ${cant ? `<div><div class="mcard-label">⛔ Won't without approval</div><ul class="mcard-ul">${cant}</ul></div>` : ''}
    </div>` : ''}
    <div class="mcard-label">Milestones</div>
    <div class="ms-list" data-mid="${m.id}">${ms || '<span class="muted-line">No milestones</span>'}
      <div class="ms-add"><input class="ms-add-input" placeholder="Add a milestone…" data-mid="${m.id}"><button class="btn ms-add-btn" data-mid="${m.id}">+ Add</button></div>
    </div>
    ${links ? `<div class="mcard-links"><span class="mcard-label">Related</span>${links}</div>` : ''}
  </div>`;
}

function wireMissionCards(root) {
  // Toggle milestones
  root.querySelectorAll('.ms-item input[type=checkbox]').forEach(cb => {
    cb.onchange = async () => {
      try { await api(`/api/missions/${cb.dataset.mid}/milestone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'toggle', milestoneId: cb.dataset.msid }) }); loadMissions(); }
      catch (e) { alert('Could not update: ' + e.message); cb.checked = !cb.checked; }
    };
  });
  // Add milestone
  root.querySelectorAll('.ms-add-btn').forEach(btn => {
    btn.onclick = async () => {
      const input = root.querySelector(`.ms-add-input[data-mid="${btn.dataset.mid}"]`);
      const label = (input && input.value || '').trim();
      if (!label) return;
      try { await api(`/api/missions/${btn.dataset.mid}/milestone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', label }) }); loadMissions(); }
      catch (e) { alert('Could not add: ' + e.message); }
    };
  });
  // Related links → jump to tab
  root.querySelectorAll('.link-chip').forEach(b => { b.onclick = () => switchTab(b.dataset.tab); });
}

// --- Revenue tab ---
async function loadRevenue() {
  try {
    const s = await api('/api/revenue');
    document.getElementById('rev-income').textContent = money(s.income);
    document.getElementById('rev-expense').textContent = money(s.expense);
    document.getElementById('rev-profit').textContent = money(s.profit);
    renderKV('rev-by-source', s.bySource);
    renderKV('rev-by-month', s.byMonth);
    const list = document.getElementById('rev-list');
    list.innerHTML = s.rows.length ? s.rows.map(r => `
      <div class="rec-row"><div class="rec-main"><div class="rec-title">${escapeHtml(r.source)} <span class="rec-pill">${r.kind}</span></div>
      <div class="rec-meta">${r.month}${r.note ? ' · ' + escapeHtml(r.note) : ''}</div></div>
      <span class="rec-amt ${r.kind}">${r.kind === 'expense' ? '-' : ''}${money(r.amount_usd)}</span>
      <button class="rec-del" onclick="delRec('revenue',${r.id})">✕</button></div>`).join('') : '<div class="empty-state">No entries yet — add your first above</div>';
  } catch (e) { document.getElementById('rev-list').innerHTML = '<div class="empty-state">Could not load revenue</div>'; }
}
function renderKV(elId, obj) {
  const el = document.getElementById(elId);
  const entries = Object.entries(obj || {});
  if (!entries.length) { el.innerHTML = '<div class="empty-state">No data</div>'; return; }
  const max = Math.max(...entries.map(([, v]) => Math.abs(v))) || 1;
  el.innerHTML = entries.map(([k, v]) => `<div class="bar-row"><span class="bar-name">${escapeHtml(k)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round(Math.abs(v) / max * 100)}%;background:${v < 0 ? 'var(--red)' : 'linear-gradient(90deg,#16b364,#34d399)'}"></div></div><span class="bar-count">${money(v)}</span></div>`).join('');
}

// --- generic tracker form submit + delete ---
function recForm(formId, endpoint, after) {
  const f = document.getElementById(formId);
  if (!f) return;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f).entries());
    try { await api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); f.reset(); after(); }
    catch (err) { alert('Could not save: ' + err.message); }
  });
}
async function delRec(kind, id) {
  if (!confirm('Delete this entry?')) return;
  try { await api(`/api/${kind}/${id}`, { method: 'DELETE' }); switchTab(currentTab); } catch (e) { alert(e.message); }
}

// --- Customers ---
async function loadCustomers() {
  try {
    const cs = await api('/api/customers');
    document.getElementById('cust-list').innerHTML = cs.length ? cs.map(c => `
      <div class="rec-row"><div class="rec-main"><div class="rec-title">${escapeHtml(c.name)} ${c.company ? '· ' + escapeHtml(c.company) : ''} <span class="rec-pill">${c.status}</span></div>
      <div class="rec-meta">${[c.email, c.phone].filter(Boolean).map(escapeHtml).join(' · ')}</div></div>
      <button class="rec-del" onclick="delRec('customers',${c.id})">✕</button></div>`).join('') : '<div class="empty-state">No customers yet</div>';
  } catch (e) { document.getElementById('cust-list').innerHTML = '<div class="empty-state">Could not load</div>'; }
}

// --- Communications ---
async function loadComms() {
  try {
    const cs = await api('/api/communications');
    document.getElementById('comm-list').innerHTML = cs.length ? cs.map(c => `
      <div class="rec-row"><div class="rec-main"><div class="rec-title">${c.direction === 'out' ? '↗ Outgoing' : '↘ Received'} · ${escapeHtml(c.channel)} ${c.party ? '· ' + escapeHtml(c.party) : ''}</div>
      <div class="rec-meta">${escapeHtml(c.subject || '')}${c.body ? ' — ' + escapeHtml(c.body) : ''} · ${new Date(c.created_at).toLocaleString()}</div></div>
      <button class="rec-del" onclick="delRec('communications',${c.id})">✕</button></div>`).join('') : '<div class="empty-state">No communications logged yet</div>';
  } catch (e) { document.getElementById('comm-list').innerHTML = '<div class="empty-state">Could not load</div>'; }
}

// --- Calendar / Meetings ---
const KIND_ICON = { meeting: '◇', deadline: '⚑', task: '✔', event: '▦' };
function eventRow(ev) {
  const icon = KIND_ICON[ev.kind] || '▦';
  const kindClass = ev.kind === 'deadline' ? ' ev-deadline' : ev.kind === 'task' ? ' ev-task' : '';
  return `<div class="rec-row${kindClass}"><div class="rec-main" style="cursor:pointer" onclick="openEventEdit(${ev.id})">
    <div class="rec-title">${icon} ${escapeHtml(ev.title)}</div>
    <div class="rec-meta">${new Date(ev.starts_at).toLocaleString()}${ev.location ? ' · ' + escapeHtml(ev.location) : ''}${ev.attendees ? ' · ' + escapeHtml(ev.attendees) : ''}${ev.note ? ' · ' + escapeHtml(ev.note.slice(0,60)) + (ev.note.length>60?'…':'') : ''}</div>
  </div>
  <button class="btn-icon" title="Edit" onclick="openEventEdit(${ev.id})">✎</button>
  <button class="rec-del" onclick="delRec('events',${ev.id})">✕</button></div>`;
}

// Cache all events for the edit modal lookup
let _allEvents = [];
async function loadCalendar() {
  try { _allEvents = await api('/api/events'); } catch (e) { _allEvents = []; }
  renderCalGrid(_allEvents);
  const list = document.getElementById('cal-list');
  const upcoming = _allEvents.filter(e => new Date(e.starts_at) >= new Date(Date.now() - 86400000));
  list.innerHTML = upcoming.length ? upcoming.map(eventRow).join('') : '<div class="empty-state">No upcoming events</div>';
}

function openEventEdit(id) {
  const ev = _allEvents.find(e => e.id === id);
  if (!ev) return;
  document.getElementById('event-edit-id').value = ev.id;
  document.getElementById('event-edit-title').value = ev.title;
  // Convert UTC stored value to local datetime-local format
  const local = new Date(ev.starts_at);
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  document.getElementById('event-edit-starts_at').value = local.toISOString().slice(0, 16);
  document.getElementById('event-edit-kind').value = ev.kind || 'event';
  document.getElementById('event-edit-location').value = ev.location || '';
  document.getElementById('event-edit-attendees').value = ev.attendees || '';
  document.getElementById('event-edit-note').value = ev.note || '';
  document.getElementById('event-edit-overlay').hidden = false;
}

document.getElementById('event-edit-close')?.addEventListener('click', () => {
  document.getElementById('event-edit-overlay').hidden = true;
});
document.getElementById('event-edit-overlay')?.addEventListener('click', (e) => {
  if (e.target.id === 'event-edit-overlay') e.target.hidden = true;
});
document.getElementById('event-edit-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('event-edit-id').value;
  const data = {
    title:     document.getElementById('event-edit-title').value,
    starts_at: document.getElementById('event-edit-starts_at').value,
    kind:      document.getElementById('event-edit-kind').value,
    location:  document.getElementById('event-edit-location').value,
    attendees: document.getElementById('event-edit-attendees').value,
    note:      document.getElementById('event-edit-note').value,
  };
  try {
    await api(`/api/events/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    document.getElementById('event-edit-overlay').hidden = true;
    loadCalendar();
  } catch(err) { alert('Could not save: ' + err.message); }
});
document.getElementById('event-edit-delete')?.addEventListener('click', async () => {
  const id = document.getElementById('event-edit-id').value;
  if (!confirm('Delete this event?')) return;
  try {
    await api(`/api/events/${id}`, { method: 'DELETE' });
    document.getElementById('event-edit-overlay').hidden = true;
    loadCalendar();
  } catch(err) { alert('Could not delete: ' + err.message); }
});
let calMonth = new Date(); // first-of-month cursor
function renderCalGrid(events) {
  const grid = document.getElementById('cal-grid');
  const label = document.getElementById('cal-month');
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  label.textContent = calMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
  const first = new Date(y, m, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayStr = new Date().toDateString();
  // events grouped by yyyy-m-d
  const byDay = {};
  for (const e of events) {
    const d = new Date(e.starts_at);
    if (d.getFullYear() === y && d.getMonth() === m) (byDay[d.getDate()] = byDay[d.getDate()] || []).push(e);
  }
  let html = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => `<div class="cal-dow">${d}</div>`).join('');
  for (let i = 0; i < startDow; i++) html += '<div class="cal-cell empty"></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = new Date(y, m, day).toDateString() === todayStr;
    const evs = (byDay[day] || []).map(e => `<div class="cal-ev ${e.kind}" title="${escapeHtml(e.title)}">${escapeHtml(e.title)}</div>`).join('');
    html += `<div class="cal-cell ${isToday ? 'today' : ''}"><div class="cal-date">${day}</div>${evs}</div>`;
  }
  grid.innerHTML = html;
}
document.getElementById('cal-prev')?.addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() - 1); loadCalendar(); });
document.getElementById('cal-next')?.addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() + 1); loadCalendar(); });
document.getElementById('cal-today')?.addEventListener('click', () => { calMonth = new Date(); loadCalendar(); });

/* --- Sub-agent monitor (Missions tab) --- */
let subDomainsLoaded = false;
async function loadSubagents() {
  try {
    const d = await api('/api/subagents');
    if (!subDomainsLoaded) {
      const sel = document.getElementById('delegate-domain');
      sel.innerHTML = d.domains.map(x => `<option value="${x.id}">${escapeHtml(x.label)}</option>`).join('');
      subDomainsLoaded = true;
    }
    const act = document.getElementById('subagent-activity');
    act.innerHTML = d.events.length ? d.events.map(e => {
      const p = e.payload || {};
      const verb = e.kind === 'subagent_spawned' ? '▶ spawned' : (e.kind === 'subagent_retired' ? '■ retired' : e.kind);
      return `<div class="rec-row audit-ev"><div class="rec-main"><div class="rec-title">${verb} · ${escapeHtml(p.domain || '')}</div><div class="rec-meta">${escapeHtml(p.workerId || '')} · ${new Date(e.ts).toLocaleString()}</div></div></div>`;
    }).join('') : '<div class="empty-state">No sub-agent activity yet — delegate one above</div>';
  } catch (e) {
    document.getElementById('subagent-activity').innerHTML = '<div class="empty-state">Could not load</div>';
  }
}
document.getElementById('delegate-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const domain = f.domain.value, task = f.task.value.trim();
  if (!task) return;
  const out = document.getElementById('delegate-result');
  out.innerHTML = '<div class="loading">Sub-agent working…</div>';
  try {
    const r = await api('/api/delegate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain, task }) });
    out.innerHTML = `<div class="mini-card"><div class="mc-top"><span class="mc-name">${escapeHtml(r.domain)} worker — retired</span></div><div class="mc-sub">${escapeHtml(r.result)}</div></div>`;
    f.task.value = '';
    loadSubagents();
  } catch (err) { out.innerHTML = '<div class="empty-state">Failed: ' + escapeHtml(err.message) + '</div>'; }
});

/* --- Telegram session history (Assistant tab) --- */
async function loadTgSession() {
  const el  = document.getElementById('tg-session-history');
  const lbl = document.getElementById('tg-session-status');
  if (!el) return;
  try {
    const rows = await api('/api/telegram/history');
    if (!rows.length) {
      if (lbl) lbl.textContent = 'No Telegram history yet — start a conversation in Telegram.';
      el.innerHTML = '<div class="empty-state">No Telegram conversation history yet.</div>';
      return;
    }
    // Session gap detection
    const lastTs  = new Date(rows[rows.length - 1].ts);
    const gapMs   = Date.now() - lastTs.getTime();
    const gapHrs  = Math.round(gapMs / 3600000);
    let sessionTag, tagClass;
    if (gapHrs < 2) {
      sessionTag = '🟢 Active session'; tagClass = 'dot-on';
    } else if (gapHrs < 48) {
      sessionTag = `🟡 Session gap — last active ${gapHrs}h ago`; tagClass = '';
    } else {
      const days = Math.round(gapHrs / 24);
      sessionTag = `🔴 New session — last active ${days}d ago`; tagClass = '';
    }
    if (lbl) lbl.textContent = `${sessionTag} · ${rows.length} messages stored`;

    el.innerHTML = rows.map(m => {
      const isOwner = m.role === 'owner';
      const time = new Date(m.ts).toLocaleString();
      return `<div class="agent-msg ${isOwner ? 'owner' : 'agent'}">
        <div class="agent-who">${isOwner ? 'Alex' : 'Ebert'} · ${time}</div>
        <div class="agent-bubble">${renderMarkdown(escapeHtml(m.content))}</div>
      </div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  } catch (e) {
    el.innerHTML = '<div class="empty-state">Could not load Telegram history.</div>';
  }
}
document.getElementById('tg-session-clear')?.addEventListener('click', async () => {
  if (!confirm('Clear Ebert\'s Telegram session history? He will start fresh on the next message.')) return;
  try {
    await api('/api/telegram/clear', { method: 'POST' });
    loadTgSession();
  } catch (e) { alert('Clear failed: ' + e.message); }
});

/* --- Meetings tab --- */
async function loadMeetings() {
  const upcoming = document.getElementById('meetings-upcoming');
  const past = document.getElementById('meetings-past');
  try {
    const rows = await api('/api/events');
    const meetings = rows.filter(e => e.kind === 'meeting');
    const now = new Date();
    const future = meetings.filter(e => new Date(e.starts_at) >= now).sort((a,b) => new Date(a.starts_at)-new Date(b.starts_at));
    const prev   = meetings.filter(e => new Date(e.starts_at) <  now).sort((a,b) => new Date(b.starts_at)-new Date(a.starts_at)).slice(0,10);
    const renderMeeting = e => `<div class="rec-row"><div class="rec-main">
      <div class="rec-title">${escapeHtml(e.title)}</div>
      <div class="rec-meta">${new Date(e.starts_at).toLocaleString()}${e.location ? ' · ' + escapeHtml(e.location) : ''}${e.attendees ? ' · ' + escapeHtml(e.attendees) : ''}</div>
    </div></div>`;
    if (upcoming) upcoming.innerHTML = future.length ? future.map(renderMeeting).join('') : '<div class="empty-state">No upcoming meetings</div>';
    if (past) past.innerHTML = prev.length ? prev.map(renderMeeting).join('') : '<div class="empty-state">No past meetings</div>';
  } catch(e) {
    if (upcoming) upcoming.innerHTML = '<div class="empty-state">Could not load meetings</div>';
  }
}

/* --- Commands reference modal --- */
const COMMANDS = [
  ['Core', [['/ask <q>', 'Ask Jarvis (vault-aware)'], ['/newtask <title>', 'Plan a task, approve to run'], ['/tasks', 'List recent tasks'], ['/budget', 'Spend vs. cap'], ['/killswitch_on · /killswitch_off', 'Halt / resume all LLM calls'], ['/report [morning|evening]', 'Run a report now'], ['/backup', 'Back up DB + vault']]],
  ['Missions & agents', [['/propose_mission', 'Define a new mission (interview)'], ['/missions', 'List active missions'], ['/lesson <mission_id>', 'Request a coaching lesson'], ['/delegate <domain> <task>', 'Spawn a specialist sub-agent']]],
  ['Content', [['/content <topic>', 'Draft social posts']]],
  ['Intelligence', [['/brief', 'Generate Daily Sovereign Brief now'], ['/weekly_review', 'Sovereign Weekly Intelligence Report'], ['/report [morning|evening]', 'Run a report now']]],
  ['Safety & audit', [['/audit', 'Recent audit events'], ['/audit_verify', 'Verify the hash chain'], ['/secrets_test', 'Test the secret guard'], ['/propose_improvement', 'Engine proposes one improvement']]],
  ['GitHub', [['/repo_init', 'One-time repo init + push'], ['/commit <msg>', 'Stage, scan secrets, push'], ['/commit_status', 'Preview a commit']]],
];
document.getElementById('commands-btn')?.addEventListener('click', () => {
  const body = document.getElementById('commands-body');
  body.innerHTML = COMMANDS.map(([group, items]) => `
    <h3 style="margin:14px 0 8px">${group}</h3>
    ${items.map(([c, d]) => `<div class="rec-row"><div class="rec-main"><div class="rec-title"><code>${escapeHtml(c)}</code></div><div class="rec-meta">${escapeHtml(d)}</div></div></div>`).join('')}
  `).join('') + '<p class="files-hint">These work in Telegram. Many also have dashboard tabs/buttons.</p>';
  document.getElementById('commands-overlay').hidden = false;
});
document.getElementById('commands-close')?.addEventListener('click', () => { document.getElementById('commands-overlay').hidden = true; });
document.getElementById('commands-overlay')?.addEventListener('click', (e) => { if (e.target.id === 'commands-overlay') e.target.hidden = true; });

/* --- Voice dictation (chat) --- */
(function setupDictation() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = document.getElementById('mic-btn');
  if (!mic) return;

  // Visible, on-screen status so you never need the developer console.
  const say = (text) => { try { addMsg(text, 'bot'); } catch { alert(text); } };

  // Plain-English explanation for each Web Speech API error code.
  const explain = (code) => ({
    'not-allowed':         '🎤 Microphone is blocked. Click the 🔒/camera icon in the address bar → set Microphone to Allow → reload.',
    'service-not-allowed': '🎤 Microphone is blocked by the browser or OS. Check Windows Settings → Privacy → Microphone, allow your browser, then reload.',
    'no-speech':           '🎤 I didn\'t hear anything. Click the mic and speak right away.',
    'audio-capture':       '🎤 No microphone found. Check that your laptop mic is connected and not disabled.',
    'network':             '🎤 Voice typing needs internet (it uses Google\'s speech service) and works best in Chrome or Edge. Check your connection or just type instead.',
    'aborted':             '',
  }[code] ?? `🎤 Mic error: ${code}. Try again, or just type your message.`);

  if (!SR) {
    mic.style.opacity = 0.5;
    mic.title = 'Voice typing needs Chrome or Edge';
    mic.addEventListener('click', () =>
      say('🎤 Voice typing isn\'t supported in this browser. Open Jarvis in Google Chrome or Microsoft Edge and it will work.'));
    return;
  }

  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let listening = false;

  rec.onstart = () => {
    listening = true;
    mic.classList.add('listening');
    mic.title = 'Listening… (click to stop)';
  };
  rec.onresult = (e) => {
    let txt = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      txt += e.results[i][0].transcript;
    }
    document.getElementById('chat-text').value = txt;
  };
  rec.onend = () => {
    listening = false;
    mic.classList.remove('listening');
    mic.title = 'Click to dictate';
  };
  rec.onerror = (e) => {
    listening = false;
    mic.classList.remove('listening');
    mic.title = 'Click to dictate';
    const m = explain(e.error);
    if (m) say(m); // 'aborted' is benign — stay quiet
  };

  mic.addEventListener('click', async () => {
    if (listening) { rec.stop(); return; }
    // Proactively confirm mic permission so we can give a clear message.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop()); // release immediately
    } catch (err) {
      say(explain(err.name === 'NotAllowedError' ? 'not-allowed'
        : err.name === 'NotFoundError' ? 'audio-capture'
        : 'service-not-allowed'));
      return;
    }
    try {
      rec.start();
      mic.title = 'Listening…';
    } catch (e) {
      // start() throws if already started — safe to ignore
    }
  });
})();

// --- Activity (LLM usage / model routing) ---
async function loadActivity() {
  try {
    const u = await api('/api/usage');
    const byModel = {}; u.byModel.forEach(m => byModel[m.model + ' (' + m.calls + ')'] = m.cost);
    renderKV('usage-by-model', byModel);
    document.getElementById('usage-recent').innerHTML = u.recent.length ? u.recent.map(r => `
      <div class="rec-row"><div class="rec-main"><div class="rec-title">${escapeHtml(r.tag)} <span class="rec-pill">${escapeHtml(r.model)}</span></div>
      <div class="rec-meta">${new Date(r.ts).toLocaleString()} · in ${r.input_tokens} / out ${r.output_tokens}</div></div>
      <span class="rec-amt">${money(r.est_cost_usd)}</span></div>`).join('') : '<div class="empty-state">No LLM calls yet</div>';
  } catch (e) { document.getElementById('usage-recent').innerHTML = '<div class="empty-state">Could not load</div>'; }
}

// --- Audit ---
async function loadAudit() {
  const el = document.getElementById('audit-list');
  try {
    const rows = await api('/api/audit');
    el.innerHTML = rows.length ? rows.map(r => `<div class="rec-row audit-ev"><div class="rec-main"><div class="rec-title">#${r.id} ${escapeHtml(r.kind)}</div><div class="rec-meta">${new Date(r.ts).toLocaleString()} · ${escapeHtml(JSON.stringify(r.payload))}</div></div></div>`).join('') : '<div class="empty-state">No events</div>';
  } catch (e) { el.innerHTML = '<div class="empty-state">Could not load audit log</div>'; }
}
document.getElementById('audit-verify-btn')?.addEventListener('click', async () => {
  const st = document.getElementById('audit-state');
  try {
    const v = await api('/api/audit/verify');
    st.className = 'audit-state ' + (v.ok ? 'ok' : 'bad');
    st.textContent = v.ok ? `✅ Chain valid — ${v.count} events, tail ${(v.tail || '').slice(0, 12)}…` : `🛑 BROKEN at #${v.brokenAt} (${v.reason})`;
  } catch (e) { st.className = 'audit-state bad'; st.textContent = 'Verify failed: ' + e.message; }
});

// Register tracker add-forms (elements exist in DOM even when tab hidden).
recForm('rev-form', '/api/revenue', loadRevenue);
recForm('cust-form', '/api/customers', loadCustomers);
recForm('comm-form', '/api/communications', loadComms);
recForm('cal-form', '/api/events', loadCalendar);

/* ---------- Funding tab (Season 4: Homestead) ---------- */
const STATUS_OPTIONS = ['not_started', 'researching', 'outreach', 'applied', 'approved', 'denied'];
function usd(n) { return '$' + Number(n).toLocaleString('en-US'); }


async function loadYouTube() {
  const list = document.getElementById('yt-list');
  list.innerHTML = '<div class="loading">Loading…</div>';
  const n = (x) => Number(x || 0).toLocaleString('en-US');
  try {
    const s = await api('/api/youtube');
    document.getElementById('yt-subs').textContent = n(s.channel.subscribers);
    document.getElementById('yt-views').textContent = n(s.channel.views);
    document.getElementById('yt-count').textContent = n(s.channel.videoCount);
    document.getElementById('yt-title').textContent = s.channel.title;
    if (!s.videos.length) { list.innerHTML = '<div class="empty-state">No videos found</div>'; return; }
    list.innerHTML = s.videos.map(v => `
      <a class="yt-row" href="https://youtu.be/${encodeURIComponent(v.videoId)}" target="_blank" rel="noopener">
        <div class="yt-main">
          <div class="yt-vtitle">${escapeHtml(v.title)}</div>
          <div class="yt-meta">${(v.publishedAt || '').slice(0, 10)}</div>
        </div>
        <div class="yt-stats">
          <span>👁 ${n(v.views)}</span>
          <span>👍 ${n(v.likes)}</span>
          <span>💬 ${n(v.comments)}</span>
        </div>
      </a>`).join('');
  } catch (e) {
    ['yt-subs', 'yt-views', 'yt-count'].forEach(id => document.getElementById(id).textContent = '—');
    if (/\b503\b/.test(e.message)) {
      document.getElementById('yt-title').textContent = 'Not connected';
      list.innerHTML = `<div class="empty-state">YouTube isn't connected yet.<br>Add <code>YOUTUBE_API_KEY</code> to <code>.env</code> (Google Cloud → enable “YouTube Data API v3” → API key), then restart Jarvis.</div>`;
    } else {
      document.getElementById('yt-title').textContent = '—';
      list.innerHTML = '<div class="empty-state">Could not load channel data: ' + escapeHtml(e.message) + '</div>';
    }
  }
}
document.getElementById('yt-refresh-btn')?.addEventListener('click', loadYouTube);

async function loadEmber() {
  try {
    const { brands, blocked } = await api('/api/ember');
    // Populate both brand selectors.
    const opts = brands.map(b => `<option value="${b.id}">${escapeHtml(b.label)}</option>`).join('');
    ['ember-voice-brand', 'ember-tag-brand'].forEach(id => {
      const sel = document.getElementById(id);
      if (sel) sel.innerHTML = opts;
    });
    // Function status: live ones + the access-blocked ones.
    const live = [
      ['F0', 'Voice-alignment guardrail — live'],
      ['F1', 'Publication targeting — via brief'],
      ['F5', 'Tagline / messaging — live'],
      ['Brief', 'Monthly Brand Brief — live'],
    ];
    const blockedRows = Object.entries(blocked).map(([id, why]) =>
      `<div class="efn efn-blocked"><span class="efn-id">${id}</span><span>${escapeHtml(why)}</span></div>`);
    const liveRows = live.map(([id, why]) =>
      `<div class="efn efn-live"><span class="efn-id">${id}</span><span>${escapeHtml(why)}</span></div>`);
    document.getElementById('ember-functions').innerHTML = liveRows.join('') + blockedRows.join('');
  } catch (e) {
    document.getElementById('ember-functions').innerHTML = '<div class="empty-state">Could not load Ember: ' + escapeHtml(e.message) + '</div>';
  }

  // Wire actions (onclick = avoids stacking listeners on repeat tab opens).
  const briefBtn = document.getElementById('ember-brief-btn');
  briefBtn.onclick = async () => {
    briefBtn.disabled = true; briefBtn.textContent = 'Drafting…';
    try {
      const r = await api('/api/ember/brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ focus: '' }) });
      alert(`Brand Brief drafted (task #${r.taskId}). Review it in Approvals.`);
    } catch (e) { alert('Could not draft brief: ' + e.message); }
    briefBtn.disabled = false; briefBtn.textContent = '📋 Generate Monthly Brand Brief';
  };

  const vBtn = document.getElementById('ember-voice-btn');
  vBtn.onclick = async () => {
    const brand = document.getElementById('ember-voice-brand').value;
    const text = document.getElementById('ember-voice-text').value.trim();
    const out = document.getElementById('ember-voice-out');
    if (!text) { out.textContent = 'Paste some copy first.'; return; }
    vBtn.disabled = true; out.textContent = 'Checking…';
    try {
      const r = await api('/api/ember/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand, text }) });
      out.textContent = r.verdict;
    } catch (e) { out.textContent = 'Error: ' + e.message; }
    vBtn.disabled = false;
  };

  const tBtn = document.getElementById('ember-tag-btn');
  tBtn.onclick = async () => {
    const brand = document.getElementById('ember-tag-brand').value;
    const context = document.getElementById('ember-tag-ctx').value.trim();
    const out = document.getElementById('ember-tag-out');
    tBtn.disabled = true; out.textContent = 'Drafting…';
    try {
      const r = await api('/api/ember/tagline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand, context }) });
      out.textContent = r.text;
    } catch (e) { out.textContent = 'Error: ' + e.message; }
    tBtn.disabled = false;
  };
}


/* ---------- Knowledge tab ---------- */
async function loadKnowledge() {
  const list = document.getElementById('knowledge-list');
  try {
    const data = await api('/api/knowledge');
    document.getElementById('k-total').textContent = data.total;
    document.getElementById('k-t1').textContent = data.counts['1'] || 0;
    document.getElementById('k-t2').textContent = data.counts['2'] || 0;
    document.getElementById('k-t3').textContent = data.counts['3'] || 0;

    // Group docs by top-level vault folder
    const groups = {};
    for (const d of data.docs) {
      const top = d.source.includes('/') ? d.source.split('/')[0] : 'Root';
      (groups[top] = groups[top] || []).push(d);
    }
    list.innerHTML = Object.entries(groups).map(([g, docs]) => `
      <div class="knowledge-group">
        <h3>${escapeHtml(g)}</h3>
        ${docs.map(d => {
          const name = d.source.split('/').pop();
          const readable = /\.(md|markdown|txt)$/i.test(name);
          return `<div class="k-row" ${readable ? `data-read="${escapeHtml(d.source)}" style="cursor:pointer"` : ''}>
            <span class="k-icon">${readable ? '📖' : '📄'}</span>
            <span class="k-name">${escapeHtml(name)}</span>
            <span class="k-size">${humanSize(d.size)}</span>
            <span class="tier-badge tier-${d.level}">${escapeHtml(d.tierLabel)}</span>
          </div>`;
        }).join('')}
      </div>`).join('');
    list.querySelectorAll('.k-row[data-read]').forEach(row => {
      row.onclick = () => openReader('Vault', row.dataset.read);
    });
  } catch (e) {
    list.innerHTML = '<div class="empty-state">Could not load knowledge index</div>';
  }
}

/* ---------- Voice (British male, via Web Speech API) ---------- */
let britishVoice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  // Prefer named UK male voices, then any en-GB, then any English.
  britishVoice =
    voices.find(v => /Daniel|Arthur|George|Oliver|UK English Male|Google UK English Male/i.test(v.name)) ||
    voices.find(v => /en[-_]GB/i.test(v.lang) && /male/i.test(v.name)) ||
    voices.find(v => /en[-_]GB/i.test(v.lang)) ||
    voices.find(v => /^en/i.test(v.lang)) ||
    voices[0] || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

/* ---------- Speaking animation + voice ---------- */
let speakTimer = null;
function startSpeaking() {
  document.body.classList.add('speaking');
  const s = document.getElementById('assistant-status');
  if (s) s.textContent = 'speaking…';
}
function stopSpeaking() {
  document.body.classList.remove('speaking');
  const s = document.getElementById('assistant-status');
  if (s) s.textContent = 'Online · listening';
}

// Speak the text aloud in a British male voice, syncing the mouth animation
// to the actual speech. Falls back to a timed animation if TTS is unavailable.
function speakFor(text) {
  if (!text) return;
  if ('speechSynthesis' in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (britishVoice) u.voice = britishVoice;
    u.lang = 'en-GB';
    u.rate = 0.98;
    u.pitch = 0.9;
    u.onstart = startSpeaking;
    u.onend = stopSpeaking;
    u.onerror = stopSpeaking;
    speechSynthesis.speak(u);
  } else {
    // Fallback: animate proportional to length.
    startSpeaking();
    clearTimeout(speakTimer);
    const ms = Math.min(8000, Math.max(1800, text.length * 45));
    speakTimer = setTimeout(stopSpeaking, ms);
  }
}

/* ---------- Chat ---------- */
const chatWindow = document.getElementById('chat-window');
const chatForm = document.getElementById('chat-form');
const chatText = document.getElementById('chat-text');

function addMsg(text, who) {
  const wrap = document.createElement('div');
  const isBot = who === 'assistant' || who === 'bot';
  wrap.className = `chat-msg ${isBot ? 'bot' : who}`;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  // Assistant replies render as markdown (renderMarkdown escapes HTML first);
  // the owner's own messages stay literal text.
  if (isBot) bubble.innerHTML = renderMarkdown(text || '');
  else bubble.textContent = text;
  wrap.appendChild(bubble);
  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return bubble;
}

// Restore the saved conversation so a refresh doesn't lose it.
async function loadChatHistory() {
  try {
    const msgs = await api('/api/chat/history');
    if (!msgs.length) return;
    chatWindow.innerHTML = ''; // replace the default greeting with real history
    for (const m of msgs) {
      const bubble = addMsg(m.content, m.role === 'assistant' ? 'bot' : 'user');
      const src = Array.isArray(m.sources) ? m.sources : [];
      if (m.role === 'assistant' && src.length) {
        const s = document.createElement('div');
        s.className = 'chat-sources';
        s.textContent = '📚 ' + src.join(' · ');
        bubble.appendChild(s);
      }
    }
    chatWindow.scrollTop = chatWindow.scrollHeight;
  } catch (e) { console.error('history load failed', e); }
}

document.getElementById('chat-clear')?.addEventListener('click', async () => {
  if (!confirm('Clear the saved conversation? This cannot be undone.')) return;
  try {
    await api('/api/chat/clear', { method: 'POST' });
    chatWindow.innerHTML = '<div class="chat-msg bot"><div class="chat-bubble">Conversation cleared. Ask me anything.</div></div>';
  } catch (e) { alert('Could not clear: ' + e.message); }
});

// Pending image attachment for the next chat message.
let pendingFiles = []; // Array of files: { dataBase64, mediaType, dataUrl, name, type }

chatForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = chatText.value.trim();
  if (!msg && !pendingFiles.length) return;
  chatText.value = '';

  // Render user message + file previews (max 5).
  const userBubble = addMsg(msg || `(${pendingFiles.length} file${pendingFiles.length !== 1 ? 's' : ''})`, 'user');
  const docNames = [];
  pendingFiles.forEach(f => {
    if (f.type === 'image') {
      const im = document.createElement('img');
      im.src = f.dataUrl;
      userBubble.appendChild(im);
    } else {
      docNames.push(f.name);
    }
  });

  // If there are documents, upload them FIRST, then send the message
  let uploadedDocs = [];
  let docTexts = []; // extracted text Ebert can actually read
  if (docNames.length) {
    const s = docNames.length !== 1 ? 's' : '';
    addMsg(`Uploading ${docNames.length} file${s}: ${docNames.join(', ')}`, 'user');
    for (const f of pendingFiles.filter(pf => pf.type === 'doc')) {
      try {
        const res = await api('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: f.name, dataBase64: f.dataBase64 }),
        });
        if (res.success) {
          uploadedDocs.push(f.name);
          if (res.text) {
            docTexts.push(`--- FILE: ${f.name} ---\n${res.text}`);
            addMsg(`✅ ${f.name} — read ${res.text.length.toLocaleString()} characters`, 'bot');
          } else if (res.extractError) {
            addMsg(`✅ ${f.name} saved, but couldn't read text: ${res.extractError}`, 'bot');
          } else {
            addMsg(`✅ ${f.name} saved to vault`, 'bot');
          }
        } else if (res.held) {
          addMsg(`⚠️ ${f.name} held for review (safety gate)`, 'bot');
        } else {
          addMsg(`✗ ${f.name}: ${res.error || 'upload failed'}`, 'bot');
        }
      } catch (err) {
        addMsg(`✗ ${f.name}: ${err.message}`, 'bot');
        console.error('[upload]', f.name, err);
      }
    }
  }

  const body = { message: msg };
  if (docTexts.length) {
    // Give Ebert the actual document content so he can read and discuss it.
    body.message = (msg ? msg + '\n\n' : 'Here are the documents I uploaded:\n\n') +
      docTexts.join('\n\n') +
      `\n\n(The full files are saved in my vault under Uploads.)`;
  } else if (uploadedDocs.length) {
    body.message = (msg ? msg + '\n\n' : '') + `[Uploaded to vault: ${uploadedDocs.join(', ')}]`;
  }
  if (pendingFiles.length) {
    body.images = pendingFiles.filter(f => f.type === 'image').map(f => ({ dataBase64: f.dataBase64, mediaType: f.mediaType }));
  }
  const sentFiles = [...pendingFiles];
  clearAttachment();

  const typing = addMsg('Ebert is thinking…', 'bot');
  typing.classList.add('typing');

  try {
    const res = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    typing.classList.remove('typing');
    typing.innerHTML = renderMarkdown(res.reply || '');
    if (res.sources && res.sources.length) {
      const src = document.createElement('div');
      src.className = 'chat-sources';
      src.textContent = '📚 ' + res.sources.join(' · ');
      typing.appendChild(src);
    }
    // Show any actions Ebert took (tool calls) so they're visible + verifiable.
    if (res.actions && res.actions.length) {
      const act = document.createElement('div');
      act.className = 'chat-sources';
      act.textContent = '⚙️ ' + res.actions.map(a => `${a.ok ? '✓' : '✗'} ${a.tool.replace(/_/g, ' ')}`).join(' · ');
      typing.appendChild(act);
    }
    speakFor(res.reply);
  } catch (err) {
    typing.classList.remove('typing');
    typing.textContent = 'Sorry — I couldn\'t reach my brain. ' + err.message;
    stopSpeaking();
  }
  chatWindow.scrollTop = chatWindow.scrollHeight;
});

/* ---------- Emoji picker ---------- */
const EMOJIS = ['😀','😄','😁','😊','😍','😎','🤔','😅','😂','🙃','😉','😌','🤩','🥳','😴','🤖','👍','👏','🙌','🙏','💪','🔥','✨','⭐','🎉','✅','❌','⚡','💡','📈','📉','💰','💵','🚀','🎯','📌','📎','📁','🗂️','📝','📅','⏰','❤️','💙','💚','🧠','👀','🤝','💬','🎬','🍌'];
const emojiBtn = document.getElementById('emoji-btn');
const emojiPanel = document.getElementById('emoji-panel');
if (emojiPanel) emojiPanel.innerHTML = EMOJIS.map(e => `<button type="button">${e}</button>`).join('');
emojiBtn?.addEventListener('click', () => { emojiPanel.hidden = !emojiPanel.hidden; });
emojiPanel?.addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON') {
    chatText.value += e.target.textContent;
    chatText.focus();
  }
});

/* ---------- Attach image/file to chat ---------- */
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const attachPreview = document.getElementById('attach-preview');

fileInput.setAttribute('multiple', 'multiple');
fileInput.setAttribute('accept', 'image/*,.pdf,.doc,.docx,.txt,.md');

attachBtn?.addEventListener('click', () => fileInput.click());
fileInput?.addEventListener('change', async () => {
  const files = Array.from(fileInput.files).slice(0, 5); // Max 5 files
  if (!files.length) return;

  pendingFiles = [];
  const previews = [];

  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    const base64 = dataUrl.split(',')[1];
    const isImage = file.type.startsWith('image/');

    pendingFiles.push({
      dataUrl: isImage ? dataUrl : null,
      dataBase64: base64,
      mediaType: file.type,
      name: file.name,
      type: isImage ? 'image' : 'doc',
    });

    // Upload non-image files to Vault immediately
    if (!isImage) {
      (async () => {
        addMsg(`Uploading ${file.name}…`, 'user');
        try {
          const res = await api('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: file.name, dataBase64: base64 }),
          });
          if (res.success) {
            addMsg(`✅ Saved: ${res.file.name}`, 'bot');
          } else if (res.held) {
            addMsg(`⚠️ ${res.file.name} quarantined for review (flagged)`, 'bot');
          } else {
            addMsg(`✗ Upload failed: ${res.error || 'unknown error'}`, 'bot');
          }
        } catch (err) {
          addMsg(`✗ Upload error: ${err.message}`, 'bot');
          console.error('[upload]', file.name, err);
        }
      })();
    }

    if (isImage) {
      previews.push(`<img src="${dataUrl}" style="max-width:80px;height:auto;border-radius:4px;">`);
    } else {
      previews.push(`<span class="attach-doc" style="padding:4px 8px;background:var(--line);border-radius:4px;font-size:0.75rem;">${escapeHtml(file.name)}</span>`);
    }
  }

  attachPreview.hidden = false;
  attachPreview.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">${previews.join('')}<button type="button" class="attach-x" id="attach-x" style="margin-left:auto;">✕</button></div>`;
  document.getElementById('attach-x').onclick = clearAttachment;
  fileInput.value = '';
});

function clearAttachment() {
  pendingFiles = [];
  if (attachPreview) { attachPreview.hidden = true; attachPreview.innerHTML = ''; }
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + TOKEN, ...(opts.headers || {}) },
  });
  if (res.status === 401) { showLogin(); throw new Error('Session expired — please log in'); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ---------- Login ---------- */
function showLogin(msg) {
  let ov = document.getElementById('login-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'login-overlay';
    ov.className = 'login-overlay';
    ov.innerHTML = `
      <form class="login-card" id="login-form">
        <div class="login-logo">◈</div>
        <h2>Jarvis</h2>
        <p class="login-sub">Enter your dashboard password</p>
        <input type="password" id="login-pw" placeholder="Password" autocomplete="current-password">
        <button type="submit" class="btn btn-primary">Log in</button>
        <div class="login-error" id="login-error"></div>
      </form>`;
    document.body.appendChild(ov);
    document.getElementById('login-form').addEventListener('submit', doLogin);
  }
  ov.hidden = false;
  if (msg) document.getElementById('login-error').textContent = msg;
  setTimeout(() => document.getElementById('login-pw')?.focus(), 50);
}

async function doLogin(e) {
  e.preventDefault();
  const pw = document.getElementById('login-pw').value;
  try {
    const res = await fetch('/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (!res.ok) { document.getElementById('login-error').textContent = 'Invalid password'; return; }
    const { token } = await res.json();
    TOKEN = token;
    localStorage.setItem('jarvisToken', token);
    document.getElementById('login-overlay').hidden = true;
    boot();
  } catch (err) {
    document.getElementById('login-error').textContent = 'Login failed: ' + err.message;
  }
}

async function fetchTasks(status = null) {
  try {
    const q = status ? `?status=${status}` : '';
    return await api(`/api/tasks${q}`);
  } catch (e) { console.error(e); return []; }
}

/* ---------- Loaders ---------- */
async function loadOverview() {
  const [all, status] = await Promise.all([fetchTasks(), api('/api/status').catch(() => null)]);

  const byStatus = all.reduce((m, t) => (m[t.status] = (m[t.status] || 0) + 1, m), {});
  updateApprovalBadge(byStatus['awaiting_approval'] || 0);
  if (status) updateChrome(status);

  // Quick-access card subtitles
  const qt = document.getElementById('quick-tasks');
  const qa = document.getElementById('quick-approvals');
  if (qt) qt.textContent = `${all.length} total`;
  if (qa) qa.textContent = `${byStatus['awaiting_approval'] || 0} pending`;
  api('/api/knowledge').then(k => {
    const qk = document.getElementById('quick-knowledge');
    if (qk) qk.textContent = `${k.total} docs`;
  }).catch(() => {});

  renderDonut(byStatus, all.length);
  renderSpend7d();
  loadCommandCenter();
  loadProbes();

  const list = document.getElementById('overview-list');
  const recent = all.slice(0, 6);
  list.innerHTML = recent.length ? recent.map(t => renderTask(t)).join('') : '<div class="empty-state">No activity yet</div>';
}

const STATUS_COLORS = {
  pending: '#6366f1', in_progress: '#6366f1',
  planned: '#fbbf24', awaiting_approval: '#fbbf24',
  approved: '#34d399', done: '#34d399',
  failed: '#f87171', rejected: '#f87171',
};

// Donut chart of tasks by status (inline SVG, no deps).
function renderDonut(byStatus, total) {
  const el = document.getElementById('chart-donut');
  if (!el) return;
  const entries = Object.entries(byStatus);
  if (!entries.length) { el.innerHTML = '<div class="empty-state">No tasks yet</div>'; return; }
  const sum = entries.reduce((a, [, n]) => a + n, 0) || 1;
  const R = 52, C = 2 * Math.PI * R;
  let off = 0;
  const segs = entries.map(([s, n]) => {
    const len = (n / sum) * C;
    const color = STATUS_COLORS[s] || '#6366f1';
    const seg = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${color}" stroke-width="16" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)"></circle>`;
    off += len;
    return seg;
  }).join('');
  const legend = entries.map(([s, n]) =>
    `<div class="lg-row"><span class="lg-dot" style="background:${STATUS_COLORS[s] || '#6366f1'}"></span>${s.replace(/_/g, ' ')} <b>${n}</b></div>`
  ).join('');
  el.innerHTML = `<div class="donut"><svg viewBox="0 0 140 140" width="132" height="132">${segs}<text x="70" y="68" text-anchor="middle" class="donut-num">${total}</text><text x="70" y="86" text-anchor="middle" class="donut-lbl">tasks</text></svg><div class="donut-legend">${legend}</div></div>`;
}

// 7-day API-spend mini bar chart.
async function renderSpend7d() {
  const el = document.getElementById('spend-7d');
  if (!el) return;
  try {
    const rows = await api('/api/usage/daily');
    if (!rows.length) { el.innerHTML = '<div class="empty-state">No spend recorded yet</div>'; return; }
    const max = Math.max(...rows.map(r => r.cost), 0.0001);
    el.innerHTML = '<div class="spark">' + rows.map(r => {
      const h = Math.max(4, Math.round((r.cost / max) * 92));
      return `<div class="spark-col"><div class="spark-bar" style="height:${h}px" title="$${r.cost.toFixed(4)}"></div><span class="spark-x">${r.day}</span></div>`;
    }).join('') + '</div>';
  } catch (e) { el.innerHTML = '<div class="empty-state">Could not load spend</div>'; }
}

function renderStatusChart(byStatus, elId = 'chart-status') {
  const el = document.getElementById(elId);
  const entries = Object.entries(byStatus);
  if (!entries.length) { el.innerHTML = '<div class="empty-state">No data yet</div>'; return; }
  const max = Math.max(...entries.map(([, n]) => n));
  el.innerHTML = entries.map(([status, n]) => {
    const pct = Math.round((n / max) * 100);
    const color = STATUS_COLORS[status] || '#6366f1';
    return `
      <div class="bar-row">
        <span class="bar-name">${status.replace(/_/g, ' ')}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:linear-gradient(90deg, ${color}, ${color}aa)"></div></div>
        <span class="bar-count">${n}</span>
      </div>`;
  }).join('');
}

async function loadTasks() {
  const filter = document.getElementById('status-filter').value;
  const tasks = await fetchTasks(filter || null);
  const list = document.getElementById('tasks-list');
  list.innerHTML = tasks.length ? tasks.map(t => renderTask(t)).join('') : '<div class="empty-state">No tasks</div>';
}

async function loadApprovals() {
  const tasks = await fetchTasks('awaiting_approval');
  updateApprovalBadge(tasks.length);
  const list = document.getElementById('approvals-list');
  list.innerHTML = tasks.length
    ? tasks.map(t => renderTask(t, true)).join('')
    : '<div class="empty-state">All clear — nothing to approve ✓</div>';
}

async function loadStatus() {
  try {
    const s = await api('/api/status');
    updateChrome(s);
    document.getElementById('m-cap').textContent = `$${s.capUsd.toFixed(2)}`;
    document.getElementById('m-spent').textContent = `$${s.spentTodayUsd.toFixed(4)}`;
    document.getElementById('m-remaining').textContent = `$${s.remainingUsd.toFixed(4)}`;
    document.getElementById('m-kill').textContent = s.killSwitchActive ? '🔴 ACTIVE' : '🟢 OFF';

    const pct = Math.min(100, (s.spentTodayUsd / s.capUsd) * 100);
    document.getElementById('budget-fill').style.width = pct + '%';
    document.getElementById('budget-caption').textContent =
      `$${s.spentTodayUsd.toFixed(4)} of $${s.capUsd.toFixed(2)} used (${pct.toFixed(1)}%)`;
    renderKillState(s.killSwitchActive);
    loadBackups();
  } catch (e) {
    document.getElementById('m-cap').textContent = 'error';
  }
}

/* ---------- Probe health (Status tab) ---------- */
function setProbePill(id, status, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `probe-pill probe-${status}`;
  el.textContent = label;
}
async function loadProbes() {
  try {
    const s = await api('/api/probes');
    const ts = document.getElementById('probe-timestamp');
    if (ts) ts.textContent = `Last checked: ${new Date().toLocaleTimeString()}`;

    setProbePill('probe-engine', 'ok', '✓ Engine');
    setProbePill('probe-db', s.dbConnected ? 'ok' : 'fail', s.dbConnected ? '✓ Database' : '✗ Database');
    const pct = s.capUsd ? (s.spentTodayUsd / s.capUsd) * 100 : 0;
    if (s.spentTodayUsd === null) setProbePill('probe-budget', 'unknown', '? Budget');
    else if (pct >= 90)           setProbePill('probe-budget', 'fail',    `⚠ Budget ${pct.toFixed(0)}%`);
    else if (pct >= 70)           setProbePill('probe-budget', 'warn',    `~ Budget ${pct.toFixed(0)}%`);
    else                          setProbePill('probe-budget', 'ok',      `✓ Budget ${pct.toFixed(0)}%`);
    if (s.killSwitchActive === null)  setProbePill('probe-killswitch', 'unknown', '? Kill Switch');
    else if (s.killSwitchActive)      setProbePill('probe-killswitch', 'fail',    '🔴 Kill Switch ON');
    else                              setProbePill('probe-killswitch', 'ok',      '✓ Kill Switch');
    const auth = s.security?.authConfigured;
    setProbePill('probe-auth', auth ? 'ok' : 'fail', auth ? '✓ Auth' : '✗ Auth OFF');
    const https = s.security?.https;
    setProbePill('probe-https', https ? 'ok' : 'warn', https ? '✓ HTTPS' : '~ No HTTPS');
  } catch (e) {
    ['probe-engine','probe-db','probe-budget','probe-killswitch','probe-auth','probe-https']
      .forEach(id => setProbePill(id, 'unknown', '? Probe failed'));
  }
}

/* ---------- Backups (Status tab) ---------- */
async function loadBackups() {
  const el = document.getElementById('backup-state');
  if (!el) return;
  try {
    const { backups } = await api('/api/backups');
    el.textContent = backups.length ? `${backups.length} backups · latest ${backups[0].file.replace('db-', '').replace('.sql', '')}` : 'No backups yet';
  } catch { el.textContent = '—'; }
}
document.getElementById('backup-now')?.addEventListener('click', async () => {
  const btn = document.getElementById('backup-now');
  btn.disabled = true; btn.textContent = 'Backing up…';
  try {
    const r = await api('/api/backup', { method: 'POST' });
    alert(`Backup complete: ${r.db.file} (${Math.round(r.db.bytes/1024)} KB) + vault snapshot`);
    loadBackups();
  } catch (e) { alert('Backup failed: ' + e.message); }
  btn.disabled = false; btn.textContent = 'Back up now';
});

/* ---------- Kill switch toggle (Ep 18) ---------- */
function renderKillState(active) {
  const st = document.getElementById('kill-state');
  const btn = document.getElementById('kill-toggle');
  if (!st || !btn) return;
  st.textContent = active ? '🔴 ACTIVE — LLM calls halted' : '🟢 OFF — system running';
  st.className = 'kill-state ' + (active ? 'on' : 'off');
  btn.textContent = active ? 'Turn OFF (resume)' : 'Turn ON (halt)';
  btn.classList.toggle('is-armed', active);
  btn.dataset.active = active ? '1' : '0';
}
document.getElementById('kill-toggle')?.addEventListener('click', async () => {
  const willActivate = document.getElementById('kill-toggle').dataset.active !== '1';
  if (willActivate && !confirm('Halt ALL LLM activity now?')) return;
  try {
    const s = await api('/api/killswitch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: willActivate }),
    });
    renderKillState(s.killSwitchActive);
    updateChrome(s);
  } catch (e) { alert('Could not toggle: ' + e.message); }
});

/* ---------- Markdown reader (Ep 17) ---------- */
function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Strip YAML frontmatter for display
  md = md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const lines = md.split(/\r?\n/);
  let html = '', inCode = false, inList = false;
  for (let line of lines) {
    if (/^```/.test(line)) {
      if (inCode) { html += '</pre>'; inCode = false; }
      else { if (inList) { html += '</ul>'; inList = false; } html += '<pre>'; inCode = true; }
      continue;
    }
    if (inCode) { html += esc(line) + '\n'; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + inline(esc(line.replace(/^\s*[-*]\s+/, ''))) + '</li>';
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (/^###\s+/.test(line)) html += '<h3>' + inline(esc(line.replace(/^###\s+/, ''))) + '</h3>';
    else if (/^##\s+/.test(line)) html += '<h2>' + inline(esc(line.replace(/^##\s+/, ''))) + '</h2>';
    else if (/^#\s+/.test(line)) html += '<h1>' + inline(esc(line.replace(/^#\s+/, ''))) + '</h1>';
    else if (/^\s*---\s*$/.test(line)) html += '<hr>';
    else if (line.trim() === '') html += '';
    else html += '<p>' + inline(esc(line)) + '</p>';
  }
  if (inList) html += '</ul>';
  if (inCode) html += '</pre>';
  return html;
  function inline(s) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
}

async function openReader(root, relPath) {
  const overlay = document.getElementById('reader-overlay');
  const title = document.getElementById('reader-title');
  const body = document.getElementById('reader-body');
  title.textContent = relPath;
  body.innerHTML = '<div class="loading">Loading…</div>';
  overlay.hidden = false;
  try {
    const res = await api(`/api/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}`);
    body.innerHTML = renderMarkdown(res.content);
  } catch (e) {
    body.innerHTML = '<p>Could not open this file: ' + escapeHtml(e.message) + '</p>';
  }
}
document.getElementById('reader-close')?.addEventListener('click', () => { document.getElementById('reader-overlay').hidden = true; });
document.getElementById('reader-overlay')?.addEventListener('click', (e) => { if (e.target.id === 'reader-overlay') e.target.hidden = true; });

/* ---------- Shared chrome ---------- */
function updateChrome(s) {
  document.getElementById('topbar-spend').textContent = `$${s.spentTodayUsd.toFixed(2)}`;
  const pill = document.getElementById('kill-pill');
  const txt = document.getElementById('kill-text');
  if (s.killSwitchActive) {
    pill.classList.add('armed');
    txt.textContent = 'Kill switch ON';
  } else {
    pill.classList.remove('armed');
    txt.textContent = 'System OK';
  }
}

function updateApprovalBadge(n) {
  const badge = document.getElementById('approval-badge');
  if (n > 0) { badge.hidden = false; badge.textContent = n; }
  else { badge.hidden = true; }
}

/* ---------- Render ---------- */
function renderTask(task, showActions = false) {
  const cls = `status-${task.status}`;
  const date = new Date(task.created_at).toLocaleString();
  const actions = showActions && task.status === 'awaiting_approval' ? `
    <div class="task-actions">
      <button class="btn btn-approve" onclick="approveTask(${task.id})">✓ Approve</button>
      <button class="btn btn-reject" onclick="rejectTask(${task.id})">✕ Reject</button>
    </div>` : '';
  return `
    <div class="task-card">
      <div class="task-header">
        <div>
          <div class="task-id">TASK #${task.id}</div>
          <div class="task-title">${escapeHtml(task.title)}</div>
        </div>
        <span class="task-status ${cls}">${task.status.replace(/_/g, ' ')}</span>
      </div>
      ${task.description ? `<div class="task-description">${escapeHtml(task.description)}</div>` : ''}
      <div class="task-meta">📅 ${date}</div>
      ${actions}
    </div>`;
}

/* ---------- Actions ---------- */
async function approveTask(id) {
  if (!confirm(`Approve task #${id}?`)) return;
  try {
    await api(`/api/tasks/${id}/approve`, { method: 'POST' });
    speakFor(`Task ${id} approved.`);
    loadApprovals(); loadOverview();
  } catch (e) { alert('Error: ' + e.message); }
}
async function rejectTask(id) {
  if (!confirm(`Reject task #${id}?`)) return;
  try {
    await api(`/api/tasks/${id}/reject`, { method: 'POST' });
    speakFor(`Task ${id} rejected.`);
    loadApprovals(); loadOverview();
  } catch (e) { alert('Error: ' + e.message); }
}

/* ---------- Utils ---------- */
function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

document.getElementById('status-filter')?.addEventListener('change', loadTasks);

/* ---------- Files browser ---------- */
let filesRoot = null;
let filesPath = '';
let rootsLoaded = false;

async function loadFiles() {
  const rootSelect = document.getElementById('root-select');
  if (!rootsLoaded) {
    try {
      const roots = await api('/api/roots');
      rootSelect.innerHTML = roots.map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}${r.exists ? '' : ' (missing)'}</option>`).join('');
      rootsLoaded = true;
      filesRoot = roots[0]?.name || 'Vault';
      rootSelect.value = filesRoot;
      rootSelect.onchange = () => { filesRoot = rootSelect.value; filesPath = ''; renderFiles(); };
    } catch (e) {
      document.getElementById('files-list').innerHTML = '<div class="empty-state">Could not load folders</div>';
      return;
    }
  }
  renderFiles();
}

async function renderFiles() {
  const list = document.getElementById('files-list');
  const crumb = document.getElementById('breadcrumb');
  list.innerHTML = '<div class="loading">Loading…</div>';

  // Breadcrumb
  const parts = filesPath ? filesPath.split('/').filter(Boolean) : [];
  let acc = '';
  let crumbHtml = `<a data-path="">${escapeHtml(filesRoot)}</a>`;
  parts.forEach(p => { acc += (acc ? '/' : '') + p; crumbHtml += ` <span class="sep">/</span> <a data-path="${escapeHtml(acc)}">${escapeHtml(p)}</a>`; });
  crumb.innerHTML = crumbHtml;
  crumb.querySelectorAll('a').forEach(a => a.onclick = () => { filesPath = a.dataset.path; renderFiles(); });

  try {
    const entries = await api(`/api/files?root=${encodeURIComponent(filesRoot)}&path=${encodeURIComponent(filesPath)}`);
    if (!entries.length) { list.innerHTML = '<div class="empty-state">Empty folder</div>'; return; }
    list.innerHTML = entries.map(en => {
      const icon = en.type === 'dir' ? '📁' : fileIcon(en.name);
      const size = en.type === 'dir' ? '' : humanSize(en.size);
      return `<div class="file-row" data-type="${en.type}" data-name="${escapeHtml(en.name)}">
        <span class="f-icon">${icon}</span><span class="f-name">${escapeHtml(en.name)}</span><span class="f-size">${size}</span></div>`;
    }).join('');
    list.querySelectorAll('.file-row').forEach(row => {
      row.onclick = () => {
        const name = row.dataset.name;
        const next = filesPath ? filesPath + '/' + name : name;
        if (row.dataset.type === 'dir') { filesPath = next; renderFiles(); }
        else if (/\.(md|markdown|txt)$/i.test(name)) openReader(filesRoot, next);
        else downloadFile(next);
      };
    });
  } catch (e) {
    list.innerHTML = '<div class="empty-state">Could not list folder</div>';
  }
}

async function downloadFile(relPath) {
  try {
    const res = await fetch(`/api/download?root=${encodeURIComponent(filesRoot)}&path=${encodeURIComponent(relPath)}`, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = relPath.split('/').pop();
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { alert('Download failed: ' + e.message); }
}

// Upload button in the Files tab
document.getElementById('files-upload-btn')?.addEventListener('click', () => document.getElementById('files-upload-input').click());
document.getElementById('files-upload-input')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await fileToDataUrl(file);
    await api('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: filesRoot, path: filesPath || 'Uploads', filename: file.name, dataBase64: dataUrl.split(',')[1] }),
    });
    renderFiles();
  } catch (err) { alert('Upload failed: ' + err.message); }
  e.target.value = '';
});

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['png','jpg','jpeg','gif','webp','svg'].includes(ext)) return '🖼️';
  if (['md','txt','doc','docx','pdf'].includes(ext)) return '📄';
  if (['mp3','wav','m4a'].includes(ext)) return '🎵';
  if (['mp4','mov','webm'].includes(ext)) return '🎬';
  if (['zip','tar','gz'].includes(ext)) return '🗜️';
  return '📄';
}
function humanSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
  return (n/1048576).toFixed(1) + ' MB';
}

/* ---------- Polling ---------- */
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (currentTab === 'overview') loadOverview();
    else if (currentTab === 'tasks') loadTasks();
    else if (currentTab === 'approvals') loadApprovals();
    else if (currentTab === 'status') loadStatus();
    else loadOverview(); // keep badge/chrome fresh on assistant tab
  }, POLL_INTERVAL);
}

/* ---------- Init ---------- */
// Loads the app once authenticated. Any 401 inside api() re-shows login.
async function boot() {
  await loadChatHistory();     // restore the saved Assistant conversation
  switchTab('overview');
  startPolling();
}

window.addEventListener('load', async () => {
  // If we have a token, verify it with a cheap call; otherwise show login.
  if (TOKEN) {
    try {
      await api('/api/status');
      boot();
      return;
    } catch (e) { /* falls through to login */ }
  }
  showLogin();
});
window.addEventListener('beforeunload', () => pollTimer && clearInterval(pollTimer));

/* ---------- Slash-command autocomplete in the Assistant chat ---------- */
(function slashCommands() {
  const input = document.getElementById('chat-text');
  if (!input) return;
  let cmds = [];
  api('/api/commands').then(list => { cmds = list; }).catch(() => {});
  const box = document.createElement('div');
  box.className = 'slash-menu';
  box.hidden = true;
  input.parentNode.style.position = 'relative';
  input.parentNode.appendChild(box);
  let items = [], sel = -1;
  function close() { box.hidden = true; sel = -1; }
  function render(q) {
    items = cmds.filter(c => c.command.startsWith(q));
    if (!items.length) { close(); return; }
    sel = 0;
    box.innerHTML = items.map((c, i) =>
      `<div class="slash-item ${i === 0 ? 'sel' : ''}" data-i="${i}"><b>/${c.command}</b><span>${escapeHtml(c.description)}</span></div>`
    ).join('');
    box.hidden = false;
    box.querySelectorAll('.slash-item').forEach(el =>
      el.onmousedown = (e) => { e.preventDefault(); accept(+el.dataset.i); });
  }
  function accept(i) { input.value = '/' + items[i].command + ' '; close(); input.focus(); }
  function move(d) {
    sel = (sel + d + items.length) % items.length;
    box.querySelectorAll('.slash-item').forEach((el, i) => el.classList.toggle('sel', i === sel));
  }
  input.addEventListener('input', () => {
    const m = input.value.match(/^\/(\w*)$/);   // only at start, before a space
    if (m) render(m[1]); else close();
  });
  input.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); accept(sel); }
    else if (e.key === 'Escape') { close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
})();

/* ---------- Theme toggle (light / dark, persisted) ---------- */
(function theme() {
  function apply(t) {
    document.documentElement.dataset.theme = t;
    const b = document.getElementById('theme-btn');
    if (b) b.textContent = t === 'dark' ? '☀️' : '🌙';
  }
  apply(localStorage.getItem('jarvisTheme') || 'light');
  document.getElementById('theme-btn')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('jarvisTheme', next);
    apply(next);
  });
})();

/* ---------- Browser spell-check on text inputs/areas ---------- */
(function spellcheck() {
  document.querySelectorAll('textarea, input[type="text"], input:not([type])')
    .forEach(el => el.setAttribute('spellcheck', 'true'));
})();

/* ===================== Skills tab ===================== */
async function loadSkills() {
  const el = document.getElementById('skills-list');
  try {
    const list = await api('/api/skills');
    el.innerHTML = list.length ? list.map(s => `
      <div class="skill-row">
        <div class="skill-main">
          <div class="skill-name">${escapeHtml(s.name)} ${s.enabled ? '' : '<span class="muted-line">(disabled)</span>'}</div>
          <div class="skill-desc">${escapeHtml(s.description || '')}</div>
        </div>
        <label class="switch"><input type="checkbox" data-slug="${s.slug}" ${s.enabled ? 'checked' : ''}><span></span></label>
        <button class="rec-del" data-del="${s.slug}" title="Delete">✕</button>
      </div>`).join('') : '<div class="empty-state">No skills yet — create or upload one on the left.</div>';
    el.querySelectorAll('input[data-slug]').forEach(cb => cb.onchange = async () => {
      try { await api(`/api/skills/${cb.dataset.slug}/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: cb.checked }) }); }
      catch (e) { alert(e.message); cb.checked = !cb.checked; }
    });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this skill?')) return;
      try { await api(`/api/skills/${b.dataset.del}`, { method: 'DELETE' }); loadSkills(); } catch (e) { alert(e.message); }
    });
  } catch (e) { el.innerHTML = '<div class="empty-state">Could not load skills</div>'; }
  wireSkillForm();
}

function verdictLine(r) {
  const c = r.color || (r.verdict === 'clean' ? 'green' : r.verdict === 'toxic' ? 'red' : 'amber');
  const dot = c === 'green' ? '🟢' : c === 'red' ? '🔴' : '🟡';
  return r.held
    ? `${dot} ${r.verdict} — held for review${r.report && r.report.summary ? ' (' + r.report.summary + ')' : ''}. See Quarantine.`
    : `${dot} Installed (clean).`;
}

function wireSkillForm() {
  const pb = document.getElementById('skill-proofread');
  if (pb && !pb._wired) { pb._wired = true; pb.onclick = async () => {
    const ta = document.getElementById('skill-body'); const t = ta.value.trim(); if (!t) return;
    pb.disabled = true; const old = pb.textContent; pb.textContent = '…';
    try { const r = await api('/api/proofread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }) }); ta.value = r.text; }
    catch (e) { alert(e.message); }
    pb.disabled = false; pb.textContent = old;
  }; }
  const cb = document.getElementById('skill-create');
  if (cb && !cb._wired) { cb._wired = true; cb.onclick = async () => {
    const name = document.getElementById('skill-name').value.trim();
    const description = document.getElementById('skill-desc').value.trim();
    const body = document.getElementById('skill-body').value.trim();
    const out = document.getElementById('skill-create-out');
    if (!name || !body) { out.textContent = 'Name and instructions are required.'; return; }
    cb.disabled = true; out.textContent = 'Checking & installing…';
    try {
      const r = await api('/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description, body }) });
      out.textContent = verdictLine(r);
      if (!r.held) { document.getElementById('skill-name').value = ''; document.getElementById('skill-desc').value = ''; document.getElementById('skill-body').value = ''; }
      loadSkills(); updateQuarantineBadge();
    } catch (e) { out.textContent = 'Error: ' + e.message; }
    cb.disabled = false;
  }; }
  const fi = document.getElementById('skill-file');
  if (fi && !fi._wired) { fi._wired = true; fi.onchange = async () => {
    const f = fi.files[0]; if (!f) return;
    const out = document.getElementById('skill-upload-out'); out.textContent = 'Checking…';
    const reader = new FileReader();
    reader.onload = async () => {
      const dataBase64 = String(reader.result).split(',')[1];
      try { const r = await api('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: 'Vault', path: 'Skills', filename: f.name, dataBase64 }) }); out.textContent = verdictLine(r); loadSkills(); updateQuarantineBadge(); }
      catch (e) { out.textContent = 'Error: ' + e.message; }
      fi.value = '';
    };
    reader.readAsDataURL(f);
  }; }
  const rf = document.getElementById('skills-refresh');
  if (rf && !rf._wired) { rf._wired = true; rf.onclick = loadSkills; }
}

/* ===================== Quarantine tab ===================== */
async function loadQuarantine() {
  const el = document.getElementById('quarantine-list');
  try {
    const items = await api('/api/quarantine');
    el.innerHTML = items.length ? items.map(q => {
      const dot = q.color === 'red' ? '🔴' : q.color === 'amber' ? '🟡' : '🟢';
      const checks = (q.checks || []).filter(c => c.status !== 'pass').map(c => `${c.name}: ${escapeHtml(c.detail || '')}`).join('; ');
      return `<div class="q-item q-${q.color}">
        <div class="q-main">
          <div class="q-name">${dot} ${escapeHtml(q.filename)} <span class="chip chip-${q.color}">${q.verdict}</span></div>
          <div class="q-meta">${escapeHtml(checks || q.summary || '')}</div>
        </div>
        <div class="q-actions"><button class="btn btn-primary" data-approve="${q.id}">Approve</button><button class="btn btn-reject" data-reject="${q.id}">Reject</button></div>
      </div>`;
    }).join('') : '<div class="empty-state">Nothing held — all uploads have been clean ✅</div>';
    el.querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => {
      if (!confirm('Approve and ingest this file into the system?')) return;
      try { await api(`/api/tasks/${b.dataset.approve}/approve`, { method: 'POST' }); loadQuarantine(); updateQuarantineBadge(); } catch (e) { alert(e.message); }
    });
    el.querySelectorAll('[data-reject]').forEach(b => b.onclick = async () => {
      try { await api(`/api/tasks/${b.dataset.reject}/reject`, { method: 'POST' }); loadQuarantine(); updateQuarantineBadge(); } catch (e) { alert(e.message); }
    });
  } catch (e) { el.innerHTML = '<div class="empty-state">Could not load quarantine</div>'; }
}
document.getElementById('q-approve-amber')?.addEventListener('click', async () => {
  try { const r = await api('/api/quarantine/approve-all', { method: 'POST' }); alert(`Approved ${r.approved} flagged item(s). ${r.heldToxic} toxic still held.`); loadQuarantine(); updateQuarantineBadge(); }
  catch (e) { alert(e.message); }
});
async function updateQuarantineBadge() {
  try {
    const items = await api('/api/quarantine');
    const b = document.getElementById('quarantine-badge');
    if (b) { b.textContent = items.length; b.hidden = items.length === 0; }
  } catch (e) {}
}

/* ===================== Command-center right rail ===================== */
(function commandRail() {
  const rail = document.getElementById('cmd-rail');
  if (!rail) return;
  rail.querySelectorAll('.rail-tab').forEach(btn => btn.addEventListener('click', () => {
    const name = btn.dataset.rail;
    rail.querySelectorAll('.rail-tab').forEach(b => b.classList.toggle('active', b === btn));
    rail.querySelectorAll('.rail-pane').forEach(p => p.classList.toggle('active', p.id === 'rail-' + name));
    if (name === 'agents') loadRailAgents();
    if (name === 'preview') loadRailPreview();
  }));
  const form = document.getElementById('rail-chat-form');
  const input = document.getElementById('rail-chat-text');
  const win = document.getElementById('rail-chat-window');
  function addRailMsg(text, who) {
    const hint = win.querySelector('.rail-hint'); if (hint) hint.remove();
    const d = document.createElement('div'); d.className = 'rail-msg ' + who;
    if (who === 'bot') d.innerHTML = renderMarkdown(text); else d.textContent = text;
    win.appendChild(d); win.scrollTop = win.scrollHeight; return d;
  }
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim(); if (!text) return;
    addRailMsg(text, 'user'); input.value = '';
    const t = addRailMsg('…', 'bot');
    try { const r = await api('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) }); t.innerHTML = renderMarkdown(r.reply || ''); }
    catch (err) { t.textContent = 'Error: ' + err.message; }
    win.scrollTop = win.scrollHeight;
  });
})();

async function loadRailAgents() {
  const el = document.getElementById('rail-agents');
  if (!el) return;
  try {
    const s = await api('/api/subagents');
    const head = `<div class="rail-hint">Your agent team: ${(s.domains || []).map(d => `${d.emoji || ''} ${d.id}`).join(' · ')}.</div>`;
    const ev = (s.events || []).slice(0, 14);
    const rows = ev.length ? ev.map(e => {
      const p = e.payload || {};
      return `<div class="rail-agent-row"><div class="ra-kind">${escapeHtml((e.kind || '').replace('subagent_', ''))} — ${escapeHtml(p.domain || p.workerId || '')}</div><div class="ra-meta">${new Date(e.ts).toLocaleString()}</div></div>`;
    }).join('') : '<div class="empty-state">No sub-agent activity yet. Delegate one from the Missions tab.</div>';
    el.innerHTML = head + rows;
  } catch (e) { el.innerHTML = '<div class="empty-state">Could not load agent activity</div>'; }
}

let _previewInit = false;
async function loadRailPreview() {
  const sel = document.getElementById('rail-preview-select');
  if (!sel) return;
  if (!_previewInit) {
    _previewInit = true;
    try {
      const reports = await api('/api/files?root=Vault&path=Reports').catch(() => []);
      (reports || []).filter(f => f.type === 'file' && /\.md$/i.test(f.name)).reverse().forEach(f => {
        const o = document.createElement('option'); o.value = 'Reports/' + f.name; o.textContent = '📄 ' + f.name; sel.appendChild(o);
      });
    } catch (e) {}
    sel.onchange = () => sel.value ? renderPreviewFile('Vault', sel.value) : renderLatestPreview();
    document.getElementById('rail-preview-refresh').onclick = () => { _previewInit = false; sel.innerHTML = '<option value="">Latest report</option>'; loadRailPreview(); };
  }
  if (sel.value) renderPreviewFile('Vault', sel.value); else renderLatestPreview();
}
async function renderLatestPreview() {
  const body = document.getElementById('rail-preview-body'); if (!body) return;
  body.innerHTML = '<div class="loading">Loading…</div>';
  try { const r = await api('/api/reports/latest'); body.innerHTML = r.content ? renderMarkdown(r.content) : '<div class="empty-state">No report yet — they generate at 4am / 8pm.</div>'; }
  catch (e) { body.innerHTML = '<div class="empty-state">Could not load</div>'; }
}
async function renderPreviewFile(root, path) {
  const body = document.getElementById('rail-preview-body'); if (!body) return;
  body.innerHTML = '<div class="loading">Loading…</div>';
  try { const r = await api(`/api/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`); body.innerHTML = renderMarkdown(r.content || ''); }
  catch (e) { body.innerHTML = '<div class="empty-state">Could not load file</div>'; }
}
// Send any vault doc into the Preview pane and open it: window.setPreview(root, path)
function setPreview(root, path) {
  const shell = document.querySelector('.app-shell'); if (shell) shell.classList.add('rail-on');
  const rail = document.getElementById('cmd-rail'); if (!rail) return;
  rail.querySelectorAll('.rail-tab').forEach(b => b.classList.toggle('active', b.dataset.rail === 'preview'));
  rail.querySelectorAll('.rail-pane').forEach(p => p.classList.toggle('active', p.id === 'rail-preview'));
  loadRailPreview();
  const sel = document.getElementById('rail-preview-select');
  if (sel && root === 'Vault') {
    let opt = [...sel.options].find(o => o.value === path);
    if (!opt) { opt = document.createElement('option'); opt.value = path; opt.textContent = '📄 ' + path.split('/').pop(); sel.appendChild(opt); }
    sel.value = path;
  }
  renderPreviewFile(root, path);
}
window.setPreview = setPreview;

/* ---------- Command rail toggle (default on, persisted) ---------- */
(function railToggle() {
  const shell = document.querySelector('.app-shell');
  if (!shell) return;
  function apply(on) {
    shell.classList.toggle('rail-on', on);
    const b = document.getElementById('rail-btn');
    if (b) b.classList.toggle('active', on);
  }
  const saved = localStorage.getItem('jarvisRail');
  apply(saved === null ? true : saved === '1');   // default ON
  document.getElementById('rail-btn')?.addEventListener('click', () => {
    const on = !shell.classList.contains('rail-on');
    localStorage.setItem('jarvisRail', on ? '1' : '0');
    apply(on);
  });
  document.getElementById('rail-close')?.addEventListener('click', () => {
    localStorage.setItem('jarvisRail', '0');
    apply(false);
  });
})();

/* ===================== Sub-Agents tab ===================== */
let _currentAgent = null;
async function loadSubagentsTab() {
  const picker = document.getElementById('agent-picker');
  try {
    const s = await api('/api/subagents');
    picker.innerHTML = (s.domains || []).map(d =>
      `<button class="agent-card${_currentAgent === d.id ? ' active' : ''}" data-domain="${d.id}" data-label="${escapeHtml(d.label)}"><span class="agent-ic">${d.emoji || '🤖'}</span><span class="agent-label">${escapeHtml(d.label)}</span></button>`).join('');
    picker.querySelectorAll('.agent-card').forEach(b => b.onclick = () => selectAgent(b.dataset.domain, b.dataset.label));
  } catch (e) { picker.innerHTML = '<div class="empty-state">Could not load specialists</div>'; }
  if (_currentAgent) selectAgent(_currentAgent, document.getElementById('agent-chat-title').textContent);
}

async function selectAgent(domain, label) {
  _currentAgent = domain;
  document.querySelectorAll('.agent-card').forEach(b => b.classList.toggle('active', b.dataset.domain === domain));
  document.getElementById('agent-chat-panel').hidden = false;
  document.getElementById('agent-chat-title').textContent = label;
  const win = document.getElementById('agent-chat-window');
  win.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const hist = await api(`/api/subagents/${domain}/history`);
    win.innerHTML = hist.length ? '' : `<div class="rail-hint">No messages yet. Say hello to your ${escapeHtml(label)} specialist.</div>`;
    hist.forEach(m => appendAgentMsg(m.role, m.content));
  } catch (e) { win.innerHTML = '<div class="empty-state">Could not load conversation</div>'; }
}

function appendAgentMsg(role, content) {
  const win = document.getElementById('agent-chat-window');
  const hint = win.querySelector('.rail-hint'); if (hint) hint.remove();
  const d = document.createElement('div');
  d.className = 'agent-msg ' + role;
  const who = role === 'owner' ? 'You' : role === 'jarvis' ? 'Jarvis (orchestrator)' : 'Specialist';
  d.innerHTML = `<div class="agent-who">${who}</div><div class="agent-bubble">${role === 'owner' ? escapeHtml(content) : renderMarkdown(content)}</div>`;
  win.appendChild(d); win.scrollTop = win.scrollHeight;
  return d;
}

document.getElementById('agent-chat-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!_currentAgent) return;
  const input = document.getElementById('agent-chat-text');
  const text = input.value.trim(); if (!text) return;
  appendAgentMsg('owner', text); input.value = '';
  const t = appendAgentMsg('agent', '…');
  try { const r = await api(`/api/subagents/${_currentAgent}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) }); t.querySelector('.agent-bubble').innerHTML = renderMarkdown(r.reply || ''); }
  catch (err) { t.querySelector('.agent-bubble').textContent = 'Error: ' + err.message; }
});

document.getElementById('agent-collab')?.addEventListener('click', async () => {
  if (!_currentAgent) return;
  const t = appendAgentMsg('jarvis', '…');
  try { const r = await api(`/api/subagents/${_currentAgent}/collab`, { method: 'POST' }); t.querySelector('.agent-bubble').innerHTML = renderMarkdown(r.reply || ''); }
  catch (err) { t.querySelector('.agent-bubble').textContent = 'Error: ' + err.message; }
});

// ── GROWTH HUB ─────────────────────────────────────────────────────────────

