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

test('research finds the team the player really plays for and never swaps in a same-last-name player', async (t) => {
  const realFetch = global.fetch;
  // HOU games (the team the bet wrongly lists): Truman Jones plays for HOU; Daniel Jones only shows up in the IND game
  // IND games: Daniel Jones throws every week
  const games = {
    HOU: [['h1', 'TEN'], ['h2', 'IND'], ['h3', 'JAX'], ['h4', 'KC']],
    IND: [['i1', 'LAC'], ['i2', 'HOU'], ['i3', 'JAX'], ['i4', 'KC']],
  };
  const ids = { h2: 'i2' }; // the HOU-IND meeting is one game
  const passYds = { i1: 251, i2: 199, i3: 310, i4: 228 };
  global.fetch = async (url, opts) => {
    url = String(url);
    if (!url.includes('espn.com')) return realFetch(url, opts);
    const sm = /teams\/(\w+)\/schedule\?season=(\d+)&seasontype=(\d)/.exec(url);
    if (sm) {
      const team = sm[1].toUpperCase();
      if (sm[3] !== '2' || !games[team] || sm[2] !== '2026') return Response.json({ events: [] });
      return Response.json({ events: games[team].map(([id, o], i) => ({ id: ids[id] || id, date: `2026-09-${10 + i * 7}T17:00Z`, competitions: [{ status: { type: { completed: true } }, competitors: [{ homeAway: 'home', score: '20', team: { abbreviation: team } }, { homeAway: 'away', score: '17', team: { abbreviation: o } }] }] })) });
    }
    const m = /summary\?event=(\w+)/.exec(url);
    if (m) {
      const id = m[1];
      const players = [];
      if (id.startsWith('h') || id === 'i2') players.push({ team: { abbreviation: 'HOU' }, statistics: [{ name: 'defensive', labels: ['TOT'], athletes: [{ athlete: { displayName: 'Truman Jones' }, stats: ['3'] }] }] });
      if (id.startsWith('i')) players.push({ team: { abbreviation: 'IND' }, statistics: [{ name: 'passing', labels: ['C/ATT', 'YDS', 'TD'], athletes: [{ athlete: { displayName: 'Daniel Jones' }, stats: ['22/33', String(passYds[id]), '1'] }] }] });
      return Response.json({ header: { competitions: [{ status: { type: { completed: true } }, competitors: [{ score: '20', team: { abbreviation: 'HOU' } }, { score: '17', team: { abbreviation: 'IND' } }] }] }, boxscore: { players } });
    }
    return new Response('nope', { status: 404 });
  };
  t.after(() => {
    global.fetch = realFetch;
    server.close();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/propresearch/nfl`;
  const d = await (await realFetch(`${base}?team=HOU&player=Daniel%20Jones&prop=Passing%20Yards&line=239.5&side=Over&opp=IND`)).json();
  assert.strictEqual(d.player, 'Daniel Jones');
  assert.strictEqual(d.team, 'IND');
  assert.strictEqual(d.opp, 'HOU');
  assert.strictEqual(d.teamChanged, true);
  assert.deepStrictEqual(d.games.filter((g) => !g.dnp).map((g) => g.value).sort(), [199, 228, 251, 310]);
  assert.strictEqual(d.qb, true);
});
