'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'betsite-')), 'db.json');
const { server } = require('../server');

test('prop research returns the last games played with values vs the line', async (t) => {
  const realFetch = global.fetch;
  const yards = { g1: 280, g2: 190, g3: null, g4: 301 }; // g3: did not play
  const opp = { g1: 'DEN', g2: 'BUF', g3: 'LV', g4: 'BUF' };
  global.fetch = async (url, opts) => {
    url = String(url);
    if (!url.includes('espn.com')) return realFetch(url, opts);
    if (url.includes('/schedule')) {
      if (!url.includes('seasontype=2')) return Response.json({ events: [] });
      return Response.json({ events: Object.keys(yards).map((id, i) => ({ id, date: `2025-10-0${i + 1}T17:00Z`, competitions: [{ status: { type: { completed: true } }, competitors: [{ homeAway: 'home', score: '20', team: { abbreviation: 'KC' } }, { homeAway: 'away', score: '17', team: { abbreviation: opp[id] } }] }] })) });
    }
    const m = /summary\?event=(g\d)/.exec(url);
    if (m) {
      const y = yards[m[1]];
      return Response.json({
        header: { competitions: [{ status: { type: { completed: true } }, competitors: [{ score: '20', team: { abbreviation: 'KC' } }, { score: '17', team: { abbreviation: opp[m[1]] } }] }] },
        boxscore: { players: [{ team: { abbreviation: 'KC' }, statistics: [{ name: 'passing', labels: ['C/ATT', 'YDS', 'TD'], athletes: y == null ? [] : [{ athlete: { displayName: 'Patrick Mahomes' }, stats: ['20/30', String(y), '2'] }] }] }] },
      });
    }
    return new Response('nope', { status: 404 });
  };
  t.after(() => {
    global.fetch = realFetch;
    server.close();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/propresearch/nfl`;
  const r = await realFetch(`${base}?team=KC&player=mahomes&prop=Passing%20Yards&line=250.5&side=Over&opp=BUF`);
  const d = await r.json();
  assert.strictEqual(d.player, 'Patrick Mahomes');
  assert.deepStrictEqual(d.games.map((g) => (g.dnp ? 'DNP' : g.value)), [301, 'DNP', 190, 280]);
  assert.deepStrictEqual([d.summary.hits, d.summary.misses], [2, 1]);
  assert.deepStrictEqual(d.vsOpp.map((g) => g.value), [301, 190]);
  assert.strictEqual((await realFetch(`${base}?team=KC&player=x&prop=First%20TD`)).status, 400);
  assert.strictEqual((await realFetch(`${base}?player=x&prop=Points`)).status, 400);
});
