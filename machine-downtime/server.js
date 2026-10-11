'use strict';
// Sewing-floor machine downtime tracker.
// Zero-dependency Node.js server: JSON-file storage, REST API, live updates via Server-Sent Events.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ticket lifecycle:
//   waiting         operator pressed the button, machine is down, waiting for mechanic
//   in_repair       mechanic arrived (scan / button), repair time is running
//   awaiting_reason mechanic finished (scan / button), machine is running again, reason not yet chosen
//   closed          reason selected, ticket complete
//   cancelled       operator called by mistake
const OPEN = ['waiting', 'in_repair', 'awaiting_reason'];
const DOWN = ['waiting', 'in_repair'];

function seed() {
  const machines = [];
  const types = ['Single Needle', 'Overlock', 'Flatlock', 'Single Needle', 'Bartack'];
  for (const line of ['Line 1', 'Line 2']) {
    for (let i = 0; i < 5; i++) {
      const n = machines.length + 1;
      machines.push({ id: 'MC-' + String(n).padStart(2, '0'), name: types[i], line });
    }
  }
  return {
    machines,
    reasons: [
      'Needle break', 'Thread breakage', 'Skipped stitch', 'Tension problem', 'Feed dog problem',
      'Bobbin / bobbin case', 'Looper problem', 'Oil leakage', 'Motor problem', 'Belt problem',
      'Electrical fault', 'Thread trimmer fault', 'Machine setting / changeover', 'Preventive service', 'Other',
    ].map((name, i) => ({ id: 'R' + (i + 1), name })),
    mechanics: ['Mechanic A', 'Mechanic B', 'Mechanic C'],
    settings: { waitWarnMin: 5, waitAlarmMin: 10, repairWarnMin: 15, repairAlarmMin: 30 },
    tickets: [],
    nextTicket: 1,
  };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const db = seed();
    save(db);
    return db;
  }
}

