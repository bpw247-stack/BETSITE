'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betsite-'));
process.env.DATA_FILE = path.join(dir, 'db.json');
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({ bets: [], notes: [], teamNotes: [], coaches: [], settings: [{ id: 'app', oddsApiKey: 'testkey' }], splits: [{ id: '401', homeBets: 70, homeMoney: 45 }] }));
const { server } = require('../server');

test('market endpoint merges ESPN lines, first-seen openers, Odds API consensus and props', async (t) => {
  const realFetch = global.fetch;
  const kick = new Date(Date.now() + 2 * 86400000).toISOString();
  let oddsCalls = 0;
  global.fetch = async (url, opts) => {
    url = String(url);
    if (url.includes('espn.com') && url.includes('scoreboard')) {
      return Response.json({ events: [{ id: '401', date: kick, status: { type: { state: 'pre' } }, competitions: [{ odds: [{ details: 'KC -3.5', overUnder: 47.5 }], competitors: [
        { homeAway: 'home', team: { abbreviation: 'KC', displayName: 'Kansas City Chiefs' } }, { homeAway: 'away', team: { abbreviation: 'BUF', displayName: 'Buffalo Bills' } }] }] }] });
    }
    if (url.includes('the-odds-api.com')) {
      oddsCalls++;
      assert.ok(url.includes('apiKey=testkey'));
      const headers = { 'x-requests-remaining': '480', 'x-requests-used': '20' };
      if (url.includes('/events/ev1/odds')) {
        return Response.json({ bookmakers: [{ title: 'DK', markets: [{ key: 'player_pass_yds', outcomes: [{ name: 'Over', description: 'Patrick Mahomes', point: 265.5, price: -115 }, { name: 'Under', description: 'Patrick Mahomes', point: 265.5, price: -105 }] }] }] }, { headers });
      }
      if (url.includes('/events?')) return Response.json([{ id: 'ev1', home_team: 'Kansas City Chiefs', away_team: 'Buffalo Bills', commence_time: kick }], { headers });
      return Response.json([{ id: 'ev1', home_team: 'Kansas City Chiefs', away_team: 'Buffalo Bills', commence_time: kick, bookmakers: [{ title: 'DK', markets: [{ key: 'spreads', outcomes: [{ name: 'Kansas City Chiefs', point: -3, price: -110 }, { name: 'Buffalo Bills', point: 3, price: -110 }] }] }] }], { headers });
    }
    return realFetch(url, opts);
  };
  t.after(() => {
    global.fetch = realFetch;
    server.close();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const m = await (await realFetch(`${base}/api/market/nfl`)).json();
  const g = m.games[0];
  assert.strictEqual(g.lines.current.homeSpread, -3.5);
  assert.strictEqual(g.firstSeen.homeSpread, -3.5);
  assert.strictEqual(g.consensus.consensus.homeSpread, -3);
  assert.strictEqual(g.splits.homeBets, 70);
  assert.strictEqual(m.odds.remaining, 480);
  await realFetch(`${base}/api/market/nfl`); // cached: no new Odds API call
  assert.strictEqual(oddsCalls, 1);

  const p = await (await realFetch(`${base}/api/props/nfl/401`)).json();
  assert.strictEqual(p.props[0].player, 'Patrick Mahomes');
  assert.strictEqual(p.props[0].line, 265.5);
  assert.strictEqual(p.props[0].firstSeen.line, 265.5);
  assert.strictEqual(oddsCalls, 3); // events list + event odds
});
