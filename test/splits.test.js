'use strict';
const test = require('node:test');
const assert = require('node:assert');
global.window = global.window || {};
require('../public/teams.js');
const LEAGUES = global.window.LEAGUES;
const { parseSplits } = require('../public/splits.js');

const games = [
  { id: '1', away: { abbr: 'BUF' }, home: { abbr: 'KC' } },
  { id: '2', away: { abbr: 'GB' }, home: { abbr: 'DET' } },
  { id: '3', away: { abbr: 'NYJ' }, home: { abbr: 'MIA' } },
];
const P = (t) => parseSplits(t, games, LEAGUES, 'NFL');

test('article sentences (SportsBettingDime-style)', () => {
  const r = P(`Bills vs Chiefs prediction
Public betting: 64% of bets are on the Buffalo Bills, but 58% of the money is on Kansas City.
The over is getting 71% of tickets and 66% of the handle.

Packers at Lions
Detroit is drawing 55% of spread bets while 70% of the money is backing Green Bay.
59% of bets are on the under.`);
  assert.deepStrictEqual(r['1'], { matchup: 'BUF @ KC', homeBets: 36, homeMoney: 58, overBets: 71, overMoney: 66 });
  assert.deepStrictEqual(r['2'], { matchup: 'GB @ DET', homeBets: 55, homeMoney: 30, overBets: 41 });
});

test('VSIN-style table rows with a header (handle before bets, plus totals)', () => {
  const r = P(`Team Spread Handle Bets Total Handle Bets
Buffalo Bills +2.5 45% 62% o46.5 70% 66%
Kansas City Chiefs -2.5 55% 38% u46.5 30% 34%`);
  assert.deepStrictEqual(r['1'], { matchup: 'BUF @ KC', homeMoney: 55, homeBets: 38, overMoney: 70, overBets: 66 });
});

test('simple list: team, bets %, money % (no header)', () => {
  const r = P(`NYJ 30% 41%
Dolphins 70% 59%`);
  assert.deepStrictEqual(r['3'], { matchup: 'NYJ @ MIA', homeBets: 70, homeMoney: 59 });
});

test('ignores teams not playing and junk', () => {
  assert.deepStrictEqual(P('Cowboys 80% 20%\nhello 50%'), {});
});
