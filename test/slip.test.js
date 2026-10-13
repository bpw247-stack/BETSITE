'use strict';
const test = require('node:test');
const assert = require('node:assert');
global.window = global.window || {};
require('../public/teams.js');
const LEAGUES = global.window.LEAGUES;
const { parseSlip, slipToBet } = require('../public/slip.js');
const P = (t) => parseSlip(t, LEAGUES);

test('straight spread bet (DraftKings-style)', () => {
  const p = P(`DraftKings Sportsbook
Kansas City Chiefs -3.5
-110
Buffalo Bills @ Kansas City Chiefs
Sun, Oct 19, 2026 4:25 PM
Wager: $55.00
To Win: $50.00`);
  assert.strictEqual(p.book, 'DraftKings');
  assert.strictEqual(p.betType, 'Spread');
  assert.deepStrictEqual([p.legs[0].team, p.legs[0].line, p.legs[0].opponent], ['KC', -3.5, 'BUF']);
  assert.strictEqual(p.odds, -110);
  assert.strictEqual(p.stake, 55);
  assert.strictEqual(p.toWin, 50);
  assert.strictEqual(p.date, '2026-10-19');
  const bet = slipToBet(p);
  assert.deepStrictEqual([bet.sport, bet.betType, bet.team, bet.opponent, bet.line, bet.odds, bet.stake, bet.book], ['NFL', 'Spread', 'KC', 'BUF', -3.5, -110, 55, 'DraftKings']);
});

test('player prop with unicode minus and payout instead of to-win (FanDuel-style)', () => {
  const p = P(`FanDuel
Josh Allen Over 250.5 Passing Yards
Buffalo Bills @ Kansas City Chiefs
−115
Stake $23.00
Potential Payout $43.00`);
  assert.strictEqual(p.book, 'FanDuel');
  const l = p.legs[0];
  assert.deepStrictEqual([l.betType, l.player, l.propCategory, l.side, l.line, l.odds], ['Player Prop', 'Josh Allen', 'Passing Yards', 'Over', 250.5, -115]);
  assert.strictEqual(p.toWin, 20);
  assert.ok(p.warnings.some((w) => /player's team/.test(w)));
});

test('same game parlay with mixed legs', () => {
  const p = P(`BetMGM
3 Leg Same Game Parlay +595
Kansas City Chiefs Moneyline
Travis Kelce Anytime Touchdown Scorer
Over 47.5 Total Points
Buffalo Bills @ Kansas City Chiefs
Bet amount: $10.00
To win $59.50`);
  assert.strictEqual(p.betType, 'Parlay');
  assert.strictEqual(p.odds, 595);
  assert.strictEqual(p.legs.length, 3);
  assert.deepStrictEqual([p.legs[0].betType, p.legs[0].team], ['Moneyline', 'KC']);
  assert.deepStrictEqual([p.legs[1].betType, p.legs[1].player, p.legs[1].propCategory, p.legs[1].side], ['Player Prop', 'Travis Kelce', 'Anytime TD', 'Yes']);
  assert.deepStrictEqual([p.legs[2].betType, p.legs[2].side, p.legs[2].line, p.legs[2].team, p.legs[2].opponent], ['Total', 'Over', 47.5, 'BUF', 'KC']);
  const bet = slipToBet(p);
  assert.strictEqual(bet.betType, 'Parlay');
  assert.strictEqual(bet.legs.length, 3);
});

test('NBA alt-line prop and odds computed from stake/to-win', () => {
  const p = P(`Jayson Tatum 25+ Points
Boston Celtics vs New York Knicks
Wager $20.00
To Win $30.00`);
  const l = p.legs[0];
  assert.deepStrictEqual([l.sport, l.propCategory, l.side, l.line], ['NBA', 'Points', 'Over', 24.5]);
  assert.strictEqual(p.odds, 150);
});

test('garbage text produces warnings, not crashes', () => {
  const p = P('hello there\nnothing to see');
  assert.strictEqual(p.legs.length, 0);
  assert.ok(p.warnings.length >= 2);
});

test('screenshot layout: player name on its own line above the selection (FanDuel-style)', () => {
  const p = P(`FanDuel My Bets
Josh Allen +105
Over 249.5 Passing Yards
Buffalo Bills @ Kansas City Chiefs
Total Wager $20.00
Potential Payout $41.00`);
  assert.strictEqual(p.betType, 'Player Prop');
  const l = p.legs[0];
  assert.deepStrictEqual([l.player, l.propCategory, l.side, l.line, l.odds, l.game], ['Josh Allen', 'Passing Yards', 'Over', 249.5, 105, 'BUF @ KC']);
  assert.strictEqual(p.stake, 20);
  assert.strictEqual(p.toWin, 21);
});

test('screenshot layout: prop name wrapped onto two lines, over/under on the next (BetMGM-style)', () => {
  const p = P(`BetMGM Straight
Nikola Jokic - Points + Rebounds +
Assists
Under 48.5 -115
Denver Nuggets at Boston Celtics
Stake $46.00
Potential winnings $40.00`);
  assert.strictEqual(p.book, 'BetMGM');
  assert.strictEqual(p.betType, 'Player Prop');
  assert.strictEqual(p.legs.length, 1);
  const l = p.legs[0];
  assert.deepStrictEqual([l.player, l.propCategory, l.side, l.line, l.odds, l.sport], ['Nikola Jokic', 'Pts + Reb + Ast', 'Under', 48.5, -115, 'NBA']);
});
