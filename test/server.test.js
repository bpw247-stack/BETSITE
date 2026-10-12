'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsite-'));
process.env.DATA_FILE = path.join(dir, 'db.json');
const { server } = require('../server');

test('bets / notes / teamNotes CRUD persists to disk', async (t) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  };

  const created = await call('POST', '/api/bets', { sport: 'NFL', team: 'KC', odds: -110, stake: 11, result: 'pending' });
  assert.strictEqual(created.status, 201);
  assert.ok(created.body.id);

  const updated = await call('PUT', `/api/bets/${created.body.id}`, { result: 'won', notes: [{ id: 'n1', text: 'hi' }] });
  assert.strictEqual(updated.body.result, 'won');
  assert.strictEqual(updated.body.team, 'KC');

  const tn = await call('PUT', '/api/teamNotes/NFL-KC', { entries: [{ id: 'a', text: 'note' }] });
  assert.strictEqual(tn.status, 200);
  await call('POST', '/api/notes', { title: 'General', body: 'x' });

  const onDisk = JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'));
  assert.strictEqual(onDisk.bets[0].result, 'won');
  assert.strictEqual(onDisk.teamNotes[0].id, 'NFL-KC');
  assert.strictEqual(onDisk.notes.length, 1);

  assert.strictEqual((await call('DELETE', `/api/bets/${created.body.id}`)).status, 204);
  assert.strictEqual((await call('GET', `/api/bets/${created.body.id}`)).status, 404);
  assert.strictEqual((await call('GET', '/api/nope')).status, 404);
  assert.strictEqual((await call('GET', '/api/injuries/mlb')).status, 404);
  assert.strictEqual((await call('GET', '/api/schedule/mlb')).status, 404);

  const page = await fetch(base + '/');
  assert.match(await page.text(), /BetSite/);
  assert.strictEqual((await fetch(base + '/..%2fserver.js')).status, 403);
});
