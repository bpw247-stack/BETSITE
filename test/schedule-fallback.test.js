'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'betsite-')), 'db.json');
const { server } = require('../server');

test('schedule falls back to per-day requests when ESPN rejects a date range', async (t) => {
  const realFetch = global.fetch;
  const espnCalls = [];
  global.fetch = async (url, opts) => {
    if (!String(url).includes('espn.com')) return realFetch(url, opts);
    espnCalls.push(String(url));
    const dates = new URL(url).searchParams.get('dates') || '';
    if (dates.includes('-')) return new Response('bad', { status: 400 });
    const ev = {
      id: 'g' + dates,
      date: `${dates.slice(0, 4)}-${dates.slice(4, 6)}-${dates.slice(6)}T23:00Z`,
      competitions: [{ competitors: [{ homeAway: 'home', team: { abbreviation: 'KC' } }, { homeAway: 'away', team: { abbreviation: 'BUF' } }] }],
    };
    return Response.json({ events: [ev] });
  };
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    global.fetch = realFetch;
    console.warn = warn;
    server.close();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const r = await realFetch(`http://127.0.0.1:${server.address().port}/api/schedule/nfl?days=3`);
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.games.length, 3);
  assert.strictEqual(espnCalls.length, 4); // 1 rejected range + 3 single days
});
