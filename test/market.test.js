'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../lib/market');
const S = require('../public/stats.js');

test('parseEspnLines: current from details, opener from open objects', () => {
  const l = M.parseEspnLines({ odds: [{ provider: { name: 'DraftKings' }, details: 'KC -3.5', overUnder: 47.5, homeTeamOdds: { moneyLine: -180 }, awayTeamOdds: { moneyLine: 150 },
    pointSpread: { home: { open: { line: '-2.5' } } }, total: { over: { open: { line: 'o45.5' } } } }] }, 'KC');
  assert.deepStrictEqual(l.current, { homeSpread: -3.5, total: 47.5, homeML: -180, awayML: 150 });
  assert.strictEqual(l.open.homeSpread, -2.5);
  assert.strictEqual(l.open.total, 45.5);
  assert.strictEqual(M.parseEspnLines({ odds: [{ details: 'BUF -1.5' }] }, 'KC').current.homeSpread, 1.5); // away favored
  assert.strictEqual(M.parseEspnLines({ odds: [{ details: 'KC -1' }] }, 'KC').open, null);
  assert.strictEqual(M.parseEspnLines({}, 'KC'), null);
});

const ev = {
  id: 'ev1', home_team: 'Kansas City Chiefs', away_team: 'Buffalo Bills', commence_time: '2026-10-19T20:25:00Z',
  bookmakers: [
    { title: 'DraftKings', markets: [
      { key: 'spreads', outcomes: [{ name: 'Kansas City Chiefs', point: -3.5, price: -110 }, { name: 'Buffalo Bills', point: 3.5, price: -110 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 47.5, price: -110 }, { name: 'Under', point: 47.5, price: -110 }] },
      { key: 'h2h', outcomes: [{ name: 'Kansas City Chiefs', price: -180 }, { name: 'Buffalo Bills', price: 155 }] },
    ] },
    { title: 'FanDuel', markets: [
      { key: 'spreads', outcomes: [{ name: 'Kansas City Chiefs', point: -3, price: -118 }, { name: 'Buffalo Bills', point: 3, price: -102 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 47, price: -112 }, { name: 'Under', point: 47, price: -108 }] },
      { key: 'h2h', outcomes: [{ name: 'Kansas City Chiefs', price: -175 }, { name: 'Buffalo Bills', price: 160 }] },
    ] },
    { title: 'BetMGM', markets: [
      { key: 'spreads', outcomes: [{ name: 'Kansas City Chiefs', point: -3.5, price: -105 }, { name: 'Buffalo Bills', point: 3.5, price: -115 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 48, price: -110 }, { name: 'Under', point: 48, price: -110 }] },
    ] },
  ],
};

test('matchOddsEvent + gameConsensus: medians and best prices', () => {
  const game = { date: '2026-10-19T20:25Z', home: { name: 'Kansas City Chiefs' }, away: { name: 'Buffalo Bills' } };
  assert.strictEqual(M.matchOddsEvent([ev], game).id, 'ev1');
  assert.strictEqual(M.matchOddsEvent([ev], { ...game, date: '2026-10-26T20:25Z' }), null);
  const c = M.gameConsensus(ev);
  assert.strictEqual(c.books, 3);
  assert.deepStrictEqual(c.consensus, { homeSpread: -3.5, total: 47.5, homeML: -177.5, awayML: 157.5 });
  assert.deepStrictEqual(c.best.homeSpread, { book: 'FanDuel', point: -3, price: -118 });
  assert.deepStrictEqual(c.best.awaySpread, { book: 'DraftKings', point: 3.5, price: -110 });
  assert.deepStrictEqual(c.best.over, { book: 'FanDuel', point: 47, price: -112 });
  assert.deepStrictEqual(c.best.under, { book: 'BetMGM', point: 48, price: -110 });
  assert.deepStrictEqual(c.best.awayML, { book: 'FanDuel', price: 160 });
});

test('propsConsensus: median line, best over/under, yes/no props', () => {
  const props = M.propsConsensus({ bookmakers: [
    { title: 'DK', markets: [{ key: 'player_rush_yds', outcomes: [{ name: 'Over', description: 'Derrick Henry', point: 89.5, price: -115 }, { name: 'Under', description: 'Derrick Henry', point: 89.5, price: -105 }] },
      { key: 'player_anytime_td', outcomes: [{ name: 'Yes', description: 'Derrick Henry', price: -150 }] }] },
    { title: 'FD', markets: [{ key: 'player_rush_yds', outcomes: [{ name: 'Over', description: 'Derrick Henry', point: 87.5, price: -110 }, { name: 'Under', description: 'Derrick Henry', point: 87.5, price: -110 }] }] },
    { title: 'MGM', markets: [{ key: 'player_rush_yds', outcomes: [{ name: 'Over', description: 'Derrick Henry', point: 90.5, price: -110 }, { name: 'Under', description: 'Derrick Henry', point: 90.5, price: -110 }] },
      { key: 'player_anytime_td', outcomes: [{ name: 'Yes', description: 'Derrick Henry', price: -140 }] }] },
  ] }, 'nfl');
  const rush = props.find((p) => p.category === 'Rushing Yards');
  assert.strictEqual(rush.line, 89.5);
  assert.strictEqual(rush.books, 3);
  assert.deepStrictEqual(rush.over, { price: -110, book: 'FD', point: 87.5 });
  assert.deepStrictEqual(rush.under, { price: -110, book: 'MGM', point: 90.5 });
  const td = props.find((p) => p.category === 'Anytime TD');
  assert.strictEqual(td.yesNo, true);
  assert.deepStrictEqual(td.over, { price: -140, book: 'MGM', point: null });
});

test('splitsSignals: sharp money, public side, reverse line movement', () => {
  const names = { home: 'KC', away: 'BUF' };
  const sig = S.splitsSignals({ homeBets: 75, homeMoney: 50, overBets: 65, overMoney: 40 }, { homeSpreadOpen: -3.5, homeSpreadNow: -2.5, totalOpen: 48, totalNow: 46.5 }, names);
  const types = sig.map((x) => x.type);
  assert.deepStrictEqual(types, ['sharp', 'public', 'rlm', 'sharp', 'rlm']);
  assert.match(sig[0].text, /Bigger bets on BUF: 25% of bets but 50% of the money/);
  assert.match(sig[1].text, /KC is the public side \(75%/);
  assert.match(sig[2].text, /toward BUF/);
  assert.match(sig[3].text, /under/);
  assert.deepStrictEqual(S.splitsSignals({ homeBets: 52, homeMoney: 55 }, {}, names), []);
  assert.deepStrictEqual(S.splitsSignals(null, {}, names), []);
});