function save(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

let db = load();

// ---- live updates ----
const clients = new Set();
function broadcast() {
  for (const res of clients) res.write('event: change\ndata: ' + Date.now() + '\n\n');
}
function commit() {
  save(db);
  broadcast();
}

// ---- domain logic ----
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const machine = (id) => {
  const m = db.machines.find((x) => x.id === id);
  if (!m) throw new HttpError(404, 'Unknown machine ' + id);
  return m;
};
const ticket = (id) => {
  const t = db.tickets.find((x) => x.id === Number(id));
  if (!t) throw new HttpError(404, 'Unknown ticket ' + id);
  return t;
};
const openTicketFor = (machineId, statuses = OPEN) =>
  db.tickets.find((t) => t.machineId === machineId && statuses.includes(t.status));

function call(machineId, source = 'portal', operator = '') {
  machine(machineId);
  const existing = openTicketFor(machineId, DOWN);
  if (existing) throw new HttpError(409, machineId + ' already has an open call (#' + existing.id + ')');
  const t = {
    id: db.nextTicket++, machineId, status: 'waiting', source, operator: String(operator || ''),
    callAt: Date.now(), arriveAt: null, finishAt: null, closedAt: null,
    mechanic: '', reasonId: null, reason: '', note: '',
  };
  db.tickets.push(t);
  return t;
}

function arrive(t, mechanic = '') {
  if (t.status !== 'waiting') throw new HttpError(409, 'Ticket #' + t.id + ' is not waiting for a mechanic');
  t.status = 'in_repair';
  t.arriveAt = Date.now();
  if (mechanic) t.mechanic = String(mechanic);
  return t;
}

function finish(t) {
  if (t.status !== 'in_repair') throw new HttpError(409, 'Ticket #' + t.id + ' is not in repair');
  t.status = 'awaiting_reason';
  t.finishAt = Date.now();
  return t;
}

function setReason(t, { reasonId, mechanic, note }) {
  if (t.status !== 'awaiting_reason' && t.status !== 'closed') {
    throw new HttpError(409, 'Finish the repair before selecting a reason');
  }
  const r = db.reasons.find((x) => x.id === reasonId);
  if (!r) throw new HttpError(400, 'Select a valid reason');
  t.reasonId = r.id;
  t.reason = r.name;
  if (mechanic) t.mechanic = String(mechanic);
  if (note !== undefined) t.note = String(note);
  if (t.status !== 'closed') { t.status = 'closed'; t.closedAt = Date.now(); }
  return t;
}

function cancel(t) {
  if (t.status !== 'waiting') throw new HttpError(409, 'Only a call that is still waiting can be cancelled');
  t.status = 'cancelled';
  t.closedAt = Date.now();
  return t;
}

// Single physical button / QR scan: advances the machine to the next step.
function press(machineId, mechanic) {
  machine(machineId);
  const t = openTicketFor(machineId, DOWN);
  if (!t) return { action: 'call', ticket: call(machineId, 'button') };
  if (t.status === 'waiting') return { action: 'arrive', ticket: arrive(t, mechanic) };
  return { action: 'finish', ticket: finish(t) };
}

function filterTickets(q) {
  const from = q.get('from') ? Date.parse(q.get('from')) : 0;
  const to = q.get('to') ? Date.parse(q.get('to')) : Infinity;
  return db.tickets.filter((t) => t.callAt >= from && t.callAt < to);
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
const mins = (a, b) => (a && b ? ((b - a) / 60000).toFixed(1) : '');

function toCsv(tickets) {
  const head = ['Ticket', 'Machine', 'Machine type', 'Line', 'Status', 'Source', 'Operator', 'Mechanic',
    'Reason', 'Note', 'Called at', 'Mechanic arrived', 'Repair finished',
    'Waiting min', 'Repair min', 'Total downtime min'];
  const rows = tickets.map((t) => {
    const m = db.machines.find((x) => x.id === t.machineId) || {};
    return [t.id, t.machineId, m.name, m.line, t.status, t.source, t.operator, t.mechanic, t.reason, t.note,
      iso(t.callAt), iso(t.arriveAt), iso(t.finishAt),
      mins(t.callAt, t.arriveAt), mins(t.arriveAt, t.finishAt), mins(t.callAt, t.finishAt)];
  });
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function updateConfig(body) {
  if (Array.isArray(body.machines)) {
    const ids = new Set();
    db.machines = body.machines.map((m) => {
      const id = String(m.id || '').trim();
      if (!id || ids.has(id)) throw new HttpError(400, 'Machine IDs must be unique and not empty');
      ids.add(id);
      return { id, name: String(m.name || '').trim(), line: String(m.line || '').trim() };
    });
  }
  if (Array.isArray(body.reasons)) {
    let next = db.reasons.reduce((n, r) => Math.max(n, Number(String(r.id).slice(1)) || 0), 0) + 1;
    db.reasons = body.reasons
      .filter((r) => String(r.name || '').trim())
      .map((r) => ({ id: r.id || 'R' + next++, name: String(r.name).trim() }));
  }
  if (Array.isArray(body.mechanics)) {
    db.mechanics = body.mechanics.map((s) => String(s).trim()).filter(Boolean);
  }
  if (body.settings && typeof body.settings === 'object') {
    for (const k of Object.keys(db.settings)) {
      const v = Number(body.settings[k]);
      if (Number.isFinite(v) && v > 0) db.settings[k] = v;
    }
  }
}

// ---- HTTP ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new HttpError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;
  let match;

  if (!p.startsWith('/api/')) return serveStatic(res, p);

  if (m === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (m === 'GET' && p === '/api/state') {
    return send(res, 200, {
      serverTime: Date.now(), machines: db.machines, reasons: db.reasons, mechanics: db.mechanics,
      settings: db.settings, open: db.tickets.filter((t) => OPEN.includes(t.status)),
    });
  }
  if (m === 'GET' && p === '/api/tickets') return send(res, 200, filterTickets(url.searchParams));
  if (m === 'GET' && p === '/api/report.csv') {
    res.setHeader('Content-Disposition', 'attachment; filename="machine-downtime.csv"');
    return send(res, 200, '﻿' + toCsv(filterTickets(url.searchParams)), 'text/csv; charset=utf-8');
  }

  // Hardware button / QR endpoint. GET is allowed so a QR code or a simple IoT device can hit it directly.
  if ((m === 'POST' || m === 'GET') && (match = p.match(/^\/api\/machines\/([^/]+)\/press$/))) {
    const out = press(decodeURIComponent(match[1]), url.searchParams.get('mechanic'));
    commit();
    return send(res, 200, out);
  }

  if (m === 'POST' || m === 'PUT') {
    const body = await readBody(req);
    let out;
    if (m === 'PUT' && p === '/api/config') updateConfig(body);
    else if ((match = p.match(/^\/api\/machines\/([^/]+)\/call$/))) out = call(decodeURIComponent(match[1]), 'portal', body.operator);
    else if ((match = p.match(/^\/api\/tickets\/(\d+)\/arrive$/))) out = arrive(ticket(match[1]), body.mechanic);
    else if ((match = p.match(/^\/api\/tickets\/(\d+)\/finish$/))) out = finish(ticket(match[1]));
    else if ((match = p.match(/^\/api\/tickets\/(\d+)\/reason$/))) out = setReason(ticket(match[1]), body);
    else if ((match = p.match(/^\/api\/tickets\/(\d+)\/cancel$/))) out = cancel(ticket(match[1]));
    else return send(res, 404, { error: 'Not found' });
    commit();
    return send(res, 200, out || { ok: true });
  }

  send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e.message || 'Server error' });
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log('Machine downtime tracker running on http://localhost:' + PORT));
}

module.exports = { server };
