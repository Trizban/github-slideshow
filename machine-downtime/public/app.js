'use strict';

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d = '') { try { return localStorage.getItem('mcdt.' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mcdt.' + k, v); } catch { /* storage unavailable */ } },
};

let S = { machines: [], reasons: [], mechanics: [], settings: {}, open: [] };
let offset = 0; // server clock - local clock
const now = () => Date.now() + offset;

function fmtDur(ms) {
  if (ms === null || ms === undefined || ms < 0 || Number.isNaN(ms)) return '–';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}
const fmtMin = (ms) => (ms === null || Number.isNaN(ms) ? '–' : (ms / 60000).toFixed(1));
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

const STATUS = { waiting: 'Waiting for mechanic', in_repair: 'Under repair', awaiting_reason: 'Reason pending', closed: 'Closed', cancelled: 'Cancelled' };
const machineById = (id) => S.machines.find((m) => m.id === id) || { id, name: '', line: '' };
const downTicket = (mid) => S.open.find((t) => t.machineId === mid && (t.status === 'waiting' || t.status === 'in_repair'));

function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (err ? ' err' : '');
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
async function act(method, url, body, okMsg) {
  try {
    await api(method, url, body);
    if (okMsg) toast(okMsg);
    await refresh();
  } catch (e) { toast(e.message, true); }
}

// ---------- live timers ----------
// <span class="live" data-since="ms" data-kind="wait|repair|total">
function tick() {
  const st = S.settings;
  document.querySelectorAll('[data-since]').forEach((el) => {
    const since = Number(el.dataset.since);
    const until = el.dataset.until ? Number(el.dataset.until) : now();
    const ms = until - since;
    el.textContent = fmtDur(ms);
    const min = ms / 60000;
    const [w, a] = el.dataset.kind === 'repair' ? [st.repairWarnMin, st.repairAlarmMin] : [st.waitWarnMin, st.waitAlarmMin];
    el.classList.toggle('t-warn', min >= w && min < a);
    el.classList.toggle('t-bad', min >= a);
    const tile = el.closest('.tile');
    if (tile && el.dataset.kind === 'wait' && !el.dataset.until) tile.classList.toggle('alarm', min >= a);
  });
}
setInterval(tick, 1000);
const timer = (since, kind, until) => `<span class="live" data-since="${since}" data-kind="${kind}"${until ? ` data-until="${until}"` : ''}>${fmtDur((until || now()) - since)}</span>`;

// ---------- sound alert for new calls ----------
let knownWaiting = null;
function beep() {
  if (store.get('sound') !== '1') return;
  try {
    const ctx = beep.ctx || (beep.ctx = new AudioContext());
    [0, 0.35].forEach((t) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; g.gain.value = 0.2;
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.2);
    });
  } catch { /* audio unavailable */ }
}

// ---------- data / router ----------
let todayTickets = [];
async function refresh() {
  const t0 = Date.now();
  const st = await api('GET', '/api/state');
  offset = st.serverTime - Math.round((t0 + Date.now()) / 2);
  S = st;
  const waitingIds = new Set(S.open.filter((t) => t.status === 'waiting').map((t) => t.id));
  if (knownWaiting && [...waitingIds].some((id) => !knownWaiting.has(id))) beep();
  knownWaiting = waitingIds;
  if (route().name === 'dashboard') {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    todayTickets = await api('GET', '/api/tickets?from=' + d.toISOString());
  }
  render(true);
}

function route() {
  const [name, qs] = (location.hash.slice(1) || 'dashboard').split('?');
  return { name, params: new URLSearchParams(qs || '') };
}

let pendingRender = false;
function render(fromLive = false) {
  const r = route();
  const view = VIEWS[r.name] || VIEWS.dashboard;
  if (fromLive && !view.live) return;
  // Don't wipe out what someone is typing; render once they leave the field.
  const a = document.activeElement;
  if (fromLive && a && $('#view').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { pendingRender = true; return; }
  document.querySelectorAll('#nav a').forEach((el) => el.classList.toggle('active', el.getAttribute('href') === '#' + r.name));
  $('#view').innerHTML = view.html(r.params);
  view.bind?.(r.params);
  tick();
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (pendingRender && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) { pendingRender = false; render(true); }
}, 0));
window.addEventListener('hashchange', () => (route().name === 'dashboard' ? refresh() : render()));

