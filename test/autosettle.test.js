'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsite-'));
process.env.DATA_FILE = path.join(dir, 'db.json');
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({
  bets: [
    { id: 'b1', date: '2025-10-12', sport: 'NFL', betType: 'Moneyline', team: 'KC', opponent: 'DET', odds: -120, stake: 12, result: 'pending' },
    { id: 'b2', date: '2025-10-12', sport: 'NFL', betType: 'Parlay', odds: 260, stake: 10, result: 'pending', legs: [
      { id: 'l1', betType: 'Player Prop', team: 'KC', player: 'Travis Kelce', propCategory: 'Receiving Yards', side: 'Over', line: 80.5, result: 'pending' },
      { id: 'l2', betType: 'Total', team: 'KC', side: 'Under', line: 40.5, result: 'pending' },
    ] },
    { id: 'b3', date: '2025-10-12', sport: 'NFL', betType: 'Moneyline', team: 'KC', result: 'won' }, // already settled
  ],
  notes: [], teamNotes: [], coaches: [], settings: [],
}));
const { server } = require('../server');

test('autosettle grades pending picks from ESPN data without saving anything', async (t) => {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    url = String(url);
    if (!url.includes('espn.com')) return realFetch(url, opts);
    if (url.includes('/schedule')) {
      return Response.json({ events: [{ id: '900', date: '2025-10-12T20:25Z', competitions: [{ status: { type: { completed: true } }, competitors: [{ team: { abbreviation: 'KC' } }, { team: { abbreviation: 'DET' } }] }] }] });
    }
    if (url.includes('summary?event=900')) {
      return Response.json({
        header: { competitions: [{ status: { type: { completed: true } }, competitors: [{ score: '24', team: { abbreviation: 'KC' } }, { score: '21', team: { abbreviation: 'DET' } }] }] },
        boxscore: { players: [{ team: { abbreviation: 'KC' }, statistics: [{ name: 'receiving', labels: ['REC', 'YDS', 'TD'], athletes: [{ athlete: { displayName: 'Travis Kelce' }, stats: ['7', '91', '1'] }] }] }] },
      });
    }
    return new Response('nope', { status: 404 });
  };
  t.after(() => {
    global.fetch = realFetch;
    server.close();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const r = await realFetch(`http://127.0.0.1:${server.address().port}/api/autosettle`, { method: 'POST' });
  const body = await r.json();
  assert.strictEqual(body.checked, 3);
  const by = Object.fromEntries(body.results.map((x) => [x.legId || x.betId, x]));
  assert.strictEqual(by.b1.result, 'won');
  assert.strictEqual(by.l1.result, 'won');
  assert.strictEqual(by.l2.result, 'lost'); // 45 total
  assert.strictEqual(JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8')).bets[0].result, 'pending'); // nothing saved
});
