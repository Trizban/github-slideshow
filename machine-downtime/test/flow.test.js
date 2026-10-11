'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcdt-')), 'db.json');
const { server } = require('../server');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); })));
test.after(() => server.close());

async function req(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: res.headers.get('content-type').includes('json') ? JSON.parse(text) : text };
}

test('operator call -> mechanic arrive -> job done -> reason', async () => {
  const call = await req('POST', '/api/machines/MC-01/call', { operator: 'OP-1' });
  assert.equal(call.status, 200);
  assert.equal(call.body.status, 'waiting');

  assert.equal((await req('POST', '/api/machines/MC-01/call')).status, 409, 'no duplicate call');
  assert.equal((await req('POST', `/api/tickets/${call.body.id}/reason`, { reasonId: 'R1' })).status, 409, 'reason only after finish');

  const arrive = await req('POST', `/api/tickets/${call.body.id}/arrive`, { mechanic: 'Mechanic A' });
  assert.equal(arrive.body.status, 'in_repair');
  assert.ok(arrive.body.arriveAt >= arrive.body.callAt);

  const finish = await req('POST', `/api/tickets/${call.body.id}/finish`);
  assert.equal(finish.body.status, 'awaiting_reason');

  assert.equal((await req('POST', `/api/tickets/${call.body.id}/reason`, { reasonId: 'nope' })).status, 400);
  const done = await req('POST', `/api/tickets/${call.body.id}/reason`, { reasonId: 'R1', note: 'changed needle' });
  assert.equal(done.body.status, 'closed');
  assert.equal(done.body.reason, 'Needle break');
  assert.equal(done.body.mechanic, 'Mechanic A');

  const state = await req('GET', '/api/state');
  assert.equal(state.body.open.length, 0);
});

test('hardware button press cycles call -> arrive -> finish', async () => {
  const steps = [];
  for (let i = 0; i < 3; i++) steps.push((await req('POST', '/api/machines/MC-02/press')).body.action);
  assert.deepEqual(steps, ['call', 'arrive', 'finish']);
  // machine is running again; a new press opens a new call even though the reason is still pending
  assert.equal((await req('GET', '/api/machines/MC-02/press')).body.action, 'call');
  assert.equal((await req('POST', '/api/machines/MC-99/press')).status, 404);
});

test('cancel and CSV export', async () => {
  const t = (await req('POST', '/api/machines/MC-03/call')).body;
  assert.equal((await req('POST', `/api/tickets/${t.id}/cancel`)).body.status, 'cancelled');
  const csv = await req('GET', '/api/report.csv');
  assert.match(csv.body, /Ticket,Machine/);
  assert.match(csv.body, /Needle break/);
});

test('config update keeps reason ids and validates machines', async () => {
  const st = (await req('GET', '/api/state')).body;
  const reasons = [...st.reasons.slice(0, 2), { name: 'Hook timing' }];
  await req('PUT', '/api/config', { reasons, settings: { waitAlarmMin: 12 } });
  const after = (await req('GET', '/api/state')).body;
  assert.equal(after.reasons[0].id, 'R1');
  assert.equal(after.reasons[2].name, 'Hook timing');
  assert.equal(after.reasons[2].id, 'R16');
  assert.equal(after.settings.waitAlarmMin, 12);
  assert.equal((await req('PUT', '/api/config', { machines: [{ id: 'A' }, { id: 'A' }] })).status, 400);
});