// Delegated click handler: <button data-act="name" data-id="...">
const ACTIONS = {};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && ACTIONS[b.dataset.act]) { e.preventDefault(); ACTIONS[b.dataset.act](b.dataset, b); }
});

// ---------- views ----------
const VIEWS = {};

VIEWS.dashboard = {
  live: true,
  html() {
    const open = S.open;
    const waiting = open.filter((t) => t.status === 'waiting');
    const repair = open.filter((t) => t.status === 'in_repair');
    const done = todayTickets.filter((t) => t.status !== 'cancelled');
    const finished = done.filter((t) => t.finishAt);
    const downtime = sum(done.map((t) => (t.finishAt || now()) - t.callAt));
    const waits = done.filter((t) => t.arriveAt).map((t) => t.arriveAt - t.callAt);
    const repairs = finished.map((t) => t.finishAt - t.arriveAt);
    const lines = [...new Set(S.machines.map((m) => m.line))];
    const sound = store.get('sound') === '1';

    const tile = (m) => {
      const t = downTicket(m.id);
      const pending = S.open.find((x) => x.machineId === m.id && x.status === 'awaiting_reason');
      let body = '<div class="state" style="color:var(--ok)">Running</div>';
      if (t?.status === 'waiting') body = `<div class="state">Waiting for mechanic</div><div class="timer">${timer(t.callAt, 'wait')}</div>`;
      if (t?.status === 'in_repair') body = `<div class="state">Repair · ${esc(t.mechanic || 'mechanic')}</div><div class="timer">${timer(t.arriveAt, 'repair')}</div><div class="sub">waited ${fmtDur(t.arriveAt - t.callAt)}</div>`;
      if (!t && pending) body += `<div class="sub t-warn">Reason pending (#${pending.id})</div>`;
      return `<div class="tile ${t ? t.status : pending ? 'awaiting_reason' : ''}">
        <div class="id">${esc(m.id)}</div><div class="sub">${esc(m.name)}</div>${body}</div>`;
    };

    return `
      <div class="row"><div><h1>Floor dashboard</h1><div class="muted">Live machine status. Updates automatically.</div></div>
        <span class="spacer"></span>
        <button data-act="sound">${sound ? '🔔 Sound on' : '🔕 Sound off'}</button></div>
      <div class="kpis">
        <div class="card kpi ${waiting.length + repair.length ? 'bad' : ''}"><div class="label">Machines down now</div><div class="value">${waiting.length + repair.length}</div></div>
        <div class="card kpi ${waiting.length ? 'bad' : ''}"><div class="label">Waiting for mechanic</div><div class="value">${waiting.length}</div></div>
        <div class="card kpi"><div class="label">Under repair</div><div class="value">${repair.length}</div></div>
        <div class="card kpi"><div class="label">Calls today</div><div class="value">${done.length}</div></div>
        <div class="card kpi"><div class="label">Downtime today (min)</div><div class="value">${fmtMin(downtime)}</div></div>
        <div class="card kpi"><div class="label">Avg waiting today (min)</div><div class="value">${fmtMin(avg(waits))}</div></div>
        <div class="card kpi"><div class="label">Avg repair today (min)</div><div class="value">${fmtMin(avg(repairs))}</div></div>
      </div>
      ${lines.map((l) => `<h2>${esc(l || 'Machines')}</h2><div class="grid">${S.machines.filter((m) => m.line === l).map(tile).join('')}</div>`).join('')}
    `;
  },
};
ACTIONS.sound = () => {
  store.set('sound', store.get('sound') === '1' ? '0' : '1');
  if (store.get('sound') === '1') beep();
  render();
};

