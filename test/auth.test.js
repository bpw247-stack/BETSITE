'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAuth } = require('../lib/auth');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsite-'));
process.env.DATA_FILE = path.join(dir, 'db.json');

test('auth: password hashing, sessions, attempts', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'betsite-auth-'));
  const a = createAuth({ dataDir: d });
  assert.strictEqual(a.passwordSet(), false);
  assert.throws(() => a.setPassword('123'), /6 characters/);
  a.setPassword('hunter22');
  assert.ok(a.verify('hunter22'));
  assert.ok(!a.verify('wrong'));
  assert.ok(!fs.readFileSync(path.join(d, 'auth.json'), 'utf8').includes('hunter22'));
  const tok = a.createSession('phone');
  assert.ok(a.validSession(tok));
  assert.ok(createAuth({ dataDir: d }).validSession(tok)); // survives restart
  a.setPassword('newpass99');
  assert.ok(!a.validSession(tok)); // password change signs everyone out
  for (let i = 0; i < 10; i++) assert.ok(a.allowAttempt('1.2.3.4'));
  assert.ok(!a.allowAttempt('1.2.3.4'));
});

const lanIp = Object.values(os.networkInterfaces()).flat().find((x) => x && x.family === 'IPv4' && !x.internal);

test('server: other devices are blocked, then must sign in; this computer never needs to', { skip: !lanIp && 'no non-loopback interface' }, async (t) => {
  const { server } = require('../server');
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  t.after(() => server.close());
  const port = server.address().port;
  const local = `http://127.0.0.1:${port}`;
  const remote = `http://${lanIp.address}:${port}`;

  assert.strictEqual((await fetch(`${local}/api/bets`)).status, 200);
  let r = await fetch(`${remote}/api/bets`);
  assert.strictEqual(r.status, 403); // no password yet
  assert.match(await (await fetch(`${remote}/`)).text(), /Phone access is off/);

  // only this computer can set the password
  assert.strictEqual((await fetch(`${remote}/api/auth/password`, { method: 'POST', body: '{"password":"secret123"}' })).status, 403);
  r = await fetch(`${local}/api/auth/password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"secret123"}' });
  assert.strictEqual(r.status, 200);

  r = await fetch(`${remote}/`, { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/login');
  assert.strictEqual((await fetch(`${remote}/api/bets`)).status, 401);

  r = await fetch(`${remote}/login`, { method: 'POST', body: 'password=nope', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.strictEqual(r.status, 401);
  r = await fetch(`${remote}/login`, { method: 'POST', body: 'password=secret123', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^betsite_session=[a-f0-9]{64}$/);

  assert.strictEqual((await fetch(`${remote}/api/bets`, { headers: { cookie } })).status, 200);
  const st = await (await fetch(`${local}/api/auth/status`)).json();
  assert.deepStrictEqual([st.passwordSet, st.local, st.sessions], [true, true, 1]);
  assert.ok(st.urls.some((u) => u.url.includes(lanIp.address)));

  await fetch(`${remote}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.strictEqual((await fetch(`${remote}/api/bets`, { headers: { cookie } })).status, 401);
});