VIEWS.operator = {
  live: true,
  html(p) {
    const mid = p.get('m');
    if (!mid || !S.machines.some((m) => m.id === mid)) {
      return `<h1>Operator station</h1><p class="muted">Choose your machine. Bookmark the page or scan the machine's QR code to open it directly.</p>
        <div class="grid">${S.machines.map((m) => `<a class="btn tile ${downTicket(m.id)?.status || ''}" href="#operator?m=${encodeURIComponent(m.id)}">
          <div class="id">${esc(m.id)}</div><div class="sub">${esc(m.name)} · ${esc(m.line)}</div></a>`).join('')}</div>`;
    }
    const m = machineById(mid);
    const t = downTicket(mid);
    let body;
    if (!t) {
      body = `<p class="muted">Machine is running.</p>
        <button class="danger big" data-act="call" data-id="${esc(mid)}">🔴 MACHINE PROBLEM<br><small>Call mechanic</small></button>
        <p><label style="max-width:260px;margin:12px auto">Operator ID (optional)
          <input id="op" value="${esc(store.get('operator'))}" placeholder="e.g. OP-125"></label></p>`;
    } else if (t.status === 'waiting') {
      body = `<div class="badge waiting">Mechanic called</div><div class="timer">${timer(t.callAt, 'wait')}</div>
        <p class="muted">Waiting for mechanic since ${fmtTime(t.callAt)}</p>
        <button data-act="cancel" data-id="${t.id}">Pressed by mistake – cancel call</button>`;
    } else {
      body = `<div class="badge in_repair">Under repair · ${esc(t.mechanic || 'mechanic')}</div><div class="timer">${timer(t.arriveAt, 'repair')}</div>
        <p class="muted">Waited ${fmtDur(t.arriveAt - t.callAt)} for mechanic · total downtime ${timer(t.callAt, 'total')}</p>`;
    }
    return `<div class="station card"><div class="muted"><a href="#operator">← all machines</a></div>
      <h1>${esc(m.id)}</h1><div class="muted">${esc(m.name)} · ${esc(m.line)}</div><div style="margin-top:16px">${body}</div></div>`;
  },
};
ACTIONS.call = (d) => {
  const op = $('#op')?.value.trim() || '';
  store.set('operator', op);
  act('POST', `/api/machines/${encodeURIComponent(d.id)}/call`, { operator: op }, 'Mechanic called');
};
ACTIONS.cancel = (d) => { if (confirm('Cancel this call?')) act('POST', `/api/tickets/${d.id}/cancel`, {}, 'Call cancelled'); };

const draft = {}; // ticketId -> { reasonId, note } kept across live re-renders
VIEWS.mechanic = {
  live: true,
  html(p) {
    const mid = p.get('m');
    const me = store.get('mechanic');
    const list = S.open.filter((t) => !mid || t.machineId === mid).sort((a, b) => a.callAt - b.callAt);
    const by = (s) => list.filter((t) => t.status === s);
    const head = (t) => {
      const m = machineById(t.machineId);
      return `<div class="head"><strong style="font-size:18px">${esc(t.machineId)}</strong>
        <span class="muted">${esc(m.name)} · ${esc(m.line)}</span><span class="badge ${t.status}">${STATUS[t.status]}</span>
        <span class="spacer"></span><span class="muted">#${t.id}</span></div>`;
    };
    const waiting = by('waiting').map((t) => `<div class="card job">${head(t)}
      <div>Waiting <span class="timer">${timer(t.callAt, 'wait')}</span></div>
      <button class="primary" data-act="arrive" data-id="${t.id}">I'm at the machine – start repair</button></div>`);
    const repair = by('in_repair').map((t) => `<div class="card job">${head(t)}
      <div>Repair <span class="timer">${timer(t.arriveAt, 'repair')}</span> <span class="muted">· ${esc(t.mechanic || '')} · waited ${fmtDur(t.arriveAt - t.callAt)}</span></div>
      <button class="primary" data-act="finish" data-id="${t.id}">✅ Job done – machine running</button></div>`);
    const reason = by('awaiting_reason').map((t) => {
      const dr = draft[t.id] || (draft[t.id] = { reasonId: '', note: '' });
      return `<div class="card job">${head(t)}
        <div class="muted">Waited ${fmtDur(t.arriveAt - t.callAt)} · repair ${fmtDur(t.finishAt - t.arriveAt)} · total ${fmtDur(t.finishAt - t.callAt)}</div>
        <strong>What was the problem?</strong>
        <div class="reasons">${S.reasons.map((r) => `<button class="${dr.reasonId === r.id ? 'sel' : ''}" data-act="pick" data-id="${t.id}" data-reason="${r.id}">${esc(r.name)}</button>`).join('')}</div>
        <input data-note="${t.id}" value="${esc(dr.note)}" placeholder="Note / parts replaced (optional)">
        <button class="primary" data-act="reason" data-id="${t.id}" ${dr.reasonId ? '' : 'disabled'}>Save reason & close</button></div>`;
    });
    const section = (title, items) => (items.length ? `<h2>${title} (${items.length})</h2><div class="jobs">${items.join('')}</div>` : '');
    return `<div class="row"><div><h1>Mechanic${mid ? ' · ' + esc(mid) : ''}</h1>
        <div class="muted">${mid ? '<a href="#mechanic">Show all machines</a>' : 'All open calls, oldest first.'}</div></div>
        <span class="spacer"></span>
        <label>Mechanic<select id="me"><option value="">– select your name –</option>
          ${S.mechanics.map((n) => `<option ${n === me ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label></div>
      ${section('Select reason', reason)}${section('Waiting for mechanic', waiting)}${section('Under repair', repair)}
      ${list.length ? '' : `<div class="card" style="margin-top:16px">No open calls${mid ? ' for ' + esc(mid) : ''}. 👍</div>`}`;
  },
  bind() {
    $('#me')?.addEventListener('change', (e) => store.set('mechanic', e.target.value));
    document.querySelectorAll('[data-note]').forEach((el) => el.addEventListener('input', () => { draft[el.dataset.note].note = el.value; }));
  },
};
ACTIONS.arrive = (d) => {
  const me = $('#me').value;
  if (!me) return toast('Select your name first', true);
  act('POST', `/api/tickets/${d.id}/arrive`, { mechanic: me }, 'Repair started');
};
ACTIONS.finish = (d) => act('POST', `/api/tickets/${d.id}/finish`, {}, 'Repair finished – select the reason');
ACTIONS.pick = (d) => { draft[d.id].reasonId = d.reason; render(); };
ACTIONS.reason = async (d) => {
  const dr = draft[d.id];
  await act('POST', `/api/tickets/${d.id}/reason`, { reasonId: dr.reasonId, note: dr.note, mechanic: $('#me').value || undefined }, 'Saved');
  delete draft[d.id];
};

// Reports
const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
let rep = { from: dayStr(new Date(Date.now() - 6 * 864e5)), to: dayStr(new Date()), tickets: null };
function rangeQs() {
  const from = new Date(rep.from + 'T00:00:00'), to = new Date(rep.to + 'T00:00:00');
  to.setDate(to.getDate() + 1);
  return `from=${from.toISOString()}&to=${to.toISOString()}`;
}
async function loadReport() {
  rep.tickets = await api('GET', '/api/tickets?' + rangeQs());
  render();
}
function groupTable(title, rows, keyName) {
  const g = new Map();
  for (const t of rows) {
    const k = t._key || '(none)';
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(t);
  }
  const data = [...g].map(([k, ts]) => {
    const w = ts.filter((t) => t.arriveAt).map((t) => t.arriveAt - t.callAt);
    const r = ts.filter((t) => t.finishAt).map((t) => t.finishAt - t.arriveAt);
    const d = ts.filter((t) => t.finishAt).map((t) => t.finishAt - t.callAt);
    return { k, n: ts.length, w: avg(w), r: avg(r), d: sum(d) };
  }).sort((a, b) => b.d - a.d || b.n - a.n);
  const max = Math.max(1, ...data.map((x) => x.d));
  return `<div class="card"><h2 style="margin-top:0">${title}</h2><div class="table-wrap"><table>
    <tr><th>${keyName}</th><th class="num">Calls</th><th class="num">Avg wait</th><th class="num">Avg repair</th><th class="num">Downtime min</th><th style="width:30%"></th></tr>
    ${data.map((x) => `<tr><td>${esc(x.k)}</td><td class="num">${x.n}</td><td class="num">${fmtMin(x.w)}</td><td class="num">${fmtMin(x.r)}</td>
      <td class="num">${fmtMin(x.d)}</td><td><div class="bar" style="width:${(x.d / max) * 100}%"></div></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No data</td></tr>'}
  </table></div></div>`;
}
VIEWS.reports = {
  html() {
    if (!rep.tickets) { loadReport(); return '<p class="muted">Loading…</p>'; }
    const all = rep.tickets.filter((t) => t.status !== 'cancelled');
    const w = all.filter((t) => t.arriveAt).map((t) => t.arriveAt - t.callAt);
    const r = all.filter((t) => t.finishAt).map((t) => t.finishAt - t.arriveAt);
    const d = all.filter((t) => t.finishAt).map((t) => t.finishAt - t.callAt);
    const withKey = (fn) => all.map((t) => ({ ...t, _key: fn(t) }));
    const ms = (a, b) => (a && b ? fmtDur(b - a) : '–');
    return `<div class="row"><div><h1>Reports</h1><div class="muted">Waiting = call → mechanic arrives. Repair = arrive → job done. Downtime = call → job done.</div></div></div>
      <div class="card row no-print" style="margin-top:12px">
        <label>From<input type="date" id="rf" value="${rep.from}"></label>
        <label>To<input type="date" id="rt" value="${rep.to}"></label>
        <button data-act="range" data-days="1">Today</button><button data-act="range" data-days="7">7 days</button><button data-act="range" data-days="30">30 days</button>
        <button class="primary" data-act="load">Show</button><span class="spacer"></span>
        <a class="btn" href="/api/report.csv?${rangeQs()}">⬇ Download CSV (Excel)</a></div>
      <div class="kpis">
        <div class="card kpi"><div class="label">Breakdown calls</div><div class="value">${all.length}</div></div>
        <div class="card kpi"><div class="label">Total downtime (min)</div><div class="value">${fmtMin(sum(d))}</div></div>
        <div class="card kpi"><div class="label">Avg waiting (min)</div><div class="value">${fmtMin(avg(w))}</div></div>
        <div class="card kpi"><div class="label">Avg repair / MTTR (min)</div><div class="value">${fmtMin(avg(r))}</div></div>
        <div class="card kpi"><div class="label">Longest wait (min)</div><div class="value">${fmtMin(w.length ? Math.max(...w) : null)}</div></div>
        <div class="card kpi ${all.some((t) => t.status === 'awaiting_reason') ? 'warn' : ''}"><div class="label">Reason not entered</div><div class="value">${all.filter((t) => t.status === 'awaiting_reason').length}</div></div>
      </div>
      <div class="two">
        ${groupTable('By problem reason', withKey((t) => t.reason || (t.status === 'closed' ? '' : 'Open / pending')), 'Reason')}
        ${groupTable('By machine', withKey((t) => `${t.machineId} ${machineById(t.machineId).name}`), 'Machine')}
        ${groupTable('By mechanic', withKey((t) => t.mechanic || 'Not assigned'), 'Mechanic')}
        ${groupTable('By line', withKey((t) => machineById(t.machineId).line), 'Line')}
      </div>
      <h2>All calls</h2><div class="table-wrap"><table>
        <tr><th>#</th><th>Machine</th><th>Status</th><th>Called</th><th class="num">Waiting</th><th class="num">Repair</th><th class="num">Downtime</th><th>Mechanic</th><th>Reason</th><th>Note</th></tr>
        ${rep.tickets.slice().reverse().map((t) => `<tr><td>${t.id}</td><td>${esc(t.machineId)}</td><td><span class="badge ${t.status}">${STATUS[t.status]}</span></td>
          <td>${fmtTime(t.callAt)}</td><td class="num">${ms(t.callAt, t.arriveAt)}</td><td class="num">${ms(t.arriveAt, t.finishAt)}</td><td class="num">${ms(t.callAt, t.finishAt)}</td>
          <td>${esc(t.mechanic)}</td><td>${esc(t.reason)}</td><td>${esc(t.note)}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">No calls in this period</td></tr>'}
      </table></div>`;
  },
};
ACTIONS.range = (d) => {
  rep.to = dayStr(new Date());
  rep.from = dayStr(new Date(Date.now() - (Number(d.days) - 1) * 864e5));
  loadReport();
};
ACTIONS.load = () => { rep.from = $('#rf').value; rep.to = $('#rt').value; loadReport(); };

// Settings
VIEWS.settings = {
  html() {
    const st = S.settings;
    const base = location.origin;
    return `<h1>Settings</h1><p class="muted">Machines, problem reasons, mechanics and alert limits.</p>
      <div class="two">
        <div class="card"><h2 style="margin-top:0">Machines</h2><p class="muted">One per line: <code>ID, Machine type, Line</code></p>
          <textarea id="s-machines">${esc(S.machines.map((m) => [m.id, m.name, m.line].join(', ')).join('\n'))}</textarea></div>
        <div class="card"><h2 style="margin-top:0">Problem reasons</h2><p class="muted">One per line. Shown to the mechanic after the job is done.</p>
          <textarea id="s-reasons">${esc(S.reasons.map((r) => r.name).join('\n'))}</textarea></div>
        <div class="card"><h2 style="margin-top:0">Mechanics</h2><p class="muted">One name or ID per line.</p>
          <textarea id="s-mechanics">${esc(S.mechanics.join('\n'))}</textarea></div>
        <div class="card"><h2 style="margin-top:0">Alert limits (minutes)</h2><div class="row">
          <label>Waiting – warning<input type="number" min="1" id="s-ww" value="${st.waitWarnMin}"></label>
          <label>Waiting – alarm<input type="number" min="1" id="s-wa" value="${st.waitAlarmMin}"></label>
          <label>Repair – warning<input type="number" min="1" id="s-rw" value="${st.repairWarnMin}"></label>
          <label>Repair – alarm<input type="number" min="1" id="s-ra" value="${st.repairAlarmMin}"></label></div>
          <p class="muted">Timers turn amber at the warning limit and red at the alarm limit. Waiting tiles flash on the dashboard.</p></div>
      </div>
      <p><button class="primary" data-act="save">Save settings</button></p>
      <div class="row"><h2>Machine QR codes &amp; button links</h2><span class="spacer"></span><button class="no-print" data-act="print">🖨 Print QR labels</button></div>
      <p class="muted no-print">Stick a label on each machine. The mechanic scans it to open that machine's call on their phone.
        A hardware button (for example an ESP32) calls <code>${esc(base)}/api/machines/&lt;ID&gt;/press</code>: 1st press calls the mechanic, 2nd press = mechanic arrived, 3rd press = job done.</p>
      <div class="qr-list">${S.machines.map((m) => {
        const url = `${base}/#mechanic?m=${encodeURIComponent(m.id)}`;
        return `<div class="card"><strong>${esc(m.id)}</strong> · ${esc(m.name)}<div class="qr" data-qr="${esc(url)}"></div>
          <div class="muted">${esc(url)}</div><div class="no-print"><a href="#operator?m=${encodeURIComponent(m.id)}">Operator page</a></div></div>`;
      }).join('')}</div>`;
  },
  bind() { drawQrs(); },
};
function drawQrs() {
  const draw = () => document.querySelectorAll('[data-qr]').forEach((el) => {
    el.innerHTML = '';
    new window.QRCode(el, { text: el.dataset.qr, width: 128, height: 128 });
  });
  if (window.QRCode) return draw();
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  s.onload = draw; // offline: links still show as text
  document.head.appendChild(s);
}
ACTIONS.print = () => window.print();
ACTIONS.save = async () => {
  const lines = (id) => $(id).value.split('\n').map((s) => s.trim()).filter(Boolean);
  const machines = lines('#s-machines').map((l) => {
    const [id, name = '', ...line] = l.split(',').map((s) => s.trim());
    return { id, name, line: line.join(', ') };
  });
  const reasons = lines('#s-reasons').map((name) => ({ id: S.reasons.find((r) => r.name === name)?.id, name }));
  const settings = { waitWarnMin: $('#s-ww').value, waitAlarmMin: $('#s-wa').value, repairWarnMin: $('#s-rw').value, repairAlarmMin: $('#s-ra').value };
  await act('PUT', '/api/config', { machines, reasons, mechanics: lines('#s-mechanics'), settings }, 'Settings saved');
  render();
};

// ---------- live connection ----------
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => { $('#conn').classList.add('live'); refresh().catch(() => {}); });
  es.addEventListener('change', () => refresh().catch(() => {}));
  es.addEventListener('error', () => $('#conn').classList.remove('live'));
}
refresh().then(() => render()).catch((e) => toast('Cannot reach server: ' + e.message, true));
connect();
